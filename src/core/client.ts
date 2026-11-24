import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { Client, ClientChannel, ConnectConfig, SyncHostVerifier } from 'ssh2';
import { HostProfile, ConfigManager, defaultConfigManager, resolvePortablePath } from './config.js';
import { KnownHostsManager } from './known-hosts.js';

export interface ConnectionOptions {
  profile: HostProfile;
  configManager?: ConfigManager;
  knownHostsManager?: KnownHostsManager;
  onBanner?: (message: string) => void;
  onKeyboardInteractive?: (
    name: string,
    instructions: string,
    lang: string,
    prompts: Array<{ prompt: string; echo: boolean }>,
    finish: (responses: string[]) => void
  ) => void;
}

export class SSHConnection {
  private client: Client;
  private profile: HostProfile;
  private configManager: ConfigManager;
  private knownHostsManager: KnownHostsManager;
  private isConnected: boolean = false;
  private jumpConnection?: SSHConnection;
  private transportSocket?: ConnectConfig['sock'];
  private connecting?: Promise<void>;
  private readonly jumpAncestors: ReadonlySet<string>;

  constructor(options: ConnectionOptions, jumpAncestors: ReadonlySet<string> = new Set()) {
    this.client = new Client();
    this.profile = options.profile;
    this.configManager = options.configManager || defaultConfigManager;
    this.knownHostsManager = options.knownHostsManager || new KnownHostsManager();
    this.jumpAncestors = jumpAncestors;
  }

  public getRawClient(): Client {
    return this.client;
  }

  public getProfile(): HostProfile {
    return this.profile;
  }

