import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calculateLevenshteinDistance, resolvePortablePath, toPortablePath } from './config-paths.js';
import { parseOpenSSHConfigFile } from './openssh-config.js';

export { calculateLevenshteinDistance, resolvePortablePath, toPortablePath } from './config-paths.js';
export { parseOpenSSHConfig, parseOpenSSHConfigFile } from './openssh-config.js';

const hostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  host: z.string().min(1),
  port: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(65535)),
  username: z.string().min(1),
  authType: z.enum(['password', 'privateKey', 'agent', 'keyboard-interactive', 'key'])
    .transform(authType => authType === 'key' ? 'privateKey' : authType),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  proxyJump: z.string().optional(),
  proxyCommand: z.string().optional(),
  keepaliveInterval: z.number().optional(),
  keepaliveCountMax: z.number().optional(),
  readyTimeout: z.number().optional(),
  tags: z.array(z.string()).optional(),
  group: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  lastConnected: z.string().optional(),
  favorite: z.boolean().optional(),
  notes: z.string().optional()
});
const importedHostSchema = hostProfileSchema.partial({ id: true, port: true, username: true, authType: true });
const hostListSchema = z.array(hostProfileSchema);
const importedHostListSchema = z.array(importedHostSchema);
const appConfigSchema = z.object({
  defaultPort: z.number().int().min(1).max(65535),
  defaultUsername: z.string(),
  defaultKeyPath: z.string().optional(),
  strictHostKeyChecking: z.enum(['yes', 'no', 'accept-new']),
  theme: z.enum(['default', 'dark', 'light', 'dracula', 'nord', 'catppuccin']),
  terminalFontSize: z.number().positive(),
  terminalFontFamily: z.string(),
  recentHostsLimit: z.number().int().nonnegative(),
  sidebarDefault: z.enum(['auto', 'always', 'never']).default('auto'),
  sidebarHotkey: z.enum(['f2', 'f2+ctrl-o']).default('f2')
});

export type HostProfile = z.infer<typeof hostProfileSchema>;
type HostInput = z.infer<typeof importedHostSchema>;

export type ClearableHostField =
  | 'password'
  | 'privateKeyPath'
  | 'privateKey'
  | 'passphrase'
  | 'proxyJump'
  | 'proxyCommand'
  | 'notes'
  | 'group'
  | 'environment'
  | 'keepaliveInterval'
  | 'keepaliveCountMax'
  | 'readyTimeout';

export type HostProfileUpdate = {
  [K in keyof HostProfile]?: K extends ClearableHostField ? HostProfile[K] | null : HostProfile[K];
};

export type RedactedHostProfile = Omit<HostProfile, 'password' | 'passphrase' | 'privateKey'> & {
  hasPassword?: boolean;
  hasPassphrase?: boolean;
  hasPrivateKey?: boolean;
};

export function redactHostSecrets(profile: HostProfile): RedactedHostProfile {
  const { password, passphrase, privateKey, ...rest } = profile;
  return {
    ...rest,
    ...(password ? { hasPassword: true } : {}),
    ...(passphrase ? { hasPassphrase: true } : {}),
    ...(privateKey ? { hasPrivateKey: true } : {})
  };
}

export class DuplicateHostError extends Error {
  constructor(name: string) {
    super(`Host "${name}" already exists.`);
    this.name = 'DuplicateHostError';
  }
}

function hostNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function requireUniqueHosts(hosts: HostProfile[]): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const host of hosts) {
    const name = hostNameKey(host.name);
    if (ids.has(host.id) || names.has(name)) {
      throw new Error('Saved host profiles contain duplicate names or IDs. Rename or remove the duplicates before continuing.');
    }
    ids.add(host.id);
    names.add(name);
  }
}

const endpointCredentials = ['password', 'privateKeyPath', 'privateKey', 'passphrase', 'proxyJump', 'proxyCommand'] as const;

