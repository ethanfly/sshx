import fs from 'node:fs';
import path from 'node:path';
import { defaultConfigManager, HostProfile } from '../core/config.js';
import { SSHConnection } from '../core/client.js';
import { execCommand } from '../core/exec.js';
import { SFTPClient } from '../core/sftp.js';
import { KeyManager } from '../core/keygen.js';
import { resolveTarget } from '../cli/connect.js';

export class SkillTools {
  /**
   * List all saved host profiles
   */
  public static listHosts(): HostProfile[] {
    return defaultConfigManager.getHosts();
  }

  /**
   * Add a new host profile
   */
  public static addHost(params: {
    name: string;
    host: string;
    port?: number;
    username: string;
    authType?: 'password' | 'privateKey' | 'agent';
    password?: string;
    privateKeyPath?: string;
    tags?: string[];
  }): HostProfile {
    return defaultConfigManager.addHost({
      name: params.name,
      host: params.host,
      port: params.port || 22,
      username: params.username,
      authType: params.authType || (params.password ? 'password' : 'privateKey'),
      password: params.password,
      privateKeyPath: params.privateKeyPath,
      tags: params.tags || []
    });
  }

  /**
   * Look up one host profile by id or name
   */
  public static getHost(idOrName: string): HostProfile | undefined {
    return defaultConfigManager.getHost(idOrName);
  }

  /**
   * Update an existing host profile. Passwords and key paths are stored as given.
   */
  public static updateHost(idOrName: string, updates: {
    name?: string;
    host?: string;
    port?: number;
    username?: string;
    authType?: 'password' | 'privateKey' | 'agent' | 'keyboard-interactive';
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
    proxyJump?: string;
    tags?: string[];
    notes?: string;
    favorite?: boolean;
  }): HostProfile {
    const updated = defaultConfigManager.updateHost(idOrName, updates);
    if (!updated) {
      throw new Error(`Host profile '${idOrName}' not found`);
    }
    return updated;
  }

  /**
   * Delete a host profile by id or name
   */
  public static deleteHost(idOrName: string): { deleted: boolean; name: string } {
    const existing = defaultConfigManager.getHost(idOrName);
    if (!existing) {
      throw new Error(`Host profile '${idOrName}' not found`);
    }
    const deleted = defaultConfigManager.deleteHost(existing.id);
    return { deleted, name: existing.name };
  }

  /**
   * List local SSH keys
   */
  public static listKeys(): ReturnType<typeof KeyManager.listAvailableKeys> {
    return KeyManager.listAvailableKeys();
  }
  public static async testConnection(hostOrTarget: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const profile = resolveTarget(hostOrTarget);
    return await SSHConnection.testLatency(profile);
  }

  /**
   * Execute command remotely
   */
  public static async exec(
    hostOrTarget: string,
    command: string,
    options: { timeout?: number; env?: Record<string, string> } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    const profile = resolveTarget(hostOrTarget);
    const conn = new SSHConnection({ profile });

    try {
      await conn.connect();
      const res = await execCommand(conn.getRawClient(), command, {
        timeout: options.timeout ? options.timeout * 1000 : 30000,
        env: options.env
      });
      conn.disconnect();
      return res;
    } catch (err: any) {
      conn.disconnect();
      throw err;
    }
  }

  /**
   * List remote directory via SFTP
   */
  public static async sftpList(hostOrTarget: string, remotePath: string = '.'): Promise<any[]> {
    const profile = resolveTarget(hostOrTarget);
    const conn = new SSHConnection({ profile });

    try {
      await conn.connect();
      const sftp = new SFTPClient(conn.getRawClient());
      const files = await sftp.list(remotePath);
      conn.disconnect();
      return files.map(f => ({
        name: f.filename,
        path: f.path,
        isDirectory: f.isDirectory,
        size: f.size,
        permissions: f.modeString,
        modified: f.modifyTime.toISOString()
      }));
    } catch (err: any) {
      conn.disconnect();
      throw err;
    }
  }

  /**
   * Upload file or text content to remote server
   */
  public static async uploadFile(
    hostOrTarget: string,
    remotePath: string,
    options: { content?: string; localPath?: string }
  ): Promise<{ success: boolean; path: string; size: number }> {
    const profile = resolveTarget(hostOrTarget);
    const conn = new SSHConnection({ profile });

    try {
      await conn.connect();
      const sftp = new SFTPClient(conn.getRawClient());

      let size = 0;
      if (options.content !== undefined) {
        await sftp.writeFile(remotePath, options.content);
        size = Buffer.byteLength(options.content, 'utf8');
      } else if (options.localPath) {
        const resolved = path.resolve(options.localPath);
        if (!fs.existsSync(resolved)) throw new Error(`Local file not found: ${resolved}`);
        await sftp.uploadFile(resolved, remotePath);
        size = fs.statSync(resolved).size;
      } else {
        throw new Error('Either content or localPath must be provided');
      }

      conn.disconnect();
      return { success: true, path: remotePath, size };
    } catch (err: any) {
      conn.disconnect();
      throw err;
    }
  }

  /**
   * Download remote file or read content
   */
  public static async downloadFile(
    hostOrTarget: string,
    remotePath: string,
    localPath?: string
  ): Promise<{ content?: string; localPath?: string; size: number }> {
    const profile = resolveTarget(hostOrTarget);
    const conn = new SSHConnection({ profile });

    try {
      await conn.connect();
      const sftp = new SFTPClient(conn.getRawClient());
      const stat = await sftp.stat(remotePath);

      if (localPath) {
        await sftp.downloadFile(remotePath, localPath);
        conn.disconnect();
        return { localPath, size: stat.size };
      } else {
        const content = await sftp.readFile(remotePath);
        conn.disconnect();
        return { content, size: stat.size };
      }
    } catch (err: any) {
      conn.disconnect();
      throw err;
    }
  }

  /**
   * Gather comprehensive system information from remote machine
   */
  public static async getSystemInfo(hostOrTarget: string): Promise<Record<string, any>> {
    const profile = resolveTarget(hostOrTarget);
    const conn = new SSHConnection({ profile });

    try {
      await conn.connect();
      const client = conn.getRawClient();

      const run = async (cmd: string) => {
        const r = await execCommand(client, cmd, { timeout: 10000 });
        return r.stdout.trim();
      };

      const [osInfo, uname, uptime, mem, disk, cpu, hostname] = await Promise.all([
        run('cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || uname -s'),
        run('uname -a'),
        run('uptime'),
        run('free -h 2>/dev/null || vm_stat 2>/dev/null || echo "N/A"'),
        run('df -h / 2>/dev/null || df -h'),
        run('lscpu 2>/dev/null | grep -E "Model name|CPU\\(s\\):" || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "N/A"'),
        run('hostname')
      ]);

      conn.disconnect();

      return {
        host: profile.host,
        username: profile.username,
        hostname,
        os: osInfo.split('\n')[0],
        kernel: uname,
        uptime,
        cpu: cpu.split('\n').filter(Boolean),
        memory: mem.split('\n').filter(Boolean),
        disk: disk.split('\n').filter(Boolean)
      };
    } catch (err: any) {
      conn.disconnect();
      throw err;
    }
  }

  /**
   * Generate an SSH keypair
   */
  public static generateKey(options: { type?: 'ed25519' | 'rsa'; bits?: number; comment?: string }): any {
    return KeyManager.generateKeyPair(options);
  }
}
