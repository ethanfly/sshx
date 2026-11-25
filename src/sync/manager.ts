import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigManager, defaultConfigManager, writePrivateFile } from '../core/config.js';
import { encryptPayloadAsync, decryptPayloadAsync } from './crypto.js';
import { SyncProvider, WebDavProvider, GistProvider, WebDavConfig, GistConfig } from './provider.js';
import { errorMessage } from '../core/errors.js';

export interface SyncConfig {
  provider: 'webdav' | 'gist';
  passphrase?: string; // Optional: user may choose to save or input on every sync
  savePassphrase?: boolean;
  lastSync?: string;
  webdav?: WebDavConfig;
  gist?: GistConfig;
}

export interface SyncPushResult {
  ok: boolean;
  count: number;
  remoteId?: string;
  updatedAt: string;
}

export interface SyncPullResult {
  ok: boolean;
  imported: number;
  updated: number;
  total: number;
  remoteUpdatedAt?: string;
}

const syncConfigSchema = z.object({
  provider: z.enum(['webdav', 'gist']),
  passphrase: z.string().optional(),
  savePassphrase: z.boolean().optional(),
  lastSync: z.string().optional(),
  webdav: z.object({
    url: z.string().min(1),
    username: z.string().min(1),
    password: z.string(),
    filename: z.string().optional()
  }).optional(),
  gist: z.object({
    token: z.string().min(1),
    gistId: z.string().optional(),
    description: z.string().optional()
  }).optional()
}).superRefine((config, context) => {
  if (config.provider === 'webdav' && !config.webdav) {
    context.addIssue({ code: 'custom', message: 'WebDAV configuration is required.', path: ['webdav'] });
  }
  if (config.provider === 'gist' && !config.gist) {
    context.addIssue({ code: 'custom', message: 'GitHub Gist configuration is required.', path: ['gist'] });
  }
});

export class SyncManager {
  private syncFilePath: string;

  constructor(private configManager: ConfigManager = defaultConfigManager) {
    this.syncFilePath = path.join(this.configManager.getConfigDir(), 'sync.json');
  }

  public getConfig(): SyncConfig | null {
    let data: string;
    try {
      data = fs.readFileSync(this.syncFilePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Could not read sync configuration '${this.syncFilePath}': ${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`Invalid JSON in sync configuration '${this.syncFilePath}'.`);
    }
    const result = syncConfigSchema.safeParse(parsed);
    if (!result.success) {
      const location = result.error.issues[0].path.join('.') || 'root';
      throw new Error(`Invalid sync configuration '${this.syncFilePath}' (at ${location}).`);
    }
    return result.data;
  }

  public saveConfig(config: SyncConfig): void {
    const validated = syncConfigSchema.parse(config);
    writePrivateFile(this.syncFilePath, JSON.stringify(validated, null, 2));
  }

  public getProvider(overrideConfig?: SyncConfig): SyncProvider {
    const config = overrideConfig ? syncConfigSchema.parse(overrideConfig) : this.getConfig();
    if (!config) {
      throw new Error('Sync is not configured yet. Run "sshx sync setup" first.');
    }

    if (config.provider === 'webdav') {
      if (!config.webdav || !config.webdav.url || !config.webdav.username) {
        throw new Error('Incomplete WebDAV configuration.');
      }
      return new WebDavProvider(config.webdav);
    } else if (config.provider === 'gist') {
      if (!config.gist || !config.gist.token) {
        throw new Error('Incomplete GitHub Gist configuration (missing token).');
      }
      return new GistProvider(config.gist);
    } else {
      throw new Error(`Unsupported sync provider: ${config.provider}`);
    }
  }

  /**
   * Push encrypted host profiles to cloud provider
   */
  public async push(passphrase?: string): Promise<SyncPushResult> {
    const config = this.getConfig();
    if (!config) {
      throw new Error('Sync is not configured. Run "sshx sync setup" to get started.');
    }

    const resolvedPassphrase = passphrase || config.passphrase || process.env.SSHX_SYNC_PASSPHRASE;
    if (!resolvedPassphrase) {
      throw new Error('Passphrase is required to encrypt your host profiles.');
    }

    const { json, count } = this.configManager.exportHostSnapshot({ requireExisting: true });

    const encryptedBlob = await encryptPayloadAsync(json, resolvedPassphrase, count);
    const provider = this.getProvider(config);

    const pushRes = await provider.push(encryptedBlob);

    // If Gist provider auto-created a gistId, save it back
    if (config.provider === 'gist' && pushRes.remoteId && (!config.gist?.gistId || config.gist.gistId !== pushRes.remoteId)) {
      config.gist = { ...config.gist!, gistId: pushRes.remoteId };
    }

    const updatedAt = new Date().toISOString();
    config.lastSync = updatedAt;
    this.saveConfig(config);

    return {
      ok: true,
      count,
      remoteId: pushRes.remoteId,
      updatedAt
    };
  }

  /**
   * Pull and decrypt host profiles from cloud provider
   */
  public async pull(passphrase?: string, mode: 'merge' | 'overwrite' = 'merge'): Promise<SyncPullResult> {
    const config = this.getConfig();
    if (!config) {
      throw new Error('Sync is not configured. Run "sshx sync setup" to get started.');
    }

    const resolvedPassphrase = passphrase || config.passphrase || process.env.SSHX_SYNC_PASSPHRASE;
    if (!resolvedPassphrase) {
      throw new Error('Passphrase is required to decrypt your host profiles.');
    }

    const provider = this.getProvider(config);
    const encryptedBlob = await provider.pull();

    const { plaintext, payload } = await decryptPayloadAsync(encryptedBlob, resolvedPassphrase);
    const importRes = this.configManager.importHostsFromJson(plaintext, mode);

    config.lastSync = new Date().toISOString();
    this.saveConfig(config);

    return {
      ok: true,
      imported: importRes.imported,
      updated: importRes.updated,
      total: importRes.total,
      remoteUpdatedAt: payload.updatedAt
    };
  }

  /**
   * Get sync status and connectivity check
   */
  public async getStatus(): Promise<{
    configured: boolean;
    provider?: string;
    lastSync?: string;
    localHostsCount: number;
    connectivity?: { ok: boolean; message: string };
  }> {
    const config = this.getConfig();
    const hostsCount = this.configManager.getHosts().length;

    if (!config) {
      return {
        configured: false,
        localHostsCount: hostsCount
      };
    }

    let connectivity: { ok: boolean; message: string } | undefined;
    try {
      const provider = this.getProvider(config);
      connectivity = await provider.test();
    } catch (error) {
      connectivity = { ok: false, message: errorMessage(error) };
    }

    return {
      configured: true,
      provider: config.provider,
      lastSync: config.lastSync,
      localHostsCount: hostsCount,
      connectivity
    };
  }
}

export const defaultSyncManager = new SyncManager();
