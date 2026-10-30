import EventEmitter from 'node:events';
import { Client } from 'ssh2';
import { execCommand } from './exec.js';

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
  };
  memory: {
    totalMB: number;
    usedMB: number;
    percent: number;
  };
  disk: {
    mount: string;
    total: string;
    used: string;
    avail: string;
    percent: number;
  };
  network: {
    rxFormatted: string;
    txFormatted: string;
    rxBytesSec: number;
    txBytesSec: number;
  };
  gpu?: {
    model: string;
    temp: number;
    utilPercent: number;
    vramUsedMB: number;
    vramTotalMB: number;
    vramPercent: number;
  };
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
  private lastNetRx = 0;
  private lastNetTx = 0;
  private cachedMetrics?: ServerMetrics;

  private static COLLECTOR_SCRIPT = `
U=$(whoami 2>/dev/null || echo "$USER")
H=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "localhost")
OS=$(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"' || uname -s)
UP=$(uptime 2>/dev/null | sed -e 's/.*up //' -e 's/,.*//')
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || echo "")
LOAD=$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || uptime | sed 's/.*load average: //')
CPUM=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed -e 's/^[ \t]*//' || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "CPU")
CPUC=$(grep -c "^processor" /proc/cpuinfo 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo "1")
CPUSTAT=$(grep '^cpu ' /proc/stat 2>/dev/null || echo "")

if [ -f /proc/meminfo ]; then
  MT=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  MA=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  [ -z "$MA" ] && MA=$(awk '/MemFree/ {print int($2/1024)}' /proc/meminfo)
  MU=$((MT - MA))
else
  MT=0; MU=0
fi

DISK=$(df -h / 2>/dev/null | awk 'NR==2 {print $2, $3, $4, $5}')
NET=$(awk 'NR>2 && !/lo:/ {rx+=$2; tx+=$10} END {print rx, tx}' /proc/net/dev 2>/dev/null)

if command -v nvidia-smi >/dev/null 2>&1; then
  GPU=$(nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n1)
else
  GPU=""
fi

printf "USER=%s\nHOST=%s\nOS=%s\nUP=%s\nIP=%s\nLOAD=%s\nCPUM=%s\nCPUC=%s\nCPUSTAT=%s\nMT=%s\nMU=%s\nDISK=%s\nNET=%s\nGPU=%s\n" \
  "$U" "$H" "$OS" "$UP" "$IP" "$LOAD" "$CPUM" "$CPUC" "$CPUSTAT" "$MT" "$MU" "$DISK" "$NET" "$GPU"
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
          const deltaTotal = total - this.lastCpuTotal;
          const deltaIdle = idle - this.lastCpuIdle;
          cpuUsagePercent = Math.max(0, Math.min(100, Math.round((1 - deltaIdle / deltaTotal) * 1000) / 10));
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

    // Parse Memory
    const mt = Number(map.get('MT')) || 0;
    const mu = Number(map.get('MU')) || 0;
    const memPercent = mt > 0 ? Math.round((mu / mt) * 1000) / 10 : 0;

    // Parse Disk
    const diskRaw = (map.get('DISK') || '').split(/\s+/);
    const diskTotal = diskRaw[0] || 'N/A';
    const diskUsed = diskRaw[1] || 'N/A';
    const diskAvail = diskRaw[2] || 'N/A';
    const diskPercentStr = diskRaw[3] || '0%';
    const diskPercent = parseInt(diskPercentStr, 10) || 0;

    // Parse Network
    let rxBytesSec = 0;
    let txBytesSec = 0;
    const netRaw = (map.get('NET') || '').split(/\s+/);
    if (netRaw.length >= 2) {
      const rx = Number(netRaw[0]) || 0;
      const tx = Number(netRaw[1]) || 0;
      if (this.lastNetRx > 0 && dt > 0) {
        rxBytesSec = Math.max(0, Math.round((rx - this.lastNetRx) / dt));
        txBytesSec = Math.max(0, Math.round((tx - this.lastNetTx) / dt));
      }
      this.lastNetRx = rx;
      this.lastNetTx = tx;
    }

    // Parse GPU
    let gpu: ServerMetrics['gpu'] | undefined;
    const gpuRaw = map.get('GPU');
    if (gpuRaw && gpuRaw.trim()) {
      const gParts = gpuRaw.split(',').map(s => s.trim());
      if (gParts.length >= 5) {
        const vramUsed = Number(gParts[1]) || 0;
        const vramTotal = Number(gParts[2]) || 0;
        gpu = {
          model: gParts[0] || 'NVIDIA GPU',
          vramUsedMB: vramUsed,
          vramTotalMB: vramTotal,
          vramPercent: vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0,
          utilPercent: Number(gParts[3]) || 0,
          temp: Number(gParts[4]) || 0
        };
      }
    }

    return {
      user: map.get('USER') || 'unknown',
      hostname: map.get('HOST') || 'localhost',
      ip: map.get('IP') || '',
      os: map.get('OS') || 'Linux',
      uptime: map.get('UP') || '',
      cpu: {
        model: map.get('CPUM') || 'CPU',
        cores: Number(map.get('CPUC')) || 1,
        load: map.get('LOAD') || '',
        usagePercent: cpuUsagePercent
      },
      memory: {
        totalMB: mt,
        usedMB: mu,
        percent: memPercent
      },
      disk: {
        mount: '/',
        total: diskTotal,
        used: diskUsed,
        avail: diskAvail,
        percent: diskPercent
      },
      network: {
        rxBytesSec,
        txBytesSec,
        rxFormatted: formatSpeed(rxBytesSec),
        txFormatted: formatSpeed(txBytesSec)
      },
      gpu,
      updatedAt: now
    };
  }
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
