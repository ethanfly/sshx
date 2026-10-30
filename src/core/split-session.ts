import { Client } from 'ssh2';
import { InteractiveSession, SessionOptions } from './session.js';
import { MetricsCollector, ServerMetrics } from './metrics.js';
import { SidebarRenderer, defaultSidebarTheme } from '../tui/sidebar.js';

export interface SplitSessionOptions extends SessionOptions {
  enableSidebar?: boolean;
  sidebarWidth?: number;
}

/**
 * Manages an interactive split-pane SSH session:
 * - Left pane: interactive remote PTY shell
 * - Right pane: live server resource monitor (IP, user, CPU, RAM, Disk, Net, GPU)
 * - Hotkeys: F2 or Ctrl+O to toggle sidebar expand/collapse
 */
export class SplitSession {
  private session: InteractiveSession;
  private collector?: MetricsCollector;
  private client: Client;
  private options: SplitSessionOptions;

  private sidebarVisible: boolean;
  private sidebarWidth: number;
  private lastMetrics?: ServerMetrics;
  private isDestroyed = false;
  private enteredAltScreen = false;

  constructor(client: Client, options: SplitSessionOptions = {}) {
    this.client = client;
    this.options = options;

    const totalCols = process.stdout.columns || 80;
    this.sidebarWidth = options.sidebarWidth || 34;

    // Default to visible if terminal is wide enough (>= 90 cols)
    const wantsSidebar = options.enableSidebar !== false;
    this.sidebarVisible = wantsSidebar && totalCols >= 90;

    const leftCols = this.computeShellCols(totalCols);
    const rows = process.stdout.rows || 24;

    this.session = new InteractiveSession(client, {
      ...options,
      cols: leftCols,
      rows
    });
  }

  public getSession(): InteractiveSession {
    return this.session;
  }

  private computeShellCols(totalCols: number): number {
    if (!this.sidebarVisible) {
      return totalCols;
    }
    // Shell takes remaining columns minus 1 for margin/separator
    return Math.max(30, totalCols - this.sidebarWidth - 1);
  }

  /**
   * Start the interactive split session
   */
  public async start(): Promise<void> {
    await this.session.start();

    // Start background metrics collector over multiplexed SSH channel
    try {
      this.collector = new MetricsCollector(this.client, 2500);
      this.collector.on('update', (metrics: ServerMetrics) => {
        this.lastMetrics = metrics;
        if (this.sidebarVisible && !this.isDestroyed) {
          this.drawSidebar();
        }
      });
      this.collector.start();
    } catch {
      // Metrics collector is non-fatal; continue shell
    }
  }

  /**
   * Attach terminal stdin and stdout with split-pane multiplexing
   */
  public attachToLocalProcess(): void {
    const stdin = process.stdin;
    const stdout = process.stdout;

    const totalCols = stdout.columns || 80;
    const totalRows = stdout.rows || 24;

    if (this.sidebarVisible && stdout.isTTY) {
      // Enter alternate screen buffer & clear to prevent previous terminal scrollback from showing
      stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
      this.enteredAltScreen = true;
      this.drawSidebar();
      this.enableTerminalMargins();
    }

    // Set raw mode
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
    }

    // Handle terminal resize
    const onResize = () => {
      const cols = stdout.columns || 80;
      const rows = stdout.rows || 24;

      if (this.sidebarVisible && cols < 85) {
        // Automatically hide sidebar on narrow terminals
        this.sidebarVisible = false;
        this.disableTerminalMargins();
      }

      const leftCols = this.computeShellCols(cols);
      this.session.resize(leftCols, rows);

      if (this.sidebarVisible) {
        this.drawSidebar();
        this.enableTerminalMargins();
      } else {
        this.disableTerminalMargins();
      }
    };

    if (stdout.isTTY) {
      stdout.on('resize', onResize);
    }

    // Stdin interceptor: listen for F2 or Ctrl+O to toggle sidebar
    const onStdinData = (chunk: Buffer) => {
      const str = chunk.toString('utf8');

      // F2: \x1bOQ or \x1b[12~  |  Ctrl+O: \x0f
      if (str === '\x1bOQ' || str === '\x1b[12~' || str === '\x0f') {
        this.toggleSidebar();
        return;
      }

      this.session.write(chunk);
    };

