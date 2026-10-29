import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface HostProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey' | 'agent' | 'keyboard-interactive';
  password?: string;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  proxyJump?: string; // ID or name of another HostProfile
  proxyCommand?: string;
  keepaliveInterval?: number; // milliseconds (default 15000)
  keepaliveCountMax?: number; // max missed keepalives before disconnect (default 3)
  readyTimeout?: number; // ms to wait for handshake (default 20000)
  tags?: string[];
  group?: string;
  environment?: Record<string, string>;
  lastConnected?: string;
  favorite?: boolean;
  notes?: string;
}

export interface AppConfig {
  defaultPort: number;
  defaultUsername: string;
  defaultKeyPath?: string;
  strictHostKeyChecking: 'yes' | 'no' | 'accept-new';
  theme: 'dark' | 'light' | 'dracula' | 'nord' | 'catppuccin';
  terminalFontSize: number;
  terminalFontFamily: string;
  recentHostsLimit: number;
}

export class ConfigManager {
  private configDir: string;
  private hostsFilePath: string;
  private configFilePath: string;
  private keysDir: string;

  constructor(customConfigDir?: string) {
    const envDir = process.env.SSHX_CONFIG_DIR;
    if (customConfigDir) {
      this.configDir = customConfigDir;
    } else if (envDir) {
      this.configDir = resolvePortablePath(envDir);
    } else {
      const home = os.homedir();
      if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        this.configDir = path.join(appData, 'sshx');
      } else {
        const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        this.configDir = path.join(xdgConfig, 'sshx');
      }
    }

    const envHostsFile = process.env.SSHX_HOSTS_FILE;
    const envConfigFile = process.env.SSHX_CONFIG_FILE;

    this.hostsFilePath = envHostsFile ? resolvePortablePath(envHostsFile) : path.join(this.configDir, 'hosts.json');
    this.configFilePath = envConfigFile ? resolvePortablePath(envConfigFile) : path.join(this.configDir, 'config.json');
    this.keysDir = path.join(this.configDir, 'keys');

