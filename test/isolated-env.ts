import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface IsolatedEnv {
  dir: string;
  env: Record<string, string>;
  cleanup(): void;
}

/**
 * Points HOME, the sshx config directory and known_hosts at a throwaway
 * directory so tests never read or write the developer's real files.
 */
export function createIsolatedEnv(prefix: string): IsolatedEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = {
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    APPDATA: path.join(dir, 'AppData', 'Roaming'),
    SSHX_CONFIG_DIR: path.join(dir, 'sshx'),
    SSHX_HOSTS_FILE: '',
    SSHX_CONFIG_FILE: ''
  };
  return { dir, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
