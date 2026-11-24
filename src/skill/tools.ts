import fs from 'node:fs';
import path from 'node:path';
import { defaultConfigManager, HostProfile } from '../core/config.js';
import { SSHConnection } from '../core/client.js';
import { execCommand } from '../core/exec.js';
import { SFTPClient } from '../core/sftp.js';
import { KeyManager, KeyPairResult } from '../core/keygen.js';
import { resolveTarget } from '../cli/connect.js';

/** Opens one SSH connection for `work` and always closes it afterwards. */
async function withConnection<T>(
  hostOrTarget: string,
  work: (connection: SSHConnection, profile: HostProfile) => Promise<T>
): Promise<T> {
  const profile = resolveTarget(hostOrTarget);
  const connection = new SSHConnection({ profile });
  try {
    await connection.connect();
    return await work(connection, profile);
  } finally {
    connection.disconnect();
  }
}

function withSftp<T>(hostOrTarget: string, work: (sftp: SFTPClient) => Promise<T>): Promise<T> {
  return withConnection(hostOrTarget, connection => work(new SFTPClient(connection.getRawClient())));
}

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
  public static exec(
    hostOrTarget: string,
    command: string,
    options: { timeout?: number; env?: Record<string, string> } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    return withConnection(hostOrTarget, connection => execCommand(connection.getRawClient(), command, {
      timeout: options.timeout ? options.timeout * 1000 : 30000,
      env: options.env
    }));
  }

  /**
   * List remote directory via SFTP
   */
  public static sftpList(hostOrTarget: string, remotePath: string = '.'): Promise<Array<{
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    permissions: string;
    modified: string;
  }>> {
    return withSftp(hostOrTarget, async sftp => (await sftp.list(remotePath)).map(f => ({
      name: f.filename,
      path: f.path,
      isDirectory: f.isDirectory,
      size: f.size,
      permissions: f.modeString,
      modified: f.modifyTime.toISOString()
    })));
  }

  /**
   * Upload file or text content to remote server
   */
  public static async uploadFile(
    hostOrTarget: string,
    remotePath: string,
    options: { content?: string; localPath?: string }
  ): Promise<{ success: boolean; path: string; size: number }> {
    const { content, localPath } = options;
    if (content !== undefined) {
      return withSftp(hostOrTarget, async sftp => {
        await sftp.writeFile(remotePath, content);
        return { success: true, path: remotePath, size: Buffer.byteLength(content, 'utf8') };
      });
    }
    if (!localPath) throw new Error('Either content or localPath must be provided');
    const source = path.resolve(localPath);
    if (!fs.existsSync(source)) throw new Error(`Local file not found: ${source}`);
    return withSftp(hostOrTarget, async sftp => {
      await sftp.uploadFile(source, remotePath);
      return { success: true, path: remotePath, size: fs.statSync(source).size };
    });
  }

  /**
   * Download remote file or read content
   */
  public static downloadFile(
    hostOrTarget: string,
    remotePath: string,
    localPath?: string
  ): Promise<{ content?: string; localPath?: string; size: number }> {
    return withSftp(hostOrTarget, async sftp => {
      const { size } = await sftp.stat(remotePath);
      if (localPath) {
        await sftp.downloadFile(remotePath, localPath);
        return { localPath, size };
      }
      return { content: await sftp.readFile(remotePath), size };
    });
  }

  /**
   * Gather comprehensive system information from remote machine
   */
  public static getSystemInfo(hostOrTarget: string): Promise<{
    host: string;
    username: string;
    hostname: string;
    os: string;
    kernel: string;
    uptime: string;
    cpu: string[];
    memory: string[];
    disk: string[];
  }> {
    return withConnection(hostOrTarget, async (connection, profile) => {
      const client = connection.getRawClient();
      const run = async (cmd: string) => (await execCommand(client, cmd, { timeout: 10000 })).stdout.trim();

      const [osInfo, uname, uptime, mem, disk, cpu, hostname] = await Promise.all([
        run('cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || uname -s'),
        run('uname -a'),
        run('uptime'),
        run('free -h 2>/dev/null || vm_stat 2>/dev/null || echo "N/A"'),
        run('df -h / 2>/dev/null || df -h'),
        run('lscpu 2>/dev/null | grep -E "Model name|CPU\\(s\\):" || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "N/A"'),
        run('hostname')
      ]);

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
    });
  }

  /**
   * Generate an SSH keypair
   */
  public static generateKey(options: { type?: 'ed25519' | 'rsa'; bits?: number; comment?: string }): KeyPairResult {
    return KeyManager.generateKeyPair(options);
  }
}
