import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { Client, ClientChannel, ConnectConfig, SyncHostVerifier } from 'ssh2';
import { HostProfile, ConfigManager, defaultConfigManager, resolvePortablePath } from './config.js';
import { KnownHostsManager } from './known-hosts.js';
import { errorMessage, toError } from './errors.js';

export type KeyboardInteractiveHandler = (
  name: string,
  instructions: string,
  lang: string,
  prompts: Array<{ prompt: string; echo: boolean }>,
  finish: (responses: string[]) => void
) => void;

export interface ConnectionOptions {
  profile: HostProfile;
  configManager?: ConfigManager;
  knownHostsManager?: KnownHostsManager;
  /** Receives the server's pre-authentication banner. */
  onBanner?: (message: string) => void;
  /** Answers keyboard-interactive prompts; password profiles default to the stored password. */
  onKeyboardInteractive?: KeyboardInteractiveHandler;
}

const SECRET_PROMPT = /password|passphrase|密码|口令/i;

export class SSHConnection {
  private client: Client;
  private profile: HostProfile;
  private configManager: ConfigManager;
  private knownHostsManager: KnownHostsManager;
  private readonly onBanner?: (message: string) => void;
  private readonly onKeyboardInteractive?: KeyboardInteractiveHandler;
  private isConnected: boolean = false;
  private jumpConnection?: SSHConnection;
  private transportSocket?: ConnectConfig['sock'];
  private connecting?: Promise<void>;
  /**
   * ssh2 emits exactly one `close` per socket. Numbering sockets lets a retried
   * handshake ignore the late `close` of a failed attempt's socket.
   */
  private socketsOpened = 0;
  private socketsClosed = 0;
  private readonly jumpAncestors: ReadonlySet<string>;

