import EventEmitter from 'node:events';
import { Client } from 'ssh2';
import { execCommand } from './exec.js';

export interface CpuSocket {
  id: number;
  threads: number;
  usagePercent: number;
}

export interface DiskInfo {
  mount: string;
  total: string;
  used: string;
  avail: string;
  percent: number;
}

export interface NetworkInfo {
  name: string;
  ip?: string;
  state?: string;
  rxFormatted: string;
  txFormatted: string;
  rxBytesSec: number;
  txBytesSec: number;
}

export interface GpuInfo {
  index: number;
  model: string;
  temp: number;
  utilPercent: number;
  vramUsedMB: number;
  vramTotalMB: number;
  vramPercent: number;
}

export interface ServerMetrics {
  user: string;
  hostname: string;
  ip: string;
  os: string;
  uptime: string;
  cpu: {
    model: string;
    cores: number;
    load: string;
    usagePercent: number;
    /** Per physical package; only meaningful when there is more than one */
    sockets?: CpuSocket[];
  };
  memory: {
    totalMB: number;
    usedMB: number;
    percent: number;
  };
  /** Root (or first) filesystem, kept for single-disk consumers */
  disk: DiskInfo;
  disks?: DiskInfo[];
  /** Combined throughput of all listed interfaces */
  network: {
    rxFormatted: string;
    txFormatted: string;
    rxBytesSec: number;
    txBytesSec: number;
  };
  networks?: NetworkInfo[];
  /** First GPU, kept for single-GPU consumers */
  gpu?: GpuInfo;
  gpus?: GpuInfo[];
  updatedAt: number;
}

export class MetricsCollector extends EventEmitter {
  private client: Client;
  private intervalMs: number;
  private timer?: NodeJS.Timeout;
  private isCollecting = false;
  private lastSampleTime = 0;
  private lastCpuTotal = 0;
  private lastCpuIdle = 0;
  private lastSocketStat = new Map<number, { total: number; idle: number }>();
  private lastNetStat = new Map<string, { rx: number; tx: number }>();
  private cachedMetrics?: ServerMetrics;

  // Multi-value lines use ';' between entries and '|' between fields.
  private static COLLECTOR_SCRIPT = String.raw`
U=$(whoami 2>/dev/null || echo "$USER")
H=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "localhost")
OS=$(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || uname -s)
UP=$(uptime 2>/dev/null | sed -e 's/.*up //' -e 's/,.*//')
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || echo "")
LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || uptime | sed 's/.*load average: //')
CPUM=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed -e 's/^[ \t]*//' || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "CPU")
CPUC=$(grep -c "^processor" /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "1")
CPUSTAT=$(grep '^cpu ' /proc/stat 2>/dev/null || echo "")
CPUSOCK=$(awk 'FILENAME == "/proc/stat" { if ($1 ~ /^cpu[0-9]/) { c = substr($1, 4); p = (c in pkg) ? pkg[c] : 0; n[p]++; idle[p] += $5 + $6; for (i = 2; i <= NF; i++) tot[p] += $i } next } { split(FILENAME, a, "/"); pkg[substr(a[6], 4)] = $1 } END { for (p in tot) printf "%s|%d|%.0f|%.0f;", p, n[p], tot[p], idle[p] }' /sys/devices/system/cpu/cpu[0-9]*/topology/physical_package_id /proc/stat 2>/dev/null)

if [ -f /proc/meminfo ]; then
  MT=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  MA=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  [ -z "$MA" ] && MA=$(awk '/MemFree/ {print int($2/1024)}' /proc/meminfo)
  MU=$((MT - MA))
else
  MT=0; MU=0
fi

DISKS=$(LC_ALL=C df -P -k 2>/dev/null | awk 'NR > 1 && $2 + 0 > 0 { d = $1; m = $6; for (i = 7; i <= NF; i++) m = m " " $i; if (d !~ /[\/:]/ || d ~ /^\/dev\/loop/ || (d in seen)) next; if (m ~ /^\/(boot|snap)(\/|$)/ || m ~ /^\/var\/lib\/(docker|kubelet|containers)\// || m ~ /^\/(System\/Volumes|private\/var\/vm)\//) next; seen[d] = 1; printf "%s|%.0f|%.0f|%.0f;", m, $2, $3, $4 }')

NETIP=$(ip -o addr show 2>/dev/null | awk '{ n = $2; sub(/@.*/, "", n); split($4, a, "/"); if ($3 == "inet" && !(n in v4)) v4[n] = a[1]; else if ($3 == "inet6" && a[1] !~ /^fe80/ && !(n in v6)) v6[n] = a[1] } END { for (n in v4) printf "%s=%s ", n, v4[n]; for (n in v6) if (!(n in v4)) printf "%s=%s ", n, v6[n] }')
NETS=$(awk -v ips="$NETIP" 'BEGIN { c = split(ips, arr, " "); for (i = 1; i <= c; i++) { split(arr[i], kv, "="); ip[kv[1]] = kv[2] } } NR > 2 { s = $0; sub(/^[ \t]+/, "", s); n = s; sub(/:.*/, "", n); sub(/^[^:]*:/, "", s); split(s, f, " "); if (n ~ /^(lo|veth|docker|br-|virbr|vnet|cni|flannel|cali|kube-|tunl|dummy|ifb|lxc|podman)/) next; st = "unknown"; fn = "/sys/class/net/" n "/operstate"; if ((getline v < fn) > 0) st = v; close(fn); printf "%s|%.0f|%.0f|%s|%s;", n, f[1], f[9], ip[n], st }' /proc/net/dev 2>/dev/null)

if command -v nvidia-smi >/dev/null 2>&1; then
  GPUS=$(nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | tr '\n' ';')
else
  GPUS=""
fi

printf "USER=%s\nHOST=%s\nOS=%s\nUP=%s\nIP=%s\nLOAD=%s\nCPUM=%s\nCPUC=%s\nCPUSTAT=%s\nCPUSOCK=%s\nMT=%s\nMU=%s\nDISKS=%s\nNETS=%s\nGPUS=%s\n" \
  "$U" "$H" "$OS" "$UP" "$IP" "$LOAD" "$CPUM" "$CPUC" "$CPUSTAT" "$CPUSOCK" "$MT" "$MU" "$DISKS" "$NETS" "$GPUS"
`.trim();

