import { Client, ClientChannel } from 'ssh2';

export interface ExecOptions {
  timeout?: number; // ms
  env?: Record<string, string>;
  pty?: boolean | { rows?: number; cols?: number; term?: string };
  stdin?: string | Buffer | NodeJS.ReadableStream;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  durationMs: number;
}

/**
 * Execute command on remote SSH server non-interactively
 */
export async function execCommand(
  client: Client,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const startTime = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    let timeoutTimer: NodeJS.Timeout | undefined;
    let finished = false;

    const execOpts: any = {};
    if (options.env) {
      execOpts.env = options.env;
    }
    if (options.pty) {
      execOpts.pty = typeof options.pty === 'object' ? options.pty : { term: 'xterm-256color' };
    }

    client.exec(command, execOpts, (err: Error | undefined, stream: ClientChannel) => {
      if (err) return reject(err);

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let exitCode = 0;
      let exitSignal: string | undefined = undefined;

      if (options.timeout && options.timeout > 0) {
        timeoutTimer = setTimeout(() => {
          if (!finished) {
            finished = true;
            try {
              stream.signal('KILL');
              stream.close();
            } catch {
              // ignore
            }
            reject(new Error(`Command timed out after ${options.timeout}ms: "${command}"`));
          }
        }, options.timeout);
      }

      stream.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        if (options.onStdout) options.onStdout(chunk);
      });

      stream.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        if (options.onStderr) options.onStderr(chunk);
      });

      // Handle stdin if provided
      if (options.stdin) {
        if (typeof options.stdin === 'string' || Buffer.isBuffer(options.stdin)) {
          stream.write(options.stdin);
          stream.end();
        } else {
          options.stdin.pipe(stream);
        }
      }

      stream.on('exit', (code: number, signal?: string) => {
        exitCode = code ?? 0;
        exitSignal = signal;
      });

      stream.on('close', () => {
        if (finished) return;
        finished = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);

        const durationMs = Date.now() - startTime;
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode,
          signal: exitSignal,
          durationMs
        });
      });

      stream.on('error', (streamErr: Error) => {
        if (finished) return;
        finished = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        reject(streamErr);
      });
    });
  });
}
