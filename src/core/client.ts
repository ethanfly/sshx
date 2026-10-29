import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Client, ConnectConfig } from 'ssh2';
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
  private keepaliveTimer?: NodeJS.Timeout;
  private missedKeepalives: number = 0;
  private jumpConnection?: SSHConnection;

  constructor(options: ConnectionOptions) {
    this.client = new Client();
    this.profile = options.profile;
    this.configManager = options.configManager || defaultConfigManager;
    this.knownHostsManager = options.knownHostsManager || new KnownHostsManager();
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

    let transportSocket: net.Socket | any = undefined;

    // 1. Handle Jump Host / ProxyJump
    if (this.profile.proxyJump) {
      const jumpProfile = this.configManager.getHost(this.profile.proxyJump);
      if (!jumpProfile) {
        throw new Error(`Jump host profile not found: "${this.profile.proxyJump}"`);
      }
      this.jumpConnection = new SSHConnection({
        profile: jumpProfile,
        configManager: this.configManager,
        knownHostsManager: this.knownHostsManager
      });
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

    // 3. Prepare SSH2 connect configuration
    const connectConfig = this.buildConnectConfig(transportSocket);

    // 4. Perform SSH handshake
    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          this.cleanup();
          reject(err);
        }
      };

      this.client.once('error', onError);

      this.client.once('ready', () => {
        if (!settled) {
          settled = true;
          this.isConnected = true;
          this.client.removeListener('error', onError);
          this.setupKeepalive();
          this.configManager.recordConnection(this.profile.id);
          resolve();
        }
      });

      this.client.once('close', () => {
        this.isConnected = false;
        this.cleanup();
      });

      try {
        this.client.connect(connectConfig);
      } catch (err) {
        if (!settled) {
          settled = true;
          this.cleanup();
          reject(err);
        }
      }
    });
  }

  /**
   * Establishes port forward tunnel stream from remote jump host
   */
  public forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut(srcIP, srcPort, dstIP, dstPort, (err, stream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  private buildConnectConfig(transportSocket?: any): ConnectConfig {
    const config: ConnectConfig = {
      host: this.profile.host,
      port: this.profile.port || 22,
      username: this.profile.username,
      readyTimeout: this.profile.readyTimeout || 20000,
      keepaliveInterval: this.profile.keepaliveInterval || 15000,
      keepaliveCountMax: this.profile.keepaliveCountMax || 3
    };

    if (transportSocket) {
      config.sock = transportSocket;
    }

    // Host key verification
    const appConfig = this.configManager.getAppConfig();
    config.hostHash = 'sha256';
    config.hostVerifier = (keyLookup: any) => {
      // In ssh2, keyLookup provides key buffer
      const keyBuffer = Buffer.isBuffer(keyLookup) ? keyLookup : Buffer.from(keyLookup);
      const res = this.knownHostsManager.verifyHostKey(
        this.profile.host,
        this.profile.port || 22,
        'ssh-rsa',
        keyBuffer,
        appConfig.strictHostKeyChecking
      );
      if (res.status === 'mismatch') {
        throw new Error(res.message);
      }
      return true;
    };

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

  private createProxyCommandSocket(command: string): net.Socket {
    // Replace %h and %p in proxycommand
    const cmd = command
      .replace(/%h/g, this.profile.host)
      .replace(/%p/g, String(this.profile.port || 22));

    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    const duplex = new (net.Socket as any)();

    child.stdout.on('data', (data: Buffer) => duplex.emit('data', data));
    child.stdout.on('end', () => duplex.emit('end'));
    child.stdout.on('close', () => duplex.emit('close'));
    child.on('error', (err: Error) => duplex.emit('error', err));

    duplex.write = (chunk: any, encoding?: any, cb?: any) => child.stdin.write(chunk, encoding, cb);
    duplex.end = (chunk?: any, encoding?: any, cb?: any) => child.stdin.end(chunk, encoding, cb);
    duplex.destroy = () => {
      child.kill();
      return duplex;
    };

    return duplex;
  }

  private setupKeepalive(): void {
    const interval = this.profile.keepaliveInterval || 15000;
    const maxMissed = this.profile.keepaliveCountMax || 3;

    this.keepaliveTimer = setInterval(() => {
      if (!this.isConnected) {
        clearInterval(this.keepaliveTimer);
        return;
      }
      const raw = this.client as any;
      if (typeof raw.ping === 'function') {
        raw.ping((err: any) => {
          if (err) {
            this.missedKeepalives++;
            if (this.missedKeepalives >= maxMissed) {
              this.disconnect();
            }
          } else {
            this.missedKeepalives = 0;
          }
        });
      }
    }, interval);
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
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.jumpConnection) {
      this.jumpConnection.disconnect();
      this.jumpConnection = undefined;
    }
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
    } catch (err: any) {
      conn.disconnect();
      return { success: false, latencyMs: -1, error: err.message || String(err) };
    }
  }
}

function resolvePath(filePath: string, baseDir?: string): string {
  return resolvePortablePath(filePath, baseDir);
}