  constructor(client: Client, intervalMs = 2500) {
    super();
    this.client = client;
    this.intervalMs = intervalMs;
  }

  public getLatest(): ServerMetrics | undefined {
    return this.cachedMetrics;
  }

  public start(): void {
    if (this.timer) return;
    this.poll(); // first poll immediately
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    if (this.isCollecting) return;
    this.isCollecting = true;

    try {
      const res = await execCommand(this.client, MetricsCollector.COLLECTOR_SCRIPT, { timeout: 4000 });
      if (res.exitCode === 0) {
        const metrics = this.parseOutput(res.stdout);
        this.cachedMetrics = metrics;
        this.emit('update', metrics);
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.isCollecting = false;
    }
  }

  public parseOutput(stdout: string): ServerMetrics {
    const lines = stdout.split('\n');
    const map = new Map<string, string>();
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
      }
    }

    const now = Date.now();
    const dt = this.lastSampleTime > 0 ? (now - this.lastSampleTime) / 1000 : 0;
    this.lastSampleTime = now;

    // Parse CPU %
    let cpuUsagePercent = 0;
    const cpuStat = map.get('CPUSTAT') || '';
    if (cpuStat.startsWith('cpu')) {
      const parts = cpuStat.trim().split(/\s+/).slice(1).map(Number);
      if (parts.length >= 4) {
        const idle = parts[3] + (parts[4] || 0); // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);

        if (this.lastCpuTotal > 0 && total > this.lastCpuTotal) {
          cpuUsagePercent = usageBetween(total - this.lastCpuTotal, idle - this.lastCpuIdle);
        } else {
          // Fallback to load average calculation
          const loadParts = (map.get('LOAD') || '').split(/\s+/).map(Number);
          const cores = Number(map.get('CPUC')) || 1;
          if (loadParts[0] !== undefined) {
            cpuUsagePercent = Math.min(100, Math.round((loadParts[0] / cores) * 1000) / 10);
          }
        }
        this.lastCpuTotal = total;
        this.lastCpuIdle = idle;
      }
    }

    // Parse per-socket CPU: id|threads|total|idle
    const sockets: CpuSocket[] = [];
    for (const [idStr, threadsStr, totalStr, idleStr] of splitEntries(map.get('CPUSOCK'))) {
      const id = Number(idStr);
      const total = Number(totalStr) || 0;
      const idle = Number(idleStr) || 0;
      const prev = this.lastSocketStat.get(id);
      const usagePercent = prev && total > prev.total ? usageBetween(total - prev.total, idle - prev.idle) : 0;
      this.lastSocketStat.set(id, { total, idle });
      sockets.push({ id, threads: Number(threadsStr) || 0, usagePercent });
    }
    sockets.sort((a, b) => a.id - b.id);

    // Parse Memory
    const mt = Number(map.get('MT')) || 0;
    const mu = Number(map.get('MU')) || 0;
    const memPercent = mt > 0 ? Math.round((mu / mt) * 1000) / 10 : 0;