  public connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connect to the SSH server (handles jump host / bastion if configured)
   */
  public async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.connecting) return this.connecting;

    const connecting = this.establishConnection();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async establishConnection(): Promise<void> {
    try {
      await this.openConnection();
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  private async openConnection(): Promise<void> {
    let transportSocket: ConnectConfig['sock'];

    // 1. Handle Jump Host / ProxyJump
    if (this.profile.proxyJump) {
      const jumpProfile = this.configManager.getHost(this.profile.proxyJump);
      if (!jumpProfile) {
        throw new Error(`Jump host profile not found: "${this.profile.proxyJump}"`);
      }
      if (jumpProfile.id === this.profile.id || this.jumpAncestors.has(jumpProfile.id)) {
        throw new Error(`ProxyJump cycle detected for host "${jumpProfile.name}".`);
      }
      this.jumpConnection = new SSHConnection({
        profile: jumpProfile,
        configManager: this.configManager,
        knownHostsManager: this.knownHostsManager
      }, new Set([...this.jumpAncestors, this.profile.id]));
      await this.jumpConnection.connect();

      // Open a forwardOut stream through the jump host
      transportSocket = await this.jumpConnection.forwardOut(
        '127.0.0.1',
        0,
        this.profile.host,
        this.profile.port || 22
      );
    }
    // 2. Handle ProxyCommand
    else if (this.profile.proxyCommand) {
      transportSocket = this.createProxyCommandSocket(this.profile.proxyCommand);
    }
    this.transportSocket = transportSocket;

    // 3. Prepare SSH2 connect configuration
    const connectConfig = this.buildConnectConfig(transportSocket);

    // 4. Perform SSH handshake
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const rejectBeforeReady = (err: Error) => {
        if (!settled) {
          settled = true;
          this.client.removeListener('ready', onReady);
          reject(err);
        }
      };

      const onError = (err: Error) => {
        this.cleanup();
        rejectBeforeReady(err);
      };

      const onReady = () => {
        settled = true;
        this.isConnected = true;
        try {
          this.configManager.recordConnection(this.profile.id);
        } catch {
          process.emitWarning('Could not record the last SSH connection', { code: 'SSHX_CONNECTION_HISTORY' });
        }
        resolve();
      };

      const onClose = () => {
        this.client.removeListener('error', onError);
        this.cleanup();
        if (!settled) rejectBeforeReady(new Error('SSH connection closed before authentication completed'));
      };

      this.client.on('error', onError);
      this.client.once('ready', onReady);
      this.client.once('close', onClose);

      try {
        this.client.connect(connectConfig);
      } catch (err) {
        this.client.removeListener('error', onError);
        this.client.removeListener('close', onClose);
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Establishes port forward tunnel stream from remote jump host
   */
  public forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  private buildConnectConfig(transportSocket?: ConnectConfig['sock']): ConnectConfig {
    const config: ConnectConfig = {
      host: this.profile.host,
      port: this.profile.port || 22,
      username: this.profile.username,
      readyTimeout: this.profile.readyTimeout ?? 20000,
      keepaliveInterval: this.profile.keepaliveInterval ?? 15000,
      keepaliveCountMax: this.profile.keepaliveCountMax ?? 3
    };

    if (transportSocket) {
      config.sock = transportSocket;
    }

    // Host key verification
    const appConfig = this.configManager.getAppConfig();
    config.hostVerifier = ((keyBuffer: Buffer) => {
      const keyType = this.knownHostsManager.extractKeyType(keyBuffer);
      try {
        const result = this.knownHostsManager.verifyHostKey(
          this.profile.host,
          this.profile.port || 22,
          keyType,
          keyBuffer,
          appConfig.strictHostKeyChecking
        );
        if (result.status === 'mismatch') process.emitWarning(result.message, { code: 'SSHX_HOST_KEY_REJECTED' });
        return result.status !== 'mismatch';
      } catch (error) {
        process.emitWarning(`Host key verification failed: ${(error as Error).message}`, { code: 'SSHX_HOST_KEY_CHECK_FAILED' });
        return false;
      }
    }) satisfies SyncHostVerifier;

    // A stored password is used automatically. Keyboard-interactive is only
    // enabled for password auth: ssh2 waits forever if a server advertises it
    // and never answers, which would hang key-based connections.
    const storedPassword = this.profile.password;
    const useKeyboard = Boolean(storedPassword) && this.profile.authType !== 'privateKey' && this.profile.authType !== 'agent';
    if (storedPassword) {
      // ssh2 tries publickey first when a key is set, then falls back to this.
      config.password = storedPassword;
    }
    if (useKeyboard) {
      config.tryKeyboard = true;
      const answer = (prompt: string, echo: boolean) =>
        /password|passphrase|密码|口令/i.test(prompt) || !echo ? storedPassword! : '';
      this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(p => answer(p.prompt, p.echo !== false)));
      });
    }

    // Authentication methods
    if (this.profile.authType === 'privateKey') {
      let privateKey: Buffer | string | undefined = this.profile.privateKey;
      if (!privateKey && this.profile.privateKeyPath) {
        const resolved = resolvePath(this.profile.privateKeyPath, this.configManager.getConfigDir());
        if (fs.existsSync(resolved)) {
          privateKey = fs.readFileSync(resolved);
        } else if (!this.profile.password) {
          throw new Error(`Private key file not found: ${resolved}`);
        }
      }
      // If neither is specified, look for default id_ed25519 or id_rsa
      if (!privateKey) {
        const defaultEd = path.join(os.homedir(), '.ssh', 'id_ed25519');
        const defaultRsa = path.join(os.homedir(), '.ssh', 'id_rsa');
        if (fs.existsSync(defaultEd)) {
          privateKey = fs.readFileSync(defaultEd);
        } else if (fs.existsSync(defaultRsa)) {
          privateKey = fs.readFileSync(defaultRsa);
        }
      }

      if (privateKey) {
        config.privateKey = privateKey;
        if (this.profile.passphrase) {
          config.passphrase = this.profile.passphrase;
        }
      }
    } else if (this.profile.authType === 'agent') {
      config.agent = process.env.SSH_AUTH_SOCK;
    }

    return config;
  }

  private createProxyCommandSocket(command: string): Duplex {
    // Replace %h and %p in proxycommand
    const cmd = command
      .replace(/%h/g, this.profile.host)
      .replace(/%p/g, String(this.profile.port || 22));

    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const duplex = new Duplex({
      read() {
        child.stdout.resume();
      },
      write(chunk, encoding, callback) {
        child.stdin.write(chunk, encoding, callback);
      },
      final(callback) {
        child.stdin.end(callback);
      },
      destroy(error, callback) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.kill();
        callback(error);
      }
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (!duplex.push(chunk)) child.stdout.pause();
    });
    child.stdout.once('end', () => {
      if (child.exitCode !== null || child.signalCode !== null) duplex.push(null);
    });
    child.stdin.once('error', error => {
      if (!duplex.destroyed) duplex.destroy(error);
    });
    child.stdout.once('error', error => {
      if (!duplex.destroyed) duplex.destroy(error);
    });

    child.once('error', error => {
      if (!duplex.destroyed) duplex.destroy(error);
    });
    child.once('close', (code, signal) => {
      if (duplex.destroyed) return;
      if (code !== 0) {
        duplex.destroy(new Error(`ProxyCommand exited with ${signal ? `signal ${signal}` : `status ${code}`}`));
      } else {
        duplex.push(null);
      }
    });
    return duplex;
  }

  public disconnect(): void {
    this.cleanup();
    try {
      this.client.end();
    } catch {
      // ignore
    }
  }

  private cleanup(): void {
    if (this.jumpConnection) {
      this.jumpConnection.disconnect();
      this.jumpConnection = undefined;
    }
    this.transportSocket?.destroy();
    this.transportSocket = undefined;
    this.isConnected = false;
  }

  /**
   * Ping / test connection latency in milliseconds
   */
  public static async testLatency(
    profile: HostProfile,
    configManager?: ConfigManager
  ): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const conn = new SSHConnection({ profile, configManager });
    const start = Date.now();
    try {
      await conn.connect();
      const latencyMs = Date.now() - start;
      conn.disconnect();
      return { success: true, latencyMs };
    } catch (err) {
      conn.disconnect();
      return { success: false, latencyMs: -1, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function resolvePath(filePath: string, baseDir?: string): string {
  return resolvePortablePath(filePath, baseDir);
}