    this.ensureDirs();
  }

  public getConfigDir(): string {
    return this.configDir;
  }

  public getHostsFilePath(): string {
    return this.hostsFilePath;
  }

  public getConfigFilePath(): string {
    return this.configFilePath;
  }

  public getKeysDir(): string {
    return this.keysDir;
  }

  private ensureDirs(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
    const hostsDir = path.dirname(this.hostsFilePath);
    if (!fs.existsSync(hostsDir)) {
      fs.mkdirSync(hostsDir, { recursive: true, mode: 0o700 });
    }
    const configDir = path.dirname(this.configFilePath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    if (!fs.existsSync(this.keysDir)) {
      fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    }
  }

  public getDefaultAppConfig(): AppConfig {
    return {
      defaultPort: 22,
      defaultUsername: os.userInfo().username || 'root',
      defaultKeyPath: '~/.ssh/id_ed25519',
      strictHostKeyChecking: 'accept-new',
      theme: 'dracula',
      terminalFontSize: 14,
      terminalFontFamily: 'Consolas, Menlo, Monaco, "Courier New", monospace',
      recentHostsLimit: 20
    };
  }

  public getAppConfig(): AppConfig {
    this.ensureDirs();
    if (!fs.existsSync(this.configFilePath)) {
      const def = this.getDefaultAppConfig();
      try {
        fs.writeFileSync(this.configFilePath, JSON.stringify(def, null, 2), { mode: 0o600 });
      } catch {
        // ignore
      }
      return def;
    }
    try {
      const raw = fs.readFileSync(this.configFilePath, 'utf8');
      return { ...this.getDefaultAppConfig(), ...JSON.parse(raw) };
    } catch {
      return this.getDefaultAppConfig();
    }
  }

  public saveAppConfig(config: Partial<AppConfig>): AppConfig {
    this.ensureDirs();
    let current: AppConfig;
    try {
      if (fs.existsSync(this.configFilePath)) {
        const raw = fs.readFileSync(this.configFilePath, 'utf8');
        current = { ...this.getDefaultAppConfig(), ...JSON.parse(raw) };
      } else {
        current = this.getDefaultAppConfig();
      }
    } catch {
      current = this.getDefaultAppConfig();
    }
    const updated = { ...current, ...config };
    fs.writeFileSync(this.configFilePath, JSON.stringify(updated, null, 2), {
      mode: 0o600
    });
    return updated;
  }

  public getHosts(): HostProfile[] {
    this.ensureDirs();
    if (!fs.existsSync(this.hostsFilePath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.hostsFilePath, 'utf8');
      const hosts: HostProfile[] = JSON.parse(raw);
      return Array.isArray(hosts) ? hosts : [];
    } catch {
      return [];
    }
  }

  public saveHosts(hosts: HostProfile[]): void {
    this.ensureDirs();
    fs.writeFileSync(this.hostsFilePath, JSON.stringify(hosts, null, 2), {
      mode: 0o600
    });
  }

  public getHost(idOrName: string): HostProfile | undefined {
    const hosts = this.getHosts();
    const query = idOrName.trim().toLowerCase();
    // 1. Exact match by ID
    const byId = hosts.find(h => h.id === idOrName);
    if (byId) return byId;

    // 2. Exact match by Name (case-insensitive)
    const byName = hosts.find(h => h.name.toLowerCase() === query);
    if (byName) return byName;

    // 3. Match by Host (case-insensitive)
    return hosts.find(h => h.host.toLowerCase() === query);
  }

  public resolveKeyPath(keyPath?: string): string | undefined {
    if (!keyPath) return undefined;
    return resolvePortablePath(keyPath, this.configDir);
  }

  public findHosts(options?: { query?: string; tag?: string } | string, tagFilter?: string): HostProfile[] {
    let query: string | undefined;
    let tag: string | undefined;

    if (typeof options === 'object') {
      query = options.query;
      tag = options.tag;
    } else {
      query = options;
      tag = tagFilter;
    }

    let hosts = this.getHosts();

    if (tag) {
      const tagLower = tag.trim().toLowerCase();
      hosts = hosts.filter(h => h.tags?.some(t => t.toLowerCase() === tagLower));
    }

    if (query) {
      const q = query.trim().toLowerCase();
      hosts = hosts.filter(h =>
        h.name.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q) ||
        h.id.toLowerCase().includes(q) ||
        (h.notes && h.notes.toLowerCase().includes(q)) ||
        (h.tags && h.tags.some(t => t.toLowerCase().includes(q)))
      );
    }

    return hosts;
  }

  public suggestHosts(input: string, limit: number = 3): HostProfile[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];

    const hosts = this.getHosts();
    const scored: Array<{ host: HostProfile; score: number }> = [];

    for (const h of hosts) {
      const nameLower = h.name.toLowerCase();
      const hostLower = h.host.toLowerCase();
      const idLower = h.id.toLowerCase();

      if (nameLower === q || hostLower === q || idLower === q) {
        scored.push({ host: h, score: 0 });
        continue;
      }
      if (nameLower.startsWith(q) || q.startsWith(nameLower) || hostLower.startsWith(q) || q.startsWith(hostLower)) {
        scored.push({ host: h, score: 1 });
        continue;
      }
      if (nameLower.includes(q) || q.includes(nameLower) || hostLower.includes(q) || q.includes(hostLower)) {
        scored.push({ host: h, score: 2 });
        continue;
      }
      const maxDist = Math.max(3, Math.floor(Math.min(q.length, nameLower.length) * 0.35));
      const dist = calculateLevenshteinDistance(q, nameLower);
      if (dist <= maxDist) {
        scored.push({ host: h, score: 10 + dist });
      }
    }

    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map(s => s.host);
  }

  public addHost(profile: Omit<HostProfile, 'id'> & { id?: string }): HostProfile {
    const hosts = this.getHosts();
    const newHost: HostProfile = {
      ...profile,
      id: profile.id || `host_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      port: profile.port !== undefined ? Number(profile.port) : 22,
      authType: profile.authType || (profile.privateKeyPath || profile.privateKey ? 'privateKey' : 'password'),
      privateKeyPath: profile.privateKeyPath ? toPortablePath(profile.privateKeyPath) : undefined,
      tags: profile.tags || []
    };

    const existingIndex = hosts.findIndex(h => h.id === newHost.id || h.name.toLowerCase() === newHost.name.toLowerCase());
    if (existingIndex >= 0) {
      hosts[existingIndex] = newHost;
    } else {
      hosts.push(newHost);
    }

    this.saveHosts(hosts);
    return newHost;
  }

  public updateHost(idOrName: string, updates: Partial<HostProfile>): HostProfile | null {
    const hosts = this.getHosts();
    const index = hosts.findIndex(h => h.id === idOrName || h.name.toLowerCase() === idOrName.toLowerCase());
    if (index === -1) return null;

    const normalizedUpdates = { ...updates };
    if (normalizedUpdates.port !== undefined) {
      normalizedUpdates.port = Number(normalizedUpdates.port);
    }
    if (normalizedUpdates.privateKeyPath) {
      normalizedUpdates.privateKeyPath = toPortablePath(normalizedUpdates.privateKeyPath);
    }

    hosts[index] = { ...hosts[index], ...normalizedUpdates };
    this.saveHosts(hosts);
    return hosts[index];
  }

  public deleteHost(idOrName: string): boolean {
    const hosts = this.getHosts();
    const filtered = hosts.filter(h => h.id !== idOrName && h.name.toLowerCase() !== idOrName.toLowerCase());
    if (filtered.length === hosts.length) return false;
    this.saveHosts(filtered);
    return true;
  }

  public recordConnection(idOrName: string): void {
    this.updateHost(idOrName, {
      lastConnected: new Date().toISOString()
    });
  }

  /**
   * Export all host profiles to a portable JSON file or string
   */
  public exportHosts(exportPath?: string): string {
    const hosts = this.getHosts();
    // Ensure all privateKeyPaths are stored as portable paths
    const portableHosts = hosts.map(h => ({
      ...h,
      privateKeyPath: h.privateKeyPath ? toPortablePath(h.privateKeyPath) : undefined
    }));
    const jsonStr = JSON.stringify(portableHosts, null, 2);

    if (exportPath) {
      const resolved = resolvePortablePath(exportPath);
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved, jsonStr, { mode: 0o600 });
    }

    return jsonStr;
  }

  /**
   * Import host profiles from a portable JSON file
   */
  public importHosts(importPath: string, mode: 'merge' | 'overwrite' = 'merge'): { imported: number; updated: number; total: number } {
    const resolved = resolvePortablePath(importPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Import file not found: ${resolved}`);
    }

    const content = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid configuration format: expected an array of host profiles.`);
    }

    let existing = mode === 'overwrite' ? [] : this.getHosts();
    let imported = 0;
    let updated = 0;

    for (const raw of parsed) {
      if (!raw.name || !raw.host) continue;

      const profile: HostProfile = {
        id: raw.id || `host_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name: raw.name,
        host: raw.host,
        port: raw.port || 22,
        username: raw.username || 'root',
        authType: raw.authType || 'password',
        password: raw.password,
        privateKeyPath: raw.privateKeyPath ? toPortablePath(raw.privateKeyPath) : undefined,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        notes: raw.notes,
        proxyJump: raw.proxyJump,
        proxyCommand: raw.proxyCommand,
        lastConnected: raw.lastConnected
      };

      const matchIdx = existing.findIndex(e => e.id === profile.id || e.name.toLowerCase() === profile.name.toLowerCase());
      if (matchIdx >= 0) {
        existing[matchIdx] = { ...existing[matchIdx], ...profile };
        updated++;
      } else {
        existing.push(profile);
        imported++;
      }
    }

    this.saveHosts(existing);
    return { imported, updated, total: existing.length };
  }

  /**
   * Import hosts from OpenSSH config file (usually ~/.ssh/config)
   */
  public importOpenSSHConfig(configPath?: string): HostProfile[] {
    const targetPath = configPath ? resolvePortablePath(configPath) : path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(targetPath)) {
      return [];
    }

    const content = fs.readFileSync(targetPath, 'utf8');
    const imported = parseOpenSSHConfig(content);
    const existing = this.getHosts();

    const result: HostProfile[] = [];
    for (const item of imported) {
      const match = existing.find(e => e.name.toLowerCase() === item.name.toLowerCase());
      if (match) {
        const updated = { ...match, ...item, id: match.id };
        this.updateHost(match.id, updated);
        result.push(updated);
      } else {
        const added = this.addHost(item);
        result.push(added);
      }
    }
    return result;
  }
}