function mergeHostProfile(profile: HostInput | HostProfileUpdate, existing?: HostProfile): HostProfile {
  const cleared = new Set<string>();
  const providedEntries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(profile)) {
    if (value === null) {
      cleared.add(key);
    } else if (value !== undefined) {
      providedEntries.push([key, value]);
    }
  }
  const provided: HostInput = Object.fromEntries(providedEntries) as HostInput;

  const endpointChanged = existing && (
    (provided.host !== undefined && provided.host !== existing.host) ||
    (provided.port !== undefined && provided.port !== existing.port) ||
    (provided.username !== undefined && provided.username !== existing.username)
  );
  const inherited: Partial<HostProfile> = { ...existing };
  for (const key of cleared) {
    delete inherited[key as keyof HostProfile];
  }
  if (endpointChanged && existing) {
    inherited.authType = undefined;
    if (provided.authType === existing.authType) delete provided.authType;
    for (const key of endpointCredentials) {
      inherited[key] = undefined;
      if (provided[key] === existing[key] || (key === 'privateKeyPath' && provided[key] !== undefined &&
          toPortablePath(provided[key]) === toPortablePath(existing.privateKeyPath ?? ''))) {
        delete provided[key];
      }
    }
  }
  if (existing && !endpointChanged) {
    const newPath = provided.privateKeyPath;
    const oldPath = existing.privateKeyPath;
    const pathCleared = cleared.has('privateKeyPath');
    const pathChanged = pathCleared || (newPath !== undefined && toPortablePath(newPath) !== toPortablePath(oldPath ?? ''));
    if (pathChanged && provided.privateKey === undefined) inherited.privateKey = undefined;
    const inlineKey = provided.privateKey ?? inherited.privateKey;
    if (inlineKey !== existing.privateKey || (pathChanged && !inlineKey)) inherited.passphrase = undefined;
  }
  const normalized = hostProfileSchema.parse({
    port: 22,
    username: 'root',
    tags: [],
    ...inherited,
    ...provided,
    id: existing?.id ?? provided.id ?? `host_${randomUUID()}`,
    authType: provided.authType ?? inherited.authType ?? (provided.privateKeyPath || provided.privateKey ? 'privateKey' : 'password')
  });
  if (normalized.privateKeyPath) {
    normalized.privateKeyPath = toPortablePath(normalized.privateKeyPath);
  }
  return normalized;
}

export interface AppConfig {
  defaultPort: number;
  defaultUsername: string;
  defaultKeyPath?: string;
  strictHostKeyChecking: 'yes' | 'no' | 'accept-new';
  theme: 'default' | 'dark' | 'light' | 'dracula' | 'nord' | 'catppuccin';
  terminalFontSize: number;
  terminalFontFamily: string;
  recentHostsLimit: number;
  sidebarDefault: 'auto' | 'always' | 'never';
  sidebarHotkey: 'f2' | 'f2+ctrl-o';
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

  public getDefaultAppConfig(): AppConfig {
    return {
      defaultPort: 22,
      defaultUsername: os.userInfo().username || 'root',
      defaultKeyPath: '~/.ssh/id_ed25519',
      strictHostKeyChecking: 'accept-new',
      theme: 'dracula',
      terminalFontSize: 14,
      terminalFontFamily: 'Consolas, Menlo, Monaco, "Courier New", monospace',
      recentHostsLimit: 20,
      sidebarDefault: 'auto',
      sidebarHotkey: 'f2'
    };
  }

  public getAppConfig(): AppConfig {
    let raw: string;
    try {
      raw = fs.readFileSync(this.configFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Could not read app configuration '${this.configFilePath}': ${(error as Error).message}`);
      }
      return this.getDefaultAppConfig();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in app configuration '${this.configFilePath}'.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid app configuration '${this.configFilePath}' (at root).`);
    }
    const result = appConfigSchema.safeParse({ ...this.getDefaultAppConfig(), ...parsed });
    if (!result.success) {
      const location = result.error.issues[0].path.join('.') || 'root';
      throw new Error(`Invalid app configuration '${this.configFilePath}' (at ${location}).`);
    }
    return result.data;
  }