    stdin.on('data', onStdinData);

    // Shell output to stdout
    this.session.on('data', (chunk: Buffer) => {
      stdout.write(chunk);
    });

    // Cleanup on session close
    this.session.once('close', () => {
      this.isDestroyed = true;
      if (this.collector) {
        this.collector.stop();
      }
      this.disableTerminalMargins();

      if (this.enteredAltScreen && stdout.isTTY) {
        // Exit alternate screen buffer, cleanly restoring user's original terminal
        stdout.write('\x1b[?1049l');
        this.enteredAltScreen = false;
      }

      if (stdin.isTTY) {
        stdin.setRawMode(false);
        stdin.pause();
      }
      stdin.removeListener('data', onStdinData);
      if (stdout.isTTY) {
        stdout.removeListener('resize', onResize);
      }
    });
  }

  public toggleSidebar(): void {
    const stdout = process.stdout;
    const totalCols = stdout.columns || 80;
    const totalRows = stdout.rows || 24;

    if (!this.sidebarVisible) {
      // Cannot enable if terminal is too narrow
      if (totalCols < 75) {
        return;
      }
      this.sidebarVisible = true;
      const leftCols = this.computeShellCols(totalCols);

      if (!this.enteredAltScreen && stdout.isTTY) {
        stdout.write('\x1b[?1049h');
        this.enteredAltScreen = true;
      }
      stdout.write('\x1b[2J\x1b[H');
      this.drawSidebar();
      this.enableTerminalMargins();
      this.session.resize(leftCols, totalRows);
    } else {
      this.sidebarVisible = false;
      this.disableTerminalMargins();
      // Clear screen and resize shell to 100%
      stdout.write('\x1b[2J\x1b[H');
      this.session.resize(totalCols, totalRows);
    }
  }

  private enableTerminalMargins(): void {
    if (!process.stdout.isTTY) return;
    const totalCols = process.stdout.columns || 80;
    const totalRows = process.stdout.rows || 24;
    const leftCols = this.computeShellCols(totalCols);
    // DECLRMM enable (\x1b[?69h), set vertical margin (\x1b[1;{totalRows}r), set horizontal margin (\x1b[1;{leftCols}s)
    process.stdout.write(`\x1b[?69h\x1b[1;${totalRows}r\x1b[1;${leftCols}s`);
  }

  private disableTerminalMargins(): void {
    if (!process.stdout.isTTY) return;
    // DECLRMM disable (\x1b[?69l), reset scrolling region (\x1b[r)
    process.stdout.write(`\x1b[?69l\x1b[r`);
  }

  /**
   * Draw the right-hand sidebar at its fixed column offset without moving the shell cursor
   */
  public drawSidebar(): void {
    if (!this.sidebarVisible || this.isDestroyed || !process.stdout.isTTY) return;

    const stdout = process.stdout;
    const totalCols = stdout.columns || 80;
    const totalRows = stdout.rows || 24;

    const leftCols = this.computeShellCols(totalCols);
    const sideStartCol = leftCols + 2; // +1 separator, +2 content
    if (sideStartCol > totalCols - 10) return;

    const lines = SidebarRenderer.render(
      this.lastMetrics,
      this.sidebarWidth,
      totalRows,
      defaultSidebarTheme
    );

    let buf = '';
    // 1. Save cursor & hide cursor while updating sidebar
    buf += '\x1b7\x1b[?25l';
    // 2. Temporarily disable horizontal margin so cursor can move outside leftCols
    buf += '\x1b[?69l';
    // 3. Temporarily disable auto-wrap mode (DECAWM) to guarantee zero wrap-around to column 1
    buf += '\x1b[?7l';

    for (let r = 1; r <= Math.min(lines.length, totalRows); r++) {
      const line = lines[r - 1];
      // Position cursor at row r, column sideStartCol
      buf += `\x1b[${r};${sideStartCol}H${line}`;
    }

    // 4. Re-enable auto-wrap mode for shell
    buf += '\x1b[?7h';
    // 5. Re-enable horizontal margin for shell
    buf += `\x1b[?69h\x1b[1;${totalRows}r\x1b[1;${leftCols}s`;
    // 6. Restore cursor & show cursor
    buf += '\x1b8\x1b[?25h';

    stdout.write(buf);
  }
}