/**
 * Resolves portable paths (~, environment variables, relative paths) to absolute paths on the local OS
 */
export function resolvePortablePath(filePath: string, baseDir?: string): string {
  if (!filePath) return '';

  let p = filePath.trim();

  // 1. Expand environment variables: $VAR, ${VAR}, %VAR%
  p = p.replace(/\$([A-Za-z0-9_]+)|\$\{([A-Za-z0-9_]+)\}|%([A-Za-z0-9_]+)%/g, (_, a, b, c) => {
    const varName = a || b || c;
    const val = process.env[varName];
    if (val !== undefined && val !== '') return val;
    // Cross-platform fallback for HOME and USERPROFILE across Linux/macOS/Windows
    if (varName === 'HOME' || varName === 'USERPROFILE') {
      return os.homedir();
    }
    return '';
  });

  // 2. Expand home directory prefix (~/ or ~\)
  const home = os.homedir();
  if (p === '~') {
    return home;
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(home, p.slice(2));
  }

  // 3. Resolve relative path against base directory or CWD
  if (!path.isAbsolute(p)) {
    p = path.resolve(baseDir || process.cwd(), p);
  }

  return path.normalize(p);
}

/**
 * Converts local absolute path to cross-platform portable path format with normalized forward slashes and ~ prefix
 */