  public saveAppConfig(config: Partial<AppConfig>): AppConfig {
    const current = fs.existsSync(this.configFilePath) ? this.getAppConfig() : this.getDefaultAppConfig();
    const updated = appConfigSchema.parse({ ...current, ...config });
    writePrivateFile(this.configFilePath, JSON.stringify(updated, null, 2));
    return updated;
  }

  public getHosts(options: { requireExisting?: boolean } = {}): HostProfile[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.hostsFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!options.requireExisting) return [];
        throw new Error(`No saved hosts file at '${this.hostsFilePath}'. Run 'sshx sync pull' first if restoring a remote backup.`);
      }
      throw new Error(`Could not read hosts file '${this.hostsFilePath}': ${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in hosts file '${this.hostsFilePath}'.`);
    }

    const result = hostListSchema.safeParse(parsed);
    if (!result.success) {
      const location = result.error.issues[0].path.join('.') || 'root';
      throw new Error(`Invalid host profiles in '${this.hostsFilePath}' (at ${location}).`);
    }
    return result.data;
  }

  public saveHosts(hosts: HostProfile[]): void {
    const data = JSON.stringify(hostListSchema.parse(hosts), null, 2);
    writePrivateFile(this.hostsFilePath, data);
  }

  public getHost(idOrName: string): HostProfile | undefined {
    const hosts = this.getHosts();
    const query = hostNameKey(idOrName);
    // 1. Exact match by ID
    const byId = hosts.find(h => h.id === idOrName);
    if (byId) return byId;

    // 2. Exact match by Name (case-insensitive)
    const byName = hosts.find(h => hostNameKey(h.name) === query);
    if (byName) return byName;

    // 3. Match by Host (case-insensitive)
    return hosts.find(h => h.host.toLowerCase() === query);
  }

  public getHostByName(name: string): HostProfile | undefined {
    const query = hostNameKey(name);
    return this.getHosts().find(host => hostNameKey(host.name) === query);
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
        (h.group && h.group.toLowerCase().includes(q)) ||
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

  public addHost(profile: HostInput, options: { overwrite?: boolean } = {}): HostProfile {
    const hosts = this.getHosts();
    const profileName = hostNameKey(profile.name);
    const byId = hosts.findIndex(host => host.id === profile.id);
    const byName = hosts.findIndex(host => hostNameKey(host.name) === profileName);
    const existingIndex = byId >= 0 ? byId : byName;
    if (existingIndex >= 0 && (!options.overwrite || (byId >= 0 && byName >= 0 && byId !== byName))) {
      throw new DuplicateHostError(profile.name);
    }

    const newHost = mergeHostProfile(profile, hosts[existingIndex]);
    if (existingIndex >= 0) {
      hosts[existingIndex] = newHost;
    } else {
      hosts.push(newHost);
    }

    this.saveHosts(hosts);
    return newHost;
  }

  public updateHost(idOrName: string, updates: HostProfileUpdate): HostProfile | null {
    const hosts = this.getHosts();
    const byId = hosts.findIndex(host => host.id === idOrName);
    const index = byId >= 0 ? byId : hosts.findIndex(host => hostNameKey(host.name) === hostNameKey(idOrName));
    if (index === -1) return null;

    const current = hosts[index];
    const updated = mergeHostProfile({
      ...updates,
      name: updates.name ?? current.name,
      host: updates.host ?? current.host
    }, current);
    if (hostNameKey(updated.name) !== hostNameKey(current.name) &&
        hosts.some(host => hostNameKey(host.name) === hostNameKey(updated.name))) {
      throw new DuplicateHostError(updated.name);
    }
    hosts[index] = updated;
    this.saveHosts(hosts);
    return updated;
  }

  public deleteHost(idOrName: string): boolean {
    const hosts = this.getHosts();
    const byId = hosts.findIndex(host => host.id === idOrName);
    const index = byId >= 0 ? byId : hosts.findIndex(host => hostNameKey(host.name) === hostNameKey(idOrName));
    if (index === -1) return false;
    hosts.splice(index, 1);
    this.saveHosts(hosts);
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
    const { json } = this.exportHostSnapshot();
    if (exportPath) {
      writePrivateFile(resolvePortablePath(exportPath), json);
    }
    return json;
  }

  public exportHostSnapshot(options: { requireExisting?: boolean } = {}): { json: string; count: number } {
    const hosts = this.getHosts(options);
    requireUniqueHosts(hosts);
    const portableHosts = hosts.map(host => ({
      ...host,
      privateKeyPath: host.privateKeyPath ? toPortablePath(host.privateKeyPath) : undefined
    }));
    return { json: JSON.stringify(portableHosts, null, 2), count: hosts.length };
  }

  /**
   * Import host profiles from a JSON string directly
   */
  public importHostsFromJson(content: string, mode: 'merge' | 'overwrite' = 'merge'): { imported: number; updated: number; total: number } {
    const parsed: unknown = JSON.parse(content);
    const incoming = importedHostListSchema.parse(parsed);
    const existing = mode === 'overwrite' ? [] : this.getHosts();
    requireUniqueHosts(existing);
    const hostsById = new Map(existing.map(profile => [profile.id, profile]));
    const hostsByName = new Map(existing.map(profile => [hostNameKey(profile.name), profile]));
    const mappedIds = new Map<string, string>();
    const changedIds = new Set<string>();
    const changedNames = new Set<string>();
    let updated = 0;

    const changes = incoming.map(profile => {
      const name = hostNameKey(profile.name);
      const byId = profile.id === undefined ? undefined : hostsById.get(profile.id);
      const byName = hostsByName.get(name);
      if (byId && byName && byId !== byName) {
        throw new DuplicateHostError(profile.name);
      }
      const current = byId ?? byName;
      const merged = mergeHostProfile(profile, current);
      if (changedIds.has(merged.id) || changedNames.has(name) || (profile.id !== undefined && mappedIds.has(profile.id))) {
        throw new DuplicateHostError(profile.name);
      }
      changedIds.add(merged.id);
      changedNames.add(name);
      if (profile.id !== undefined) mappedIds.set(profile.id, merged.id);
      if (current) updated++;
      return merged;
    });

    changes.forEach((profile, index) => {
      const incomingJump = incoming[index].proxyJump;
      if (incomingJump !== undefined && profile.proxyJump !== undefined) {
        profile.proxyJump = mappedIds.get(incomingJump) ?? incomingJump;
      }
      hostsById.set(profile.id, profile);
    });

    const hosts = [...hostsById.values()];
    this.saveHosts(hosts);
    return { imported: changes.length - updated, updated, total: hosts.length };
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
    return this.importHostsFromJson(content, mode);
  }

  /**
   * Import hosts from OpenSSH config file (usually ~/.ssh/config), supporting `Include` directives
   */
  public importOpenSSHConfig(configPath?: string): HostProfile[] {
    const targetPath = configPath ? resolvePortablePath(configPath) : path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(targetPath)) {
      return [];
    }

    const imported = parseOpenSSHConfigFile(targetPath);
    const existing = this.getHosts();
    const names = new Set(existing.map(profile => hostNameKey(profile.name)));

    const result: HostProfile[] = [];
    for (const item of imported) {
      const name = hostNameKey(item.name);
      if (names.has(name)) continue;
      result.push(mergeHostProfile(item));
      names.add(name);
    }
    if (result.length > 0) this.saveHosts([...existing, ...result]);
    return result;
  }
}

/** Atomically replace `filePath` with owner-only permissions, creating private parent directories. */
export function writePrivateFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export const defaultConfigManager = new ConfigManager();
