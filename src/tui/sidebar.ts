import { DiskInfo, GpuInfo, NetworkInfo, ServerMetrics } from '../core/metrics.js';
import { padClip, stringWidth } from './screen.js';

export interface SidebarTheme {
  border: string;
  header: string;
  title: string;
  label: string;
  value: string;
  barBg: string;
  barGood: string;
  barWarn: string;
  barCrit: string;
  muted: string;
  reset: string;
}

export const defaultSidebarTheme: SidebarTheme = {
  border: '\x1b[38;5;239m', // dark gray
  header: '\x1b[1;38;5;81m', // bright cyan bold
  title: '\x1b[1;38;5;141m', // lavender bold
  label: '\x1b[38;5;246m', // light slate
  value: '\x1b[38;5;253m', // crisp white
  barBg: '\x1b[38;5;238m', // dark bar background
  barGood: '\x1b[38;5;44m', // cyan
  barWarn: '\x1b[38;5;214m', // orange
  barCrit: '\x1b[38;5;197m', // rose red
  muted: '\x1b[38;5;243m',
  reset: '\x1b[0m'
};

interface Section {
  title: string;
  /** Candidate bodies, richest first; the layout falls back to leaner ones when rows run short */
  variants: string[][];
  /** Variants from this index on hide items, so they are used only after every section is compact */
  lossyFrom?: number;
}

/** Row builders shared by all sections, bound to one sidebar width and theme */
class Rows {
  constructor(private innerW: number, public readonly t: SidebarTheme) {}

  public row(content: string): string {
    const clipped = padClip(content, this.innerW);
    return `${this.t.border}│${this.t.reset} ${clipped}${this.t.reset} ${this.t.border}│${this.t.reset}`;
  }

  public kv(label: string, value: string): string {
    return this.row(`${this.t.label}${padClip(`${label}:`, 5)}${this.t.reset} ${this.t.value}${value}${this.t.reset}`);
  }

  public muted(text: string): string {
    return this.row(`${this.t.muted}${text}${this.t.reset}`);
  }

  /** Text on the left, muted detail flush against the right edge */
  public spread(left: string, right: string): string {
    if (!right) return this.row(`${this.t.value}${left}${this.t.reset}`);
    const rightW = Math.min(stringWidth(right), this.innerW - 2);
    const leftW = this.innerW - rightW - 1;
    return this.row(`${this.t.value}${padClip(left, leftW)}${this.t.reset} ${this.t.muted}${padClip(right, rightW)}${this.t.reset}`);
  }

  /** "label ████░░░░ value" with the bar stretched over whatever the label and value leave */
  public meter(label: string, labelW: number, percent: number, value: string, valueW = 4): string {
    const head = labelW > 0 ? `${this.t.label}${padClip(label, labelW)}${this.t.reset} ` : '';
    const barW = this.innerW - (labelW > 0 ? labelW + 1 : 0) - valueW - 1;
    return this.row(`${head}${renderProgressBar(percent, barW, this.t)} ${this.t.value}${padLeft(value, valueW)}${this.t.reset}`);
  }
}

export class SidebarRenderer {
  public static render(metrics: ServerMetrics | undefined, width: number, height: number, theme: SidebarTheme = defaultSidebarTheme): string[] {
    const lines: string[] = [];
    const innerW = Math.max(8, width - 4);
    const borderFillW = innerW + 2;
    const rows = new Rows(innerW, theme);

    const hr = (title?: string) => {
      if (!title) {
        return `${theme.border}├${'─'.repeat(borderFillW)}┤${theme.reset}`;
      }
      const titleClean = ` ${title} `;
      const titleLen = stringWidth(titleClean);
      if (titleLen >= borderFillW) {
        const clipped = padClip(titleClean, borderFillW);
        return `${theme.border}├${theme.title}${clipped}${theme.border}┤${theme.reset}`;
      }
      const remaining = borderFillW - titleLen;
      const left = Math.min(1, remaining);
      const right = remaining - left;
      return `${theme.border}├${'─'.repeat(left)}${theme.title}${titleClean}${theme.border}${'─'.repeat(right)}┤${theme.reset}`;
    };

    // 1. Top border
    const topBar = padClip('✦ sshx monitor [F2]', innerW);
    lines.push(`${theme.border}┌${'─'.repeat(borderFillW)}┐${theme.reset}`);
    lines.push(rows.row(`${theme.header}${topBar}${theme.reset}`));

    if (!metrics) {
      lines.push(hr());
      lines.push(rows.muted('Connecting to server...'));
      lines.push(rows.muted('Gathering metrics...'));
      while (lines.length < height - 1) {
        lines.push(rows.row(''));
      }
      lines.push(`${theme.border}└${'─'.repeat(borderFillW)}┘${theme.reset}`);
      return lines;
    }

    const sections = [
      systemSection(metrics, rows),
      cpuSection(metrics, rows),
      memorySection(metrics, rows),
      diskSection(metrics, rows),
      networkSection(metrics, rows),
      gpuSection(metrics, rows, innerW)
    ].filter((s): s is Section => s !== undefined);

    // Top border, header and bottom border are fixed
    const budget = Math.max(0, height - 3);
    const chosen = fitSections(sections, budget);
    sections.forEach((section, i) => {
      lines.push(hr(section.title), ...section.variants[chosen[i]]);
    });
    lines.length = Math.min(lines.length, 2 + budget);

    // Pad remaining rows
    while (lines.length < height - 1) {
      lines.push(rows.row(''));
    }

    // Bottom border
    lines.push(`${theme.border}└${'─'.repeat(borderFillW)}┘${theme.reset}`);

    return lines.slice(0, height);
  }
}