export function toPortablePath(filePath: string, baseDir?: string): string {
  if (!filePath) return '';

  let p = filePath.trim().replace(/\\/g, '/');
  const home = os.homedir().replace(/\\/g, '/');

  // Replace home directory with ~
  if (p === home) {
    return '~';
  }
  if (p.toLowerCase().startsWith(home.toLowerCase() + '/')) {
    p = '~' + p.slice(home.length);
    return p;
  }

  // If inside baseDir, make it relative
  if (baseDir) {
    const base = baseDir.replace(/\\/g, '/');
    if (p.toLowerCase().startsWith(base.toLowerCase() + '/')) {
      p = p.slice(base.length + 1);
      return p;
    }
  }

  return p;
}

/**
 * Compute edit distance between two strings for typo suggestions
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Parses OpenSSH ~/.ssh/config format
 */
export function parseOpenSSHConfig(content: string): Array<Omit<HostProfile, 'id'>> {
  const lines = content.split('\n');
  const hosts: Array<Omit<HostProfile, 'id'>> = [];
  let currentHost: Partial<HostProfile> | null = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0].toLowerCase();
    const value = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');

    if (keyword === 'host') {
      if (currentHost && currentHost.name && currentHost.name !== '*') {
        finalizeHost(currentHost, hosts);
      }
      currentHost = {
        name: value,
        host: value,
        port: 22,
        username: os.userInfo().username || 'root',
        authType: 'privateKey',
        tags: ['imported-ssh-config']
      };
    } else if (currentHost) {
      switch (keyword) {
        case 'hostname':
          currentHost.host = value;
          break;
        case 'user':
          currentHost.username = value;
          break;
        case 'port':
          currentHost.port = parseInt(value, 10) || 22;
          break;
        case 'identityfile':
          currentHost.privateKeyPath = toPortablePath(value);
          currentHost.authType = 'privateKey';
          break;
        case 'proxyjump':
          currentHost.proxyJump = value;
          break;
        case 'proxycommand':
          currentHost.proxyCommand = value;
          break;
        case 'serveraliveinterval':
          currentHost.keepaliveInterval = (parseInt(value, 10) || 15) * 1000;
          break;
        case 'serveralivecountmax':
          currentHost.keepaliveCountMax = parseInt(value, 10) || 3;
          break;
      }
    }
  }

  if (currentHost && currentHost.name && currentHost.name !== '*') {
    finalizeHost(currentHost, hosts);
  }

  return hosts;
}

function finalizeHost(host: Partial<HostProfile>, list: Array<Omit<HostProfile, 'id'>>) {
  if (!host.name || host.name.includes('*') || host.name.includes('?')) return;
  list.push({
    name: host.name,
    host: host.host || host.name,
    port: host.port || 22,
    username: host.username || os.userInfo().username || 'root',
    authType: host.authType || 'privateKey',
    privateKeyPath: host.privateKeyPath,
    proxyJump: host.proxyJump,
    proxyCommand: host.proxyCommand,
    keepaliveInterval: host.keepaliveInterval,
    keepaliveCountMax: host.keepaliveCountMax,
    tags: host.tags || ['imported-ssh-config']
  });
}

function resolveTilde(filePath: string): string {
  return resolvePortablePath(filePath);
}

export const defaultConfigManager = new ConfigManager();
