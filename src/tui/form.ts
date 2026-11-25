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
  let fieldOffset = 0;
  let cursor = Array.from(fields[0]?.value || '').length;

  const render = () => {
    screen.clear();
    const hasAnyHint = fields.some(field => Boolean(field.hint));
    const chromeRows = hasAnyHint ? 7 : 6;
    const w = Math.max(20, Math.min(screen.cols - 2, 78));
    const h = Math.max(6, Math.min(screen.rows - 2, fields.length + chromeRows));
    const x = Math.max(1, Math.floor((screen.cols - w) / 2));
    const y = Math.max(1, Math.floor((screen.rows - h) / 2));
    screen.drawBox(x, y, w, h, title, theme.border);

    const visibleCount = Math.max(1, h - (hasAnyHint ? 6 : 5));
    if (index < fieldOffset) fieldOffset = index;
    else if (index >= fieldOffset + visibleCount) fieldOffset = index - visibleCount + 1;

    const valueMaxW = Math.max(8, w - 24);
    const slice = fields.slice(fieldOffset, fieldOffset + visibleCount);

    slice.forEach((field, offset) => {
      const i = fieldOffset + offset;
      const row = y + 2 + offset;
      const active = i === index;
      const label = padClip(field.label, 16);
      const rawChars = Array.from(field.value);
      const displayChars = field.secret ? Array.from('*'.repeat(rawChars.length)) : rawChars;
      const marker = active ? `${theme.accent}▸${colors.reset}` : ' ';

      const { visibleText, cursorWidth } = active
        ? sliceFieldWindow(displayChars, cursor, valueMaxW)
        : { visibleText: padClip(displayChars.join(''), valueMaxW).trimEnd(), cursorWidth: 0 };

      screen.writeAt(x + 2, row, `${marker} ${theme.muted}${label}${colors.reset} ${visibleText}`);
      if (active) {
        const col = x + 2 + 2 + 16 + 1 + cursorWidth;
        screen.writeAt(Math.min(col, x + w - 2), row, `${theme.accent}▍${colors.reset}`);
        screen.showCursor();
      }
    });

    const hintMaxW = Math.max(8, w - 4);
    const activeHint = fields[index]?.hint;
    if (hasAnyHint && activeHint && h >= 7) {
      screen.writeAt(x + 2, y + h - 3, `${theme.accent}${padClip(activeHint, hintMaxW)}${colors.reset}`);
    }
    const hintRow = y + h - 2;
    screen.writeAt(x + 2, hintRow, `${theme.muted}${padClip(footerHint, hintMaxW)}${colors.reset}`);
    screen.flush();
  };

  render();

  return new Promise((resolve) => {
    const onKey = (str: string | undefined, key: readline.Key) => {
      const field = fields[index];
      if (!field) return;
      const chars = Array.from(field.value);

      if (key?.ctrl && key.name === 'c') {
        cleanup();
        resolve({ cancelled: true, values: {} });
        return;
      }
      if (key?.name === 'escape') {
        cleanup();
        resolve({ cancelled: true, values: {} });
        return;
      }
      if (key?.ctrl && (key.name === 's' || key.name === 'return')) {
        cleanup();
        resolve({ cancelled: false, values: collect() });
        return;
      }
      if (key?.name === 'tab' || (key?.name === 'down' && !key.shift) || (key?.ctrl && key.name === 'n')) {
        index = (index + 1) % fields.length;
        cursor = Array.from(fields[index].value).length;
        render();
        return;
      }
      if (key?.name === 'up' || (key?.shift && key.name === 'tab') || (key?.ctrl && key.name === 'p')) {
        index = (index - 1 + fields.length) % fields.length;
        cursor = Array.from(fields[index].value).length;
        render();
        return;
      }
      if (key?.name === 'return') {
        index = Math.min(fields.length - 1, index + 1);
        cursor = Array.from(fields[index].value).length;
        render();
        return;
      }
      if (key?.name === 'backspace') {
        if (cursor > 0) {
          chars.splice(cursor - 1, 1);
          field.value = chars.join('');
          cursor--;
        }
        render();
        return;
      }
      if (key?.name === 'delete') {
        if (cursor < chars.length) {
          chars.splice(cursor, 1);
          field.value = chars.join('');
        }
        render();
        return;
      }
      if (key?.name === 'left') {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }
      if (key?.name === 'right') {
        cursor = Math.min(chars.length, cursor + 1);
        render();
        return;
      }
      if (key?.name === 'home') {
        cursor = 0;
        render();
        return;
      }
      if (key?.name === 'end') {
        cursor = chars.length;
        render();
        return;
      }
      if (str && str.length > 0 && !key?.ctrl && !key?.meta) {
        const sanitized = str.replace(/[\x00-\x1f\x7f]/g, '');
        if (sanitized) {
          const inserted = Array.from(sanitized);
          chars.splice(cursor, 0, ...inserted);
          field.value = chars.join('');
          cursor += inserted.length;
          render();
        }
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

function sliceFieldWindow(
  chars: string[],
  cursor: number,
  maxWidth: number
): { visibleText: string; cursorWidth: number } {
  const clampedCursor = Math.max(0, Math.min(cursor, chars.length));
  let start = 0;
  while (start < clampedCursor && stringWidth(chars.slice(start, clampedCursor).join('')) > Math.max(1, maxWidth - 1)) {
    start++;
  }

  let usedWidth = 0;
  const visible: string[] = [];
  for (let i = start; i < chars.length; i++) {
    const w = stringWidth(chars[i]);
    if (usedWidth + w > maxWidth) break;
    visible.push(chars[i]);
    usedWidth += w;
  }

  const cursorWidth = stringWidth(chars.slice(start, clampedCursor).join(''));
  return { visibleText: visible.join(''), cursorWidth: Math.min(cursorWidth, maxWidth) };
}

export function clipVisible(text: string, width: number): string {
  return padClip(stripAnsi(text), width);
}
