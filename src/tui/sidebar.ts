import { ServerMetrics } from '../core/metrics.js';
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

export class SidebarRenderer {
  public static render(metrics: ServerMetrics | undefined, width: number, height: number, theme: SidebarTheme = defaultSidebarTheme): string[] {
    const lines: string[] = [];
    const innerW = Math.max(8, width - 4);
    const borderFillW = innerW + 2;

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

    const row = (content: string) => {
      const clipped = padClip(content, innerW);
      return `${theme.border}│${theme.reset} ${clipped} ${theme.border}│${theme.reset}`;
    };

    // 1. Top border
    const topBar = padClip('✦ sshx monitor [F2]', innerW);
    lines.push(`${theme.border}┌${'─'.repeat(borderFillW)}┐${theme.reset}`);
    lines.push(row(`${theme.header}${topBar}${theme.reset}`));

    if (!metrics) {
      lines.push(hr());
      lines.push(row(`${theme.muted}Connecting to server...${theme.reset}`));
      lines.push(row(`${theme.muted}Gathering metrics...${theme.reset}`));
      while (lines.length < height - 1) {
        lines.push(row(''));
      }
      lines.push(`${theme.border}└${'─'.repeat(borderFillW)}┘${theme.reset}`);
      return lines;
    }

    // 2. System Section
    lines.push(hr('📌 SYSTEM'));
    lines.push(row(`${theme.label}User:${theme.reset} ${theme.value}${metrics.user}${theme.reset} @ ${theme.value}${metrics.hostname}${theme.reset}`));
    if (metrics.ip) {
      lines.push(row(`${theme.label}IP:  ${theme.reset} ${theme.value}${metrics.ip}${theme.reset}`));
    }
    lines.push(row(`${theme.label}OS:  ${theme.reset} ${theme.value}${metrics.os}${theme.reset}`));
    if (metrics.uptime) {
      lines.push(row(`${theme.label}Up:  ${theme.reset} ${theme.value}${metrics.uptime}${theme.reset}`));
    }

    // 3. CPU Section
    lines.push(hr('⚡ CPU'));
    const cpuModelClean = metrics.cpu.model.replace(/\(R\)|\(TM\)|Processor/g, '').trim();
    lines.push(row(`${theme.value}${cpuModelClean} (${metrics.cpu.cores}C)${theme.reset}`));
    const cpuBar = renderProgressBar(metrics.cpu.usagePercent, innerW - 10, theme);
    lines.push(row(`${cpuBar} ${theme.value}${metrics.cpu.usagePercent.toFixed(1)}%${theme.reset}`));
    if (metrics.cpu.load) {
      lines.push(row(`${theme.label}Load:${theme.reset} ${theme.muted}${metrics.cpu.load}${theme.reset}`));
    }

    // 4. Memory Section
    lines.push(hr('🧠 MEMORY'));
    const memUsedGb = (metrics.memory.usedMB / 1024).toFixed(1);
    const memTotalGb = (metrics.memory.totalMB / 1024).toFixed(1);
    const memBar = renderProgressBar(metrics.memory.percent, innerW - 10, theme);
    lines.push(row(`${memBar} ${theme.value}${metrics.memory.percent.toFixed(0)}%${theme.reset}`));
    lines.push(row(`${theme.label}Used:${theme.reset} ${theme.value}${memUsedGb}G / ${memTotalGb}G${theme.reset}`));

    // 5. Disk Section
    lines.push(hr('💾 DISK (/)'));
    const diskBar = renderProgressBar(metrics.disk.percent, innerW - 10, theme);
    lines.push(row(`${diskBar} ${theme.value}${metrics.disk.percent}%${theme.reset}`));
    lines.push(row(`${theme.label}Size:${theme.reset} ${theme.value}${metrics.disk.used} / ${metrics.disk.total}${theme.reset}`));

    // 6. Network Section
    lines.push(hr('🌐 NETWORK'));
    lines.push(row(`${theme.label}↓ RX:${theme.reset} ${theme.value}${metrics.network.rxFormatted}${theme.reset}   ${theme.label}↑ TX:${theme.reset} ${theme.value}${metrics.network.txFormatted}${theme.reset}`));

    // 7. GPU Section (if available)
    if (metrics.gpu && height >= 28) {
      lines.push(hr('🎮 GPU'));
      lines.push(row(`${theme.value}${metrics.gpu.model}${theme.reset} ${theme.muted}(${metrics.gpu.temp}°C)${theme.reset}`));
      const gpuBar = renderProgressBar(metrics.gpu.utilPercent, innerW - 10, theme);
      lines.push(row(`${gpuBar} ${theme.value}${metrics.gpu.utilPercent}%${theme.reset}`));
      const vramUsedGb = (metrics.gpu.vramUsedMB / 1024).toFixed(1);
      const vramTotalGb = (metrics.gpu.vramTotalMB / 1024).toFixed(1);
      lines.push(row(`${theme.label}VRAM:${theme.reset} ${theme.value}${vramUsedGb}G / ${vramTotalGb}G (${metrics.gpu.vramPercent}%)${theme.reset}`));
    }

    // Pad remaining rows
    while (lines.length < height - 1) {
      lines.push(row(''));
    }

    // Bottom border
    lines.push(`${theme.border}└${'─'.repeat(borderFillW)}┘${theme.reset}`);

    return lines.slice(0, height);
  }
}

function renderProgressBar(percent: number, totalSlots: number, theme: SidebarTheme): string {
  const width = Math.max(5, Math.min(22, totalSlots));
  const clamped = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = width - filledCount;

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
