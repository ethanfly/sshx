import fs from 'node:fs';
import path from 'node:path';
import { defaultConfigManager, HostProfile, HostProfileUpdate, RedactedHostProfile, redactHostSecrets } from '../core/config.js';
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
   * List all saved host profiles (redacted by default)
   */
  public static listHosts(options: { includeSecrets?: boolean } = {}): Array<HostProfile | RedactedHostProfile> {
    const hosts = defaultConfigManager.getHosts();
    return options.includeSecrets ? hosts : hosts.map(redactHostSecrets);
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
   * Look up one host profile by id or name (redacted by default)
   */
  public static getHost(idOrName: string, options: { includeSecrets?: boolean } = {}): HostProfile | RedactedHostProfile | undefined {
    const profile = defaultConfigManager.getHost(idOrName);
    if (!profile) return undefined;
    return options.includeSecrets ? profile : redactHostSecrets(profile);
  }

  /**
   * Update an existing host profile. Pass `null` on optional fields to clear them.
   */
  public static updateHost(idOrName: string, updates: HostProfileUpdate): HostProfile {
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
    return KeyManager.listAvailableKeys(defaultConfigManager.getKeysDir());
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
    return withConnection(hostOrTarget, (connection, profile) => {
      const env = { ...profile.environment, ...options.env };
      return execCommand(connection.getRawClient(), command, {
        timeout: options.timeout ? options.timeout * 1000 : 30000,
        env: Object.keys(env).length > 0 ? env : undefined
      });
    });
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
    localPath?: string,
    options: { maxBytes?: number } = {}
  ): Promise<{ content?: string; localPath?: string; size: number }> {
    const maxBytes = localPath ? undefined : (options.maxBytes ?? 10 * 1024 * 1024);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    return withSftp(hostOrTarget, async sftp => {
      const { size } = await sftp.stat(remotePath);
      if (localPath) {
        await sftp.downloadFile(remotePath, localPath);
        return { localPath, size };
      }
      if (maxBytes !== undefined && size > maxBytes) {
        throw new Error(`Remote file '${remotePath}' (${size} bytes) exceeds maximum read size of ${maxBytes} bytes`);
      }
      return { content: await sftp.readFile(remotePath, 'utf8', maxBytes), size };
    });
  }

  /**
   * Gather comprehensive system information from remote machine over a single SSH exec channel
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
    const probeScript = [
      'printf "__SSHX_SECTION_OS__\\n"',
      'cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || uname -s',
      'printf "__SSHX_SECTION_UNAME__\\n"',
      'uname -a',
      'printf "__SSHX_SECTION_UPTIME__\\n"',
      'uptime',
      'printf "__SSHX_SECTION_MEM__\\n"',
      'free -h 2>/dev/null || vm_stat 2>/dev/null || echo "N/A"',
      'printf "__SSHX_SECTION_DISK__\\n"',
      'df -h / 2>/dev/null || df -h',
      'printf "__SSHX_SECTION_CPU__\\n"',
      'lscpu 2>/dev/null | grep -E "Model name|CPU\\(s\\):" || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "N/A"',
      'printf "__SSHX_SECTION_HOST__\\n"',
      'hostname'
    ].join('\n');
    const command = `sh -c '${probeScript.replace(/'/g, `'\\''`)}'`;

    return withConnection(hostOrTarget, async (connection, profile) => {
      const result = await execCommand(connection.getRawClient(), command, { timeout: 10000 });
      const sections = parseSystemInfoSections(result.stdout);

      return {
        host: profile.host,
        username: profile.username,
        hostname: sections.HOST.trim(),
        os: (sections.OS.split('\n')[0] || '').trim(),
        kernel: sections.UNAME.trim(),
        uptime: sections.UPTIME.trim(),
        cpu: sections.CPU.split('\n').map(line => line.trimEnd()).filter(Boolean),
        memory: sections.MEM.split('\n').map(line => line.trimEnd()).filter(Boolean),
        disk: sections.DISK.split('\n').map(line => line.trimEnd()).filter(Boolean)
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

function parseSystemInfoSections(stdout: string): Record<'OS' | 'UNAME' | 'UPTIME' | 'MEM' | 'DISK' | 'CPU' | 'HOST', string> {
  const sections: Record<'OS' | 'UNAME' | 'UPTIME' | 'MEM' | 'DISK' | 'CPU' | 'HOST', string> = {
    OS: '',
    UNAME: '',
    UPTIME: '',
    MEM: '',
    DISK: '',
    CPU: '',
    HOST: ''
  };
  let current: keyof typeof sections | undefined;
  let foundMarker = false;

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^__SSHX_SECTION_(OS|UNAME|UPTIME|MEM|DISK|CPU|HOST)__$/.exec(line.trim());
    if (match) {
      current = match[1] as keyof typeof sections;
      foundMarker = true;
      continue;
    }
    if (current) {
      sections[current] = sections[current] ? `${sections[current]}\n${line}` : line;
    }
  }

  if (!foundMarker && stdout.trim()) {
    sections.UNAME = stdout.trim();
  }
  return sections;
}
