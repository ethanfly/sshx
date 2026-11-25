import { colors } from '../cli/utils.js';
import { stringWidth } from '../core/text-width.js';

export { stripAnsi, charWidth, stringWidth, padClip } from '../core/text-width.js';

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export class ScreenBuffer {
  private buffer: string[] = [];
  public cols: number = 80;
  public rows: number = 24;

  constructor() {
    this.updateDimensions();
  }

  public updateDimensions(): TerminalDimensions {
    this.cols = process.stdout.columns || 80;
    this.rows = process.stdout.rows || 24;
    return { cols: this.cols, rows: this.rows };
  }

  public enterAltScreen(): void {
    process.stdout.write('\x1b[?1049h\x1b[0m\x1b[?25l\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
  }

  public exitAltScreen(): void {
    process.stdout.write('\x1b[?25h\x1b[0m\x1b[?1049l');
  }

  public clear(): void {
    this.buffer = ['\x1b[H\x1b[2J'];
  }

  public showCursor(): void {
    this.buffer.push('\x1b[?25h');
  }

  public moveTo(col: number, row: number): string {
    return `\x1b[${row};${col}H`;
  }

  public writeAt(col: number, row: number, text: string): void {
    if (row < 1 || row > this.rows || col < 1 || col > this.cols) return;
    this.buffer.push(`${this.moveTo(col, row)}${text}`);
  }

  public drawBox(
    x: number,
    y: number,
    w: number,
    h: number,
    title?: string,
    borderColor: string = colors.gray
  ): void {
    const maxX = Math.min(this.cols, x + w - 1);
    const maxY = Math.min(this.rows, y + h - 1);
    const innerW = maxX - x - 1;

    if (innerW < 1 || maxY - y < 1) return;

    let top = '┌' + '─'.repeat(innerW) + '┐';
    const titleWidth = title ? stringWidth(title) : 0;
    if (title && innerW > titleWidth + 4) {
      top = `┌─ ${colors.bold}${title}${colors.reset}${borderColor} ` + '─'.repeat(innerW - titleWidth - 4) + '┐';
    }
    this.writeAt(x, y, `${borderColor}${top}${colors.reset}`);

    for (let r = y + 1; r < maxY; r++) {
      this.writeAt(x, r, `${borderColor}│${colors.reset}`);
      this.writeAt(maxX, r, `${borderColor}│${colors.reset}`);
    }

    const bottom = '└' + '─'.repeat(innerW) + '┘';
    this.writeAt(x, maxY, `${borderColor}${bottom}${colors.reset}`);
  }

  public flush(): void {
    process.stdout.write(this.buffer.join('') + '\x1b[0m');
    this.buffer = [];
  }
}
