export function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

export function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  // Combining marks & variation selectors (e.g. VS15, VS16)
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  ) {
    return 0;
  }
  // CJK and fullwidth ranges
  if (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x9fff) || // CJK Radicals, Ideographs
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
    (code >= 0xfe10 && code <= 0xfe19) || // Vertical forms
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK Compatibility Forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
    (code >= 0xffe0 && code <= 0xffe6) || // Fullwidth punctuation & currency
    (code >= 0x20000 && code <= 0x323af) || // CJK Extension B-G
    // Emojis & Pictographs (SMP Plane 1)
    (code >= 0x1f300 && code <= 0x1faff) || // Misc Symbols & Pictographs, Emoticons, Supplemental, Ext-A
    (code >= 0x1f100 && code <= 0x1f2ff) || // Enclosed Alphanumeric & CJK
    // BMP Emojis & Miscellaneous Symbols that modern terminals render as 2 cells
    (code >= 0x2600 && code <= 0x26ff) || // Misc symbols (⚡ 0x26a1, ⚠ 0x26a0, ☕, etc.)
    (code >= 0x2b50 && code <= 0x2b55) || // Stars, circles
    (code >= 0x231a && code <= 0x23f3)    // Watch, hourglass
  ) {
    return 2;
  }
  return 1;
}

export function stringWidth(str: string): number {
  const plain = stripAnsi(str);
  let width = 0;
  for (const char of plain) {
    width += charWidth(char.codePointAt(0) || 0);
  }
  return width;
}

export function padClip(text: string, width: number): string {
  const targetWidth = Math.max(0, width);
  // Visible characters carry their cell width; ANSI escape sequences carry 0
  const parts: Array<{ s: string; w: number; ansi: boolean }> = [];
  let currentWidth = 0;
  let overflow = false;
  let i = 0;

  while (i < text.length) {
    // Retain ANSI escape sequences without consuming display width
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && !/[a-zA-Z]/.test(text[j])) j++;
      if (j < text.length) {
        parts.push({ s: text.slice(i, j + 1), w: 0, ansi: true });
        i = j + 1;
        continue;
      }
    }

    const code = text.codePointAt(i) || 0;
    const char = String.fromCodePoint(code);
    i += char.length;
    const w = charWidth(code);

    if (currentWidth + w > targetWidth) {
      overflow = true;
      break;
    }
    parts.push({ s: char, w, ansi: false });
    currentWidth += w;
  }

  if (overflow && targetWidth >= 1) {
    // Make room for '…' by dropping visible characters only, so escape sequences stay intact
    for (let k = parts.length - 1; k >= 0 && currentWidth + 1 > targetWidth; k--) {
      if (!parts[k].ansi) {
        currentWidth -= parts[k].w;
        parts.splice(k, 1);
      }
    }
    parts.push({ s: '…', w: 1, ansi: false });
    currentWidth += 1;
  }

  let result = parts.map(p => p.s).join('');
  if (currentWidth < targetWidth) {
    result += ' '.repeat(targetWidth - currentWidth);
  }
  return result;
}
