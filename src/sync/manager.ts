import fs from 'node:fs';
import path from 'node:path';
import { ConfigManager, defaultConfigManager } from '../core/config.js';
import { encryptPayload, decryptPayload } from './crypto.js';
import { SyncProvider, WebDavProvider, GistProvider, WebDavConfig, GistConfig } from './provider.js';

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

export class SyncManager {
  private syncFilePath: string;

  constructor(private configManager: ConfigManager = defaultConfigManager) {
    this.syncFilePath = path.join(this.configManager.getConfigDir(), 'sync.json');
  }

  public getConfig(): SyncConfig | null {
    if (!fs.existsSync(this.syncFilePath)) {
      return null;
    }
    try {
      const data = fs.readFileSync(this.syncFilePath, 'utf8');
      return JSON.parse(data) as SyncConfig;
    } catch {
      return null;
    }
  }

  public saveConfig(config: SyncConfig): void {
    const dir = path.dirname(this.syncFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.syncFilePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  public getProvider(overrideConfig?: SyncConfig): SyncProvider {
    const config = overrideConfig || this.getConfig();
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
      throw new Error(`Unsupported sync provider: ${(config as any).provider}`);
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

    const resolvedPassphrase = passphrase || config.passphrase;
    if (!resolvedPassphrase) {
      throw new Error('Passphrase is required to encrypt your host profiles.');
    }

    const hosts = this.configManager.getHosts();
    const exportJson = this.configManager.exportHosts();

    const encryptedBlob = encryptPayload(exportJson, resolvedPassphrase, hosts.length);
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
      count: hosts.length,
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

    const resolvedPassphrase = passphrase || config.passphrase;
    if (!resolvedPassphrase) {
      throw new Error('Passphrase is required to decrypt your host profiles.');
    }

    const provider = this.getProvider(config);
    const encryptedBlob = await provider.pull();

    const { plaintext, payload } = decryptPayload(encryptedBlob, resolvedPassphrase);
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
    } catch (err: any) {
      connectivity = { ok: false, message: err.message || String(err) };
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