  constructor(options: ConnectionOptions, jumpAncestors: ReadonlySet<string> = new Set()) {
    this.client = new Client();
    this.profile = options.profile;
    this.configManager = options.configManager || defaultConfigManager;
    this.knownHostsManager = options.knownHostsManager || new KnownHostsManager();
    this.jumpAncestors = jumpAncestors;
    this.onBanner = options.onBanner;
    this.onKeyboardInteractive = options.onKeyboardInteractive;
    this.client.on('close', () => { this.socketsClosed++; });
    this.registerAuthListeners(options.onBanner);
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
   * Registered once per client so connection retries never stack responders.
   */
  private registerAuthListeners(onBanner?: (message: string) => void): void {
    if (onBanner) this.client.on('banner', message => onBanner(message));
    this.client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      const respond = this.keyboardResponder();
      if (!respond) return finish([]);
      const normalized = prompts.map(({ prompt, echo }) => ({ prompt, echo: echo !== false }));
      respond(name, instructions, lang, normalized, finish);
    });
  }

  private keyboardResponder(): KeyboardInteractiveHandler | undefined {
    return this.onKeyboardInteractive ?? storedPasswordResponder(this.profile);
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

    // 1. Handle Jump Host / ProxyJump (supports comma-separated multi-hop and inline [user@]host[:port])
    if (this.profile.proxyJump) {
      const hops = this.profile.proxyJump.split(',').map(hop => hop.trim()).filter(Boolean);
      if (hops.length > 0) {
        const nextSpec = hops[hops.length - 1];
        const remainingHops = hops.slice(0, -1).join(',');
        let jumpProfile = this.resolveJumpProfile(nextSpec);
        if (jumpProfile.id === this.profile.id || this.jumpAncestors.has(jumpProfile.id)) {
          throw new Error(`ProxyJump cycle detected for host "${jumpProfile.name}".`);
        }
        if (remainingHops) {
          jumpProfile = {
            ...jumpProfile,
            proxyJump: jumpProfile.proxyJump ? `${remainingHops},${jumpProfile.proxyJump}` : remainingHops
          };
        }
        this.jumpConnection = new SSHConnection({
          profile: jumpProfile,
          configManager: this.configManager,
          knownHostsManager: this.knownHostsManager,
          onBanner: this.onBanner,
          onKeyboardInteractive: this.onKeyboardInteractive
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
    }
    // 2. Handle ProxyCommand
    else if (this.profile.proxyCommand) {
      transportSocket = this.createProxyCommandSocket(this.profile.proxyCommand);
    }
    this.transportSocket = transportSocket;

    await this.handshake(this.buildConnectConfig(transportSocket));
  }

  /**
   * Runs one SSH handshake. Its listeners stay until its own socket closes so
   * late errors are absorbed, but once a newer attempt has started they no
   * longer touch connection state.
   */
  private handshake(config: ConnectConfig): Promise<void> {
    const socket = this.socketsOpened + 1;
    const isCurrent = () => this.socketsOpened === socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const detach = () => {
        this.client.removeListener('error', onError);
        this.client.removeListener('ready', onReady);
        this.client.removeListener('close', onClose);
      };

      const onError = (err: Error) => {
        if (!isCurrent()) return;
        this.cleanup();
        fail(err);
      };

      const onReady = () => {
        if (settled || !isCurrent()) return;
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
        if (this.socketsClosed < socket) return;
        detach();
        if (isCurrent()) this.cleanup();
        fail(new Error('SSH connection closed before authentication completed'));
      };

      this.client.on('error', onError);
      this.client.on('ready', onReady);
      this.client.on('close', onClose);

      this.socketsOpened = socket;
      try {
        this.client.connect(config);
      } catch (err) {
        this.socketsOpened = socket - 1;
        detach();
        this.cleanup();
        fail(toError(err));
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

    if (this.profile.password) {
      // ssh2 tries publickey first when a key is set, then falls back to this.
      config.password = this.profile.password;
    }
    if (this.keyboardResponder()) {
      config.tryKeyboard = true;
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
      // If neither is specified, check configured defaultKeyPath then standard ~/.ssh keys
      if (!privateKey) {
        const candidates = [
          ...(appConfig.defaultKeyPath ? [resolvePath(appConfig.defaultKeyPath, this.configManager.getConfigDir())] : []),
          path.join(os.homedir(), '.ssh', 'id_ed25519'),
          path.join(os.homedir(), '.ssh', 'id_rsa'),
          path.join(os.homedir(), '.ssh', 'id_ecdsa')
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            privateKey = fs.readFileSync(candidate);
            break;
          }
        }
      }

      if (privateKey) {
        config.privateKey = privateKey;
        if (this.profile.passphrase) {
          config.passphrase = this.profile.passphrase;
        }
      }
    } else if (this.profile.authType === 'agent') {
      config.agent = resolveSshAgent();
    }

    return config;
  }

  private resolveJumpProfile(spec: string): HostProfile {
    const saved = this.configManager.getHost(spec);
    if (saved) return saved;

    const looksInline = spec.includes('@') || spec.includes(':') || spec.includes('.') || spec.toLowerCase() === 'localhost';
    if (!looksInline) {
      throw new Error(`Jump host profile not found: "${spec}"`);
    }

    const parsed = parseInlineJumpTarget(spec);
    if (!parsed) {
      throw new Error(`Jump host profile not found: "${spec}"`);
    }

    const username = parsed.username || os.userInfo().username || 'root';
    const port = parsed.port || 22;
    return {
      id: `jump:${username}@${parsed.host}:${port}`,
      name: spec,
      host: parsed.host,
      port,
      username,
      authType: 'privateKey'
    };
  }

  private createProxyCommandSocket(command: string): Duplex {
    const child = spawn(expandProxyCommand(command, this.profile), { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
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
      return { success: false, latencyMs: -1, error: errorMessage(err) };
    }
  }
}

export function resolveSshAgent(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return undefined;
}

function parseInlineJumpTarget(spec: string): { host: string; username?: string; port?: number } | null {
  const at = spec.indexOf('@');
  const username = at === -1 ? undefined : spec.slice(0, at);
  let address = at === -1 ? spec : spec.slice(at + 1);
  if (!address || (at !== -1 && (!username || address.includes('@')))) return null;

  let port: number | undefined;
  if (address.startsWith('[')) {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
    if (!bracketed || isIP(bracketed[1]) !== 6) return null;
    address = bracketed[1];
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if (address.includes(':') && isIP(address) !== 6) {
    const colon = address.lastIndexOf(':');
    if (colon !== address.indexOf(':') || !address.slice(0, colon)) return null;
    const portText = address.slice(colon + 1);
    if (!/^\d+$/.test(portText)) return null;
    port = Number(portText);
    address = address.slice(0, colon);
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  if (!address || /[\s\[\]@]/.test(address)) return null;
  return { host: address, username, port };
}

function resolvePath(filePath: string, baseDir?: string): string {
  return resolvePortablePath(filePath, baseDir);
}

/**
 * A stored password answers keyboard-interactive prompts only for password
 * profiles: ssh2 waits forever if a server advertises the method and nobody
 * answers, which would hang key-based connections.
 */
function storedPasswordResponder(profile: HostProfile): KeyboardInteractiveHandler | undefined {
  const { password, authType } = profile;
  if (!password || authType === 'privateKey' || authType === 'agent') return undefined;
  return (_name, _instructions, _lang, prompts, finish) => {
    finish(prompts.map(({ prompt, echo }) => (SECRET_PROMPT.test(prompt) || !echo ? password : '')));
  };
}

/** Characters OpenSSH refuses in names it substitutes into shell commands (CVE-2023-51385). */
const SHELL_UNSAFE_NAME = /^-|['`"$\\;&<>|(){}\s\p{Cc}]/u;

/**
 * Expands the OpenSSH ProxyCommand tokens `%h`/`%n` (host), `%p` (port), `%r` (user) and `%%`.
 * The command runs through a shell, so names that could inject shell syntax are rejected.
 */
export function expandProxyCommand(command: string, profile: Pick<HostProfile, 'host' | 'port' | 'username'>): string {
  const values: Record<string, string> = {
    '%': '%',
    h: profile.host,
    n: profile.host,
    p: String(profile.port || 22),
    r: profile.username
  };
  return command.replace(/%([%hnpr])/g, (_token, key: string) => {
    const value = values[key];
    if ((key === 'h' || key === 'n' || key === 'r') && SHELL_UNSAFE_NAME.test(value)) {
      throw new Error(`Refusing to expand %${key} in ProxyCommand: '${value}' contains shell metacharacters.`);
    }
    return value;
  });
}
