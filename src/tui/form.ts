import readline from 'node:readline';
import { ScreenBuffer, stripAnsi, padClip, stringWidth } from './screen.js';
import { TuiTheme } from './theme.js';
import { colors } from '../cli/utils.js';

export interface FormField {
  key: string;
  label: string;
  value: string;
  secret?: boolean;
  hint?: string;
}

export interface FormResult {
  cancelled: boolean;
  values: Record<string, string>;
}

/**
 * Full-screen form used by the TUI for add/edit host and key generation.
 * Returns when the user submits (Ctrl+S / Ctrl+Enter) or cancels (Esc).
 */
export async function runForm(
  screen: ScreenBuffer,
  theme: TuiTheme,
  title: string,
  fields: FormField[],
  footerHint: string
): Promise<FormResult> {
  let index = 0;
  let cursor = fields[0]?.value.length || 0;

  const render = () => {
    screen.clear();
    const w = Math.min(screen.cols - 2, 78);
    const h = Math.min(screen.rows - 2, fields.length + 6);
    const x = Math.max(1, Math.floor((screen.cols - w) / 2));
    const y = Math.max(1, Math.floor((screen.rows - h) / 2));
    screen.drawBox(x, y, w, h, title, theme.border);

    fields.forEach((field, i) => {
      const row = y + 2 + i;
      const active = i === index;
      const label = padClip(field.label, 16);
      const shown = field.secret ? '*'.repeat(field.value.length) : field.value;
      const marker = active ? `${theme.accent}▸${colors.reset}` : ' ';
      screen.writeAt(x + 2, row, `${marker} ${theme.muted}${label}${colors.reset} ${shown}`);
      if (active) {
        const cursorVisualWidth = field.secret ? field.value.length : stringWidth(field.value.slice(0, cursor));
        const col = x + 2 + 2 + 16 + 1 + cursorVisualWidth;
        screen.writeAt(Math.min(col, screen.cols), row, `${theme.accent}▍${colors.reset}`);
        screen.showCursor();
      }
    });

    const hintRow = y + h - 2;
    screen.writeAt(x + 2, hintRow, `${theme.muted}${footerHint}${colors.reset}`);
    const activeHint = fields[index]?.hint;
    if (activeHint) {
      screen.writeAt(x + 2, y + h - 1 > screen.rows ? screen.rows : Math.min(screen.rows, hintRow + 1), '');
    }
    screen.flush();
  };

  render();

  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: readline.Key) => {
      const field = fields[index];
      if (!field) return;

      if (key.ctrl && key.name === 'c') {
        cleanup();
        resolve({ cancelled: true, values: {} });
        return;
      }
      if (key.name === 'escape') {
        cleanup();
        resolve({ cancelled: true, values: {} });
        return;
      }
      if (key.ctrl && (key.name === 's' || key.name === 'return')) {
        cleanup();
        resolve({ cancelled: false, values: collect() });
        return;
      }
      if (key.name === 'tab' || (key.name === 'down' && !key.shift) || (key.ctrl && key.name === 'n')) {
        index = (index + 1) % fields.length;
        cursor = fields[index].value.length;
        render();
        return;
      }
      if (key.name === 'up' || (key.shift && key.name === 'tab') || (key.ctrl && key.name === 'p')) {
        index = (index - 1 + fields.length) % fields.length;
        cursor = fields[index].value.length;
        render();
        return;
      }
      if (key.name === 'return') {
        index = Math.min(fields.length - 1, index + 1);
        cursor = fields[index].value.length;
        render();
        return;
      }
      if (key.name === 'backspace') {
        if (cursor > 0) {
          field.value = field.value.slice(0, cursor - 1) + field.value.slice(cursor);
          cursor--;
        }
        render();
        return;
      }
      if (key.name === 'delete') {
        field.value = field.value.slice(0, cursor) + field.value.slice(cursor + 1);
        render();
        return;
      }
      if (key.name === 'left') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key.name === 'right') {
        cursor = Math.min(field.value.length, cursor + 1);
        render();
        return;
      }
      if (key.name === 'home') {
        cursor = 0;
        render();
        return;
      }
      if (key.name === 'end') {
        cursor = field.value.length;
        render();
        return;
      }
      if (str && str.length === 1 && !key.ctrl && !key.meta && str >= ' ' && str !== '\x1b') {
        field.value = field.value.slice(0, cursor) + str + field.value.slice(cursor);
        cursor++;
        render();
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
    };

    process.stdin.on('keypress', onKey);
  });

  function collect(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of fields) values[field.key] = field.value;
    return values;
  }
}

export function clipVisible(text: string, width: number): string {
  return padClip(stripAnsi(text), width);
}