/**
 * Pick one variant per section so the whole stack fits in `budget` rows.
 * Repeatedly slims down the bulkiest section that still has a leaner variant;
 * ties go to the later section, so system/CPU details are the last to shrink.
 * Variants that hide list items are only reached once nothing else can shrink.
 */
function fitSections(sections: Section[], budget: number): number[] {
  const chosen = sections.map(() => 0);
  const size = (i: number) => 1 + sections[i].variants[chosen[i]].length;
  let total = sections.reduce((sum, _s, i) => sum + size(i), 0);

  for (const allowLossy of [false, true]) {
    const limit = (s: Section) => (allowLossy ? s.variants.length : s.lossyFrom ?? s.variants.length);
    while (total > budget) {
      let target = -1;
      for (let i = 0; i < sections.length; i++) {
        if (chosen[i] < limit(sections[i]) - 1 && (target < 0 || size(i) >= size(target))) {
          target = i;
        }
      }
      if (target < 0) break;
      total -= size(target);
      chosen[target]++;
      total += size(target);
    }
  }
  return chosen;
}

/**
 * Section for a list of items: each detailed renderer applied to every item,
 * then one compact row per item, then the compact rows cut down with a "+N more" tail.
 */
function listSection<T>(rows: Rows, title: string, items: T[], detailed: Array<(item: T) => string[]>, compact: (item: T) => string): Section {
  const variants = detailed.map(render => items.flatMap(render));
  const compactRows = items.map(compact);
  variants.push(compactRows);
  const lossyFrom = variants.length;
  for (let keep = items.length - 2; keep >= 1; keep--) {
    variants.push([...compactRows.slice(0, keep), rows.muted(`… +${items.length - keep} more`)]);
  }
  return { title, variants, lossyFrom };
}

function systemSection(m: ServerMetrics, rows: Rows): Section {
  const full = [rows.kv('User', `${m.user} @ ${m.hostname}`)];
  if (m.ip) full.push(rows.kv('IP', m.ip));
  full.push(rows.kv('OS', m.os));
  if (m.uptime) full.push(rows.kv('Up', m.uptime));

  return {
    title: '📌 SYSTEM',
    variants: [
      full,
      [rows.kv('User', `${m.user} @ ${m.hostname}`), ...(m.ip ? [rows.kv('IP', m.ip)] : [])],
      [rows.spread(`${m.user}@${m.hostname}`, m.ip)]
    ]
  };
}

function cpuSection(m: ServerMetrics, rows: Rows): Section {
  const sockets = m.cpu.sockets && m.cpu.sockets.length > 1 ? m.cpu.sockets : [];
  const model = `${sockets.length ? `${sockets.length}× ` : ''}${cleanCpuModel(m.cpu.model)}`;
  const modelRow = rows.spread(model, '');
  const pct = formatPercent(m.cpu.usagePercent, 1);
  const total = rows.meter('', 0, m.cpu.usagePercent, pct, 5);

  const variants = [[modelRow, total]];
  if (sockets.length) {
    const labels = sockets.map(s => `CPU${s.id}`);
    const labelW = Math.max(3, ...labels.map(l => stringWidth(l)));
    const perSocket = sockets.map((s, i) => rows.meter(labels[i], labelW, s.usagePercent, formatPercent(s.usagePercent, 1), 5));
    const labelledTotal = rows.meter('ALL', labelW, m.cpu.usagePercent, pct, 5);
    variants.unshift([modelRow, labelledTotal, ...perSocket]);
  }
  if (m.cpu.load) {
    variants.unshift([...variants[0], rows.kv('Load', m.cpu.load)]);
  }
  variants.push([total]);

  return { title: `⚡ CPU · ${m.cpu.cores}C`, variants };
}

function memorySection(m: ServerMetrics, rows: Rows): Section {
  const usedGb = (m.memory.usedMB / 1024).toFixed(1);
  const totalGb = (m.memory.totalMB / 1024).toFixed(1);
  const bar = rows.meter('', 0, m.memory.percent, formatPercent(m.memory.percent));
  return {
    title: '🧠 MEMORY',
    variants: [[bar, rows.kv('Used', `${usedGb}G / ${totalGb}G`)], [bar]]
  };
}

