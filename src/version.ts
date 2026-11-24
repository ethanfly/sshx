import { createRequire } from 'node:module';

function readPackageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // A broken install still runs; it just cannot report its version.
  }
  return '0.0.0-unknown';
}

/** The installed package version, read from package.json at startup. */
export const packageVersion = readPackageVersion();