    // Parse Disks: mount|totalKB|usedKB|availKB
    const disks: DiskInfo[] = splitEntries(map.get('DISKS')).map(([mount, totalStr, usedStr, availStr]) => {
      const total = Number(totalStr) || 0;
      const used = Number(usedStr) || 0;
      const avail = Number(availStr) || 0;
      return {
        mount,
        total: formatKB(total),
        used: formatKB(used),
        avail: formatKB(avail),
        // Same rounding df uses for Use%
        percent: used + avail > 0 ? Math.ceil((used * 100) / (used + avail)) : 0,
        sizeKB: total
      };
    })
      // Root first, then the larger volumes
      .sort((a, b) => Number(b.mount === '/') - Number(a.mount === '/') || b.sizeKB - a.sizeKB)
      .map(({ sizeKB: _sizeKB, ...disk }) => disk);

    // Parse Network interfaces: name|rxBytes|txBytes|ip|operstate
    const networks: NetworkInfo[] = [];
    const seenNics = new Set<string>();
    for (const [name, rxStr, txStr, ip, state] of splitEntries(map.get('NETS'))) {
      const rx = Number(rxStr) || 0;
      const tx = Number(txStr) || 0;
      const prev = this.lastNetStat.get(name);
      this.lastNetStat.set(name, { rx, tx });
      seenNics.add(name);

      // Interfaces that are down and unaddressed are just noise
      if (!ip && state !== 'up' && state !== 'unknown') continue;

      let rxBytesSec = 0;
      let txBytesSec = 0;
      if (prev && dt > 0) {
        rxBytesSec = Math.max(0, Math.round((rx - prev.rx) / dt));
        txBytesSec = Math.max(0, Math.round((tx - prev.tx) / dt));
      }
      networks.push({
        name,
        ip: ip || undefined,
        state,
        rxBytesSec,
        txBytesSec,
        rxFormatted: formatSpeed(rxBytesSec),
        txFormatted: formatSpeed(txBytesSec)
      });
    }
    for (const name of this.lastNetStat.keys()) {
      if (!seenNics.has(name)) this.lastNetStat.delete(name);
    }
    // Addressed interfaces first, keeping kernel order otherwise
    networks.sort((a, b) => Number(Boolean(b.ip)) - Number(Boolean(a.ip)));
    const rxBytesSec = networks.reduce((sum, n) => sum + n.rxBytesSec, 0);
    const txBytesSec = networks.reduce((sum, n) => sum + n.txBytesSec, 0);

    // Parse GPUs: index, name, memory.used, memory.total, utilization.gpu, temperature.gpu
    const gpus: GpuInfo[] = [];
    for (const entry of (map.get('GPUS') || '').split(';')) {
      const gParts = entry.split(',').map(s => s.trim());
      if (gParts.length < 6) continue;
      const [utilStr, tempStr] = gParts.slice(-2);
      const [vramUsedStr, vramTotalStr] = gParts.slice(-4, -2);
      const vramUsed = Number(vramUsedStr) || 0;
      const vramTotal = Number(vramTotalStr) || 0;
      const index = parseInt(gParts[0], 10);
      gpus.push({
        index: Number.isNaN(index) ? gpus.length : index,
        model: gParts.slice(1, -4).join(',') || 'NVIDIA GPU',
        vramUsedMB: vramUsed,
        vramTotalMB: vramTotal,
        vramPercent: vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0,
        utilPercent: Number(utilStr) || 0,
        temp: Number(tempStr) || 0
      });
    }

    return {
      user: map.get('USER') || 'unknown',
      hostname: map.get('HOST') || 'localhost',
      ip: map.get('IP') || networks.find(n => n.ip)?.ip || '',
      os: map.get('OS') || 'Linux',
      uptime: map.get('UP') || '',
      cpu: {
        model: map.get('CPUM') || 'CPU',
        cores: Number(map.get('CPUC')) || 1,
        load: map.get('LOAD') || '',
        usagePercent: cpuUsagePercent,
        sockets
      },
      memory: {
        totalMB: mt,
        usedMB: mu,
        percent: memPercent
      },
      disk: disks[0] || { mount: '/', total: 'N/A', used: 'N/A', avail: 'N/A', percent: 0 },
      disks,
      network: {
        rxBytesSec,
        txBytesSec,
        rxFormatted: formatSpeed(rxBytesSec),
        txFormatted: formatSpeed(txBytesSec)
      },
      networks,
      gpu: gpus[0],
      gpus,
      updatedAt: now
    };
  }
}

function splitEntries(raw: string | undefined): string[][] {
  return (raw || '')
    .split(';')
    .filter(entry => entry.trim())
    .map(entry => entry.split('|').map(s => s.trim()));
}

function usageBetween(deltaTotal: number, deltaIdle: number): number {
  if (deltaTotal <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 1000) / 10));
}

function formatKB(kb: number): string {
  const units = ['K', 'M', 'G', 'T', 'P'];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
