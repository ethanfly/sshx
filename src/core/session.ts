import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import { Client, ClientChannel } from 'ssh2';

export interface TerminalSize {
  rows: number;
  cols: number;
}

export interface SessionOptions {
  rows?: number;
  cols?: number;
  term?: string;
  recordFilePath?: string;
}

/**
 * Manages an interactive SSH terminal session (PTY)
 */
export class InteractiveSession extends EventEmitter {
  private client: Client;
  private stream?: ClientChannel;
  private options: SessionOptions;
  private recordStream?: fs.WriteStream;
  private recordStartTime: number = 0;
  private isActive: boolean = false;

  constructor(client: Client, options: SessionOptions = {}) {
    super();
    this.client = client;
    this.options = {
      rows: options.rows || 24,
      cols: options.cols || 80,
      term: options.term || 'xterm-256color',
      recordFilePath: options.recordFilePath
    };
  }

  public running(): boolean {
    return this.isActive;
  }

  public getStream(): ClientChannel | undefined {
    return this.stream;
  }

  /**
   * Start the remote shell with PTY
   */
  public async start(): Promise<ClientChannel> {
    if (this.isActive) {
      throw new Error('Session is already active');
    }

    // Init recording if requested (Asciinema v2 format)
    if (this.options.recordFilePath) {
      const recDir = path.dirname(path.resolve(this.options.recordFilePath));
      if (!fs.existsSync(recDir)) {
        fs.mkdirSync(recDir, { recursive: true });
      }
      this.recordStream = fs.createWriteStream(this.options.recordFilePath, { flags: 'w' });
      this.recordStartTime = Date.now();

      // Write Asciinema v2 header
      const header = {
        version: 2,
        width: this.options.cols,
        height: this.options.rows,
        timestamp: Math.floor(this.recordStartTime / 1000),
        env: { TERM: this.options.term, SHELL: '/bin/bash' }
      };
      this.recordStream.write(`${JSON.stringify(header)}\n`);
    }

    return new Promise<ClientChannel>((resolve, reject) => {
      this.client.shell(
        {
          term: this.options.term,
          rows: this.options.rows,
          cols: this.options.cols
        },
        (err: Error | undefined, stream: ClientChannel) => {
          if (err) return reject(err);

          this.stream = stream;
          this.isActive = true;

          stream.on('data', (data: Buffer) => {
            if (this.recordStream) {
              const elapsed = (Date.now() - this.recordStartTime) / 1000;
              this.recordStream.write(`${JSON.stringify([elapsed, 'o', data.toString('utf8')])}\n`);
            }
            this.emit('data', data);
          });

          stream.stderr.on('data', (data: Buffer) => {
            this.emit('data', data);
          });

          stream.on('close', () => {
            this.isActive = false;
            if (this.recordStream) {
              this.recordStream.end();
              this.recordStream = undefined;
            }
            this.emit('close');
          });

          stream.on('error', (streamErr: Error) => {
            this.emit('error', streamErr);
          });

          resolve(stream);
        }
      );
    });
  }

  /**
   * Write data (keystrokes / input) into remote shell
   */
  public write(data: string | Buffer): void {
    if (this.stream && this.isActive) {
      this.stream.write(data);
    }
  }

  /**
   * Resize terminal window
   */
  public resize(cols: number, rows: number): void {
    this.options.cols = cols;
    this.options.rows = rows;
    if (this.stream && this.isActive) {
      this.stream.setWindow(rows, cols, 0, 0);
    }
  }

  /**
   * Attach directly to process stdin and stdout in CLI mode
   */
  public attachToLocalProcess(): void {
    if (!this.stream) return;

    const stdin = process.stdin;
    const stdout = process.stdout;

    // Resize terminal dynamically on terminal resize
    const onResize = () => {
      const cols = stdout.columns || 80;
      const rows = stdout.rows || 24;
      this.resize(cols, rows);
    };

    if (stdout.isTTY) {
      stdout.on('resize', onResize);
      onResize();
    }

    // Set raw mode for unbuffered keystrokes
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
    }

    const onStdinData = (chunk: Buffer) => {
      this.write(chunk);
    };

    stdin.on('data', onStdinData);

    this.on('data', (chunk: Buffer) => {
      stdout.write(chunk);
    });

    this.once('close', () => {
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

  public close(): void {
    if (this.stream) {
      try {
        this.stream.close();
      } catch {
        // ignore
      }
    }
  }
}
