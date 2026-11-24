import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
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
  /** One decoder per output stream so characters split across chunks stay intact. */
  private recordDecoders = new Map<Readable, StringDecoder>();
  private isActive: boolean = false;
  private starting?: Promise<ClientChannel>;
  private cancelStarting?: () => void;
  private detachStream?: () => void;
  private detachLocal?: () => void;

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
    if (this.starting) return this.starting;
    if (this.isActive) {
      throw new Error('Session is already active');
    }
    const opening = new Promise<ClientChannel>((resolve, reject) => {
      let settled = false;
      const clearCancellation = () => {
        if (this.cancelStarting === cancel) this.cancelStarting = undefined;
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        clearCancellation();
        reject(new Error('Session closed before shell startup completed'));
      };
      this.cancelStarting = cancel;

      try {
        this.client.shell(
          {
            term: this.options.term,
            rows: this.options.rows,
            cols: this.options.cols
          },
          (err: Error | undefined, stream: ClientChannel) => {
            if (settled) {
              if (stream) this.closeStream(stream);
              return;
            }
            settled = true;
            clearCancellation();
            if (err) return reject(err);

            try {
              this.openRecording();
            } catch (error) {
              this.closeStream(stream);
              reject(error);
              return;
            }
            this.stream = stream;
            this.isActive = true;

            const onStdout = (data: Buffer) => this.forwardOutput(data, stream);
            const onStderr = (data: Buffer) => this.forwardOutput(data, stream.stderr);
            const onClose = () => this.finish();
            const onError = (streamErr: Error) => this.fail(streamErr);
            stream.on('data', onStdout);
            stream.stderr.on('data', onStderr);
            stream.once('close', onClose);
            stream.on('error', onError);
            this.detachStream = () => {
              stream.removeListener('data', onStdout);
              stream.stderr.removeListener('data', onStderr);
              stream.removeListener('close', onClose);
              stream.removeListener('error', onError);
              this.detachStream = undefined;
            };

            resolve(stream);
          }
        );
      } catch (error) {
        settled = true;
        clearCancellation();
        reject(error);
      }
    });
    this.starting = opening;
    try {
      return await opening;
    } finally {
      if (this.starting === opening) this.starting = undefined;
    }
  }

  private openRecording(): void {
    if (!this.options.recordFilePath) return;
    const recordingPath = path.resolve(this.options.recordFilePath);
    fs.mkdirSync(path.dirname(recordingPath), { recursive: true });
    const descriptor = fs.openSync(recordingPath, 'w', 0o600);
    try {
      fs.fchmodSync(descriptor, 0o600);
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
    this.recordStream = fs.createWriteStream(recordingPath, { fd: descriptor });
    this.recordStream.on('error', (error: Error) => this.fail(error));
    this.recordStartTime = Date.now();
    const header = {
      version: 2,
      width: this.options.cols,
      height: this.options.rows,
      timestamp: Math.floor(this.recordStartTime / 1000),
      // The remote login shell is unknown here, so only the negotiated terminal type is recorded.
      env: { TERM: this.options.term }
    };
    this.recordStream.write(`${JSON.stringify(header)}\n`);
  }

  private forwardOutput(data: Buffer, source: Readable): void {
    const recording = this.recordStream;
    if (recording) {
      let decoder = this.recordDecoders.get(source);
      if (!decoder) {
        decoder = new StringDecoder('utf8');
        this.recordDecoders.set(source, decoder);
      }
      const text = decoder.write(data);
      const elapsed = (Date.now() - this.recordStartTime) / 1000;
      if (text && !recording.write(`${JSON.stringify([elapsed, 'o', text])}\n`)) {
        source.pause();
        recording.once('drain', () => {
          if (this.isActive && this.recordStream === recording) source.resume();
        });
      }
    }
    this.emit('data', data);
  }

  private finish(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.detachStream?.();
    this.stream = undefined;
    const recording = this.recordStream;
    this.recordStream = undefined;
    this.recordDecoders.clear();
    if (recording && !recording.destroyed) recording.end();
    this.emit('close');
  }

  private fail(error: Error): void {
    if (!this.isActive) return;
    try {
      if (this.listenerCount('error') > 0) this.emit('error', error);
      else process.emitWarning(error, { code: 'SSHX_SESSION_ERROR' });
    } finally {
      this.close();
      this.finish();
    }
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
    if (!this.isActive || this.detachLocal) return;

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

    const wasRaw = stdin.isRaw === true;
    const wasPaused = typeof stdin.isPaused === 'function' && stdin.isPaused();
    if (stdin.isTTY) {
      stdin.setRawMode(true);
      stdin.resume();
    }

    const onStdinData = (chunk: Buffer) => {
      this.write(chunk);
    };

    stdin.on('data', onStdinData);

    const onSessionData = (chunk: Buffer) => {
      stdout.write(chunk);
    };
    this.on('data', onSessionData);

    const detach = () => {
      this.detachLocal = undefined;
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw);
        if (wasPaused) stdin.pause();
      }
      stdin.removeListener('data', onStdinData);
      this.removeListener('data', onSessionData);
      if (stdout.isTTY) {
        stdout.removeListener('resize', onResize);
      }
    };
    this.detachLocal = detach;
    this.once('close', detach);
  }

  public close(): void {
    this.cancelStarting?.();
    if (this.stream) this.closeStream(this.stream);
  }

  private closeStream(stream: ClientChannel): void {
    try {
      stream.close();
    } catch {
      // ignore
    }
  }
}