function diskSection(m: ServerMetrics, rows: Rows): Section {
  const disks: DiskInfo[] = m.disks?.length ? m.disks : [m.disk];
  const labelW = Math.min(8, Math.max(...disks.map(d => stringWidth(d.mount))));

  return listSection(
    rows,
    disks.length > 1 ? `💾 DISK ×${disks.length}` : `💾 DISK (${disks[0].mount})`,
    disks,
    [d => [rows.spread(d.mount, `${d.used} / ${d.total}`), rows.meter('', 0, d.percent, formatPercent(d.percent))]],
    d => rows.meter(shortenPath(d.mount, labelW), labelW, d.percent, formatPercent(d.percent))
  );
}

function networkSection(m: ServerMetrics, rows: Rows): Section {
  const nets: NetworkInfo[] = m.networks?.length ? m.networks : [{ name: '', ...m.network }];
  const labelW = Math.min(8, Math.max(...nets.map(n => stringWidth(n.name))));
  const t = rows.t;

  const rates = (n: NetworkInfo) =>
    rows.row(` ${t.label}↓${t.reset} ${t.value}${padClip(n.rxFormatted, 12)}${t.reset}${t.label}↑${t.reset} ${t.value}${n.txFormatted}${t.reset}`);
  const compact = (n: NetworkInfo) =>
    rows.row(`${t.label}${padClip(n.name, labelW)}${t.reset} ${t.label}↓${t.reset}${t.value}${padLeft(formatShortSpeed(n.rxBytesSec), 5)}${t.reset} ${t.label}↑${t.reset}${t.value}${padLeft(formatShortSpeed(n.txBytesSec), 5)}${t.reset}`);

  return listSection(
    rows,
    nets.length > 1 ? `🌐 NETWORK ×${nets.length}` : '🌐 NETWORK',
    nets,
    [n => (n.name ? [rows.spread(n.name, n.ip || n.state || ''), rates(n)] : [rates(n)])],
    n => (n.name ? compact(n) : rates(n))
  );
}

function gpuSection(m: ServerMetrics, rows: Rows, innerW: number): Section | undefined {
  const gpus: GpuInfo[] = m.gpus?.length ? m.gpus : m.gpu ? [m.gpu] : [];
  if (!gpus.length) return undefined;

  const multi = gpus.length > 1;
  const name = (g: GpuInfo) => `${multi ? `#${g.index} ` : ''}${cleanGpuModel(g.model)}`;
  const vram = (g: GpuInfo) => `${formatGb(g.vramUsedMB)}/${formatGb(g.vramTotalMB)}G`;
  const header = (g: GpuInfo) => rows.spread(name(g), `${g.temp}°C ${vram(g)}`);
  const util = (g: GpuInfo) => rows.meter('UTIL', 4, g.utilPercent, formatPercent(g.utilPercent));

  // One-row form: "#0 ██████░░ 98% 22/24G"
  const indexW = Math.max(...gpus.map(g => stringWidth(`#${g.index}`)));
  const vramW = Math.max(...gpus.map(g => stringWidth(vram(g))));
  const compactValueW = Math.min(4 + 1 + vramW, innerW - indexW - 5);
  const compact = (g: GpuInfo) =>
    rows.meter(`#${g.index}`, indexW, g.utilPercent, `${padLeft(formatPercent(g.utilPercent), 4)} ${padLeft(vram(g), vramW)}`, compactValueW);

  return listSection(
    rows,
    multi ? `🎮 GPU ×${gpus.length}` : '🎮 GPU',
    gpus,
    [
      g => [header(g), util(g), rows.meter('VRAM', 4, g.vramPercent, formatPercent(g.vramPercent))],
      g => [header(g), util(g)]
    ],
    compact
  );
}

function cleanCpuModel(model: string): string {
  return model
    .replace(/\(R\)|\(TM\)|\bProcessor\b|\bCPU\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanGpuModel(model: string): string {
  return model.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').trim();
}

function formatPercent(percent: number, decimals = 0): string {
  return percent >= 100 ? '100%' : `${percent.toFixed(decimals)}%`;
}

function formatGb(mb: number): string {
  const gb = mb / 1024;
  if (gb === 0) return '0';
  return gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1);
}

function formatShortSpeed(bytesPerSec: number): string {
  const units = ['B', 'K', 'M', 'G'];
  let value = bytesPerSec;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

function padLeft(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - stringWidth(text))) + text;
}

/** Keep the tail of a long mount path: "/mnt/storage/backup" → "…/backup" */
function shortenPath(path: string, width: number): string {
  if (stringWidth(path) <= width) return path;
  const chars = Array.from(path);
  let tail = '';
  while (chars.length && stringWidth(chars[chars.length - 1] + tail) <= width - 1) {
    tail = chars.pop() + tail;
  }
  return `…${tail}`;
}

function renderProgressBar(percent: number, width: number, theme: SidebarTheme): string {
  const slots = Math.max(3, width);
  const clamped = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * slots);
  const emptyCount = slots - filledCount;

  let color = theme.barGood;
  if (clamped >= 85) {
    color = theme.barCrit;
  } else if (clamped >= 65) {
    color = theme.barWarn;
  }

  const filled = '█'.repeat(filledCount);
  const empty = '░'.repeat(emptyCount);

  return `${color}${filled}${theme.barBg}${empty}${theme.reset}`;
}
