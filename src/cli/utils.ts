import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stringWidth } from '../core/text-width.js';

// ANSI styling helpers (works across Linux, macOS, Windows Terminal)
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgDark: '\x1b[48;5;236m'
};

export function prompt(questionText: string, hidden: boolean = false): Promise<string> {
  if (!process.stdin.isTTY) {
    pipedPrompt ??= createLinePrompter(process.stdin, process.stdout);
    return pipedPrompt(questionText, hidden);
  }
  if (hidden) {
    return readHiddenInput(questionText, process.stdin, process.stdout);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(questionText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

export type LinePrompter = (questionText: string, exact?: boolean) => Promise<string>;

let pipedPrompt: LinePrompter | undefined;

/**
 * Answers prompts from non-TTY input such as a pipe. Input is read only while
 * a prompt waits, and text past the current line is kept for the next prompt.
 * `exact` keeps surrounding whitespace, which matters for secrets.
 */
export function createLinePrompter(input: Readable, output: { write(text: string): unknown }): LinePrompter {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;

  const takeLine = (): string | undefined => {
    const newline = pending.indexOf('\n');
    if (newline === -1) {
      if (!ended || !pending) return undefined;
      const last = pending;
      pending = '';
      return last;
    }
    const line = pending.slice(0, newline).replace(/\r$/, '');
    pending = pending.slice(newline + 1);
    return line;
  };

  return (questionText, exact = false) => new Promise((resolve, reject) => {
    output.write(questionText);

    const stop = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.pause();
    };
    const settle = (): boolean => {
      const line = takeLine();
      if (line === undefined && !ended) return false;
      stop();
      if (line === undefined) reject(new Error('Input ended before all prompts were answered.'));
      else resolve(exact ? line : line.trim());
      return true;
    };
    const onData = (chunk: Buffer | string) => {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      settle();
    };
    const onEnd = () => {
      pending += decoder.end();
      ended = true;
      settle();
    };
    const onError = (error: Error) => {
      stop();
      reject(error);
    };

    if (input.readableEnded) ended = true;
    if (settle()) return;
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.resume();
  });
}

export interface RawInput {
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/**
 * Reads a secret from a raw TTY, echoing only `*`. Chunks are scanned per
 * character so a pasted secret that ends in Enter still submits.
 */
export function readHiddenInput(
  questionText: string,
  input: RawInput,
  output: { write(text: string): unknown }
): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = input.isRaw === true;
    let secret = '';

    const restore = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
    };

    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          restore();
          resolve(secret);
          return;
        }
        if (char === '\u0003') {
          restore();
          process.exit(130);
        }
        if (char === '\b' || char === '\x7f') {
          if (secret) {
            secret = Array.from(secret).slice(0, -1).join('');
            output.write('\b \b');
          }
        } else {
          secret += char;
          output.write('*');
        }
      }
    };

    output.write(questionText);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

/**
 * Format bytes to readable string (B, KB, MB, GB, TB, PB)
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function padDisplayEnd(text: string, targetWidth: number): string {
  const pad = Math.max(0, targetWidth - stringWidth(text));
  return `${text}${' '.repeat(pad)}`;
}

/**
 * Render terminal table
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, r) => Math.max(max, stringWidth(r[i] || '')), 0);
    return Math.max(stringWidth(h), maxRow);
  });

  const sep = colWidths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => ` ${colors.bold}${padDisplayEnd(h, colWidths[i])}${colors.reset} `).join('│');
  const renderedRows = rows.map(row => {
    return row.map((cell, i) => ` ${padDisplayEnd(cell || '', colWidths[i])} `).join('│');
  });

  return [
    headerLine,
    sep,
    ...renderedRows
  ].join('\n');
}
