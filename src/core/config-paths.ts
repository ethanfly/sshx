import os from 'node:os';
import path from 'node:path';

/**
 * Resolves portable paths (~, environment variables, relative paths) to absolute paths on the local OS
 */
export function resolvePortablePath(filePath: string, baseDir?: string): string {
  if (!filePath) return '';

  let resolved = filePath.trim();
  resolved = resolved.replace(/\$([A-Za-z0-9_]+)|\$\{([A-Za-z0-9_]+)\}|%([A-Za-z0-9_]+)%/g, (_, shortName, bracedName, windowsName) => {
    const variableName = shortName || bracedName || windowsName;
    const value = process.env[variableName];
    if (value !== undefined && value !== '') return value;
    if (variableName === 'HOME' || variableName === 'USERPROFILE') return os.homedir();
    return '';
  });

  const home = os.homedir();
  if (resolved === '~') return home;
  if (resolved.startsWith('~/') || resolved.startsWith('~\\')) {
    resolved = path.join(home, resolved.slice(2));
  }
  if (!path.isAbsolute(resolved)) resolved = path.resolve(baseDir || process.cwd(), resolved);
  return path.normalize(resolved);
}

/**
 * Converts local absolute path to cross-platform portable path format with normalized forward slashes and ~ prefix
 */
export function toPortablePath(filePath: string, baseDir?: string): string {
  if (!filePath) return '';

  let portablePath = filePath.trim().replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');
  if (portablePath === home) return '~';
  if (portablePath.toLowerCase().startsWith(`${home.toLowerCase()}/`)) {
    return `~${portablePath.slice(home.length)}`;
  }

  if (baseDir) {
    const base = baseDir.replace(/\\/g, '/');
    if (portablePath.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      portablePath = portablePath.slice(base.length + 1);
    }
  }
  return portablePath;
}

/**
 * Compute edit distance between two strings for typo suggestions
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
  if (a.length < b.length) [a, b] = [b, a];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let row = 1; row <= a.length; row++) {
    current[0] = row;
    for (let column = 1; column <= b.length; column++) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}
