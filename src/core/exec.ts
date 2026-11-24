import { constants as osConstants } from 'node:os';
import { Client, ClientChannel, ExecOptions as SshExecOptions } from 'ssh2';
import { toError } from './errors.js';

export interface ExecOptions {
  timeout?: number; // ms
  maxOutputBytes?: number;
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
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('maxOutputBytes must be a positive safe integer');
  }
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0 || options.timeout > 2_147_483_647)) {
    throw new RangeError('timeout must be between 0 and 2147483647 milliseconds');
  }

  return new Promise<ExecResult>((resolve, reject) => {
    let timeoutTimer: NodeJS.Timeout | undefined;
    let finished = false;
    let stream: ClientChannel | undefined;
    let inputStream: NodeJS.ReadableStream | undefined;

    const execOpts: SshExecOptions = {};
    if (options.env) {
      execOpts.env = options.env;
    }
    if (options.pty) {
      execOpts.pty = typeof options.pty === 'object' ? options.pty : { term: 'xterm-256color' };
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let exitCode: number | undefined;
    let exitSignal: string | undefined;
    let outputBytes = 0;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      client.removeListener('error', onConnectionError);
      client.removeListener('close', onConnectionClose);
      if (inputStream) {
        if (stream) inputStream.unpipe(stream);
        inputStream.removeListener('error', onInputError);
      }
    };

    const closeChannel = (channel: ClientChannel) => {
      try { channel.signal('KILL'); } catch {}
      try { channel.close(); } catch {}
    };

    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (stream) closeChannel(stream);
      reject(error);
    };

    const onConnectionError = (error: Error) => fail(error);
    const onConnectionClose = () => fail(new Error('SSH connection closed before command completed'));
    const onInputError = (error: Error) => fail(error);

    client.on('error', onConnectionError);
    client.on('close', onConnectionClose);

    if (options.timeout && options.timeout > 0) {
      timeoutTimer = setTimeout(() => {
        fail(new Error(`Command timed out after ${options.timeout}ms`));
      }, options.timeout);
    }

    const collectOutput = (chunk: Buffer, chunks: Buffer[], callback?: (chunk: Buffer) => void) => {
      if (finished) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`SSH command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
      try { callback?.(chunk); } catch (callbackError) {
        fail(toError(callbackError));
      }
    };

    try {
      client.exec(command, execOpts, (error: Error | undefined, channel: ClientChannel) => {
        if (finished) {
          if (channel) closeChannel(channel);
          return;
        }
        if (error) {
          fail(error);
          return;
        }

        stream = channel;
        channel.on('error', fail);
        channel.stderr.on('error', fail);
        channel.on('exit', (code: number | null, signal?: string) => {
          exitCode = code ?? undefined;
          exitSignal = signal;
        });
        channel.on('close', () => {
          if (finished) return;
          if (exitSignal) {
            const signalNumber = osConstants.signals[exitSignal as NodeJS.Signals];
            exitCode = typeof signalNumber === 'number' && signalNumber > 0 ? 128 + signalNumber : 1;
          }
          if (exitCode === undefined) {
            fail(new Error('SSH channel closed without a command exit status'));
            return;
          }

          finished = true;
          cleanup();
          resolve({
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            exitCode,
            signal: exitSignal,
            durationMs: Date.now() - startTime
          });
        });

        channel.on('data', (chunk: Buffer) => collectOutput(chunk, stdoutChunks, options.onStdout));
        channel.stderr.on('data', (chunk: Buffer) => collectOutput(chunk, stderrChunks, options.onStderr));

        if (options.stdin !== undefined) {
          try {
            if (typeof options.stdin === 'string' || Buffer.isBuffer(options.stdin)) {
              channel.end(options.stdin);
            } else {
              inputStream = options.stdin;
              inputStream.on('error', onInputError);
              inputStream.pipe(channel);
            }
          } catch (inputError) {
            fail(toError(inputError));
          }
        }
      });
    } catch (error) {
      fail(toError(error));
    }
  });
}
