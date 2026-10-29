import readline from 'node:readline';

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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    if (hidden && process.stdin.isTTY) {
      process.stdout.write(questionText);
      const stdin = process.stdin;
      const oldRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();

      let input = '';
      const onData = (buf: Buffer) => {
        const char = buf.toString('utf8');
        if (char === '\n' || char === '\r' || char === '\u0004') {
          stdin.setRawMode(oldRaw);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (char === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(oldRaw);
          process.exit(130);
        } else if (char === '\b' || char === '\x7f') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          input += char;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(questionText, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    }
  });
}

/**
 * Format bytes to readable string (KB, MB, GB)
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Render terminal table
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, r) => Math.max(max, (r[i] || '').length), 0);
    return Math.max(h.length, maxRow);
  });

  const sep = colWidths.map(w => '─'.repeat(w + 2)).join('┼');
  const headerLine = headers.map((h, i) => ` ${colors.bold}${h.padEnd(colWidths[i])}${colors.reset} `).join('│');
  const renderedRows = rows.map(row => {
    return row.map((cell, i) => ` ${(cell || '').padEnd(colWidths[i])} `).join('│');
  });

  return [
    headerLine,
    `┼${sep}┼`,
    ...renderedRows
  ].join('\n');
}
