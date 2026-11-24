import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { defaultConfigManager, HostProfile, resolvePortablePath } from '../core/config.js';
import { SSHConnection } from '../core/client.js';
import { InteractiveSession } from '../core/session.js';
import { SplitSession } from '../core/split-session.js';
import { TunnelManager, parsePortForwardString } from '../core/tunnel.js';
import { colors, prompt } from './utils.js';
import { errorMessage } from '../core/errors.js';

export interface ConnectCliOptions {
  port?: number | string;
  user?: string;
  identity?: string;
  password?: string;
  jump?: string;
  record?: string;
  sidebar?: boolean;
  localForward?: string[];
  remoteForward?: string[];
  dynamicForward?: string[];
}

export class TargetNotFoundError extends Error {
  public target: string;
  public suggestions: HostProfile[];

  constructor(target: string, suggestions: HostProfile[], allHosts: HostProfile[] = []) {
    let msg = `Host profile or address '${target}' not found.`;
    if (suggestions.length > 0) {
      msg += `\n\n${colors.yellow}Did you mean one of these?${colors.reset}`;
      for (const s of suggestions) {
        msg += `\n  ${colors.cyan}• ${s.name}${colors.reset} (${s.username}@${s.host}:${s.port})`;
      }
    }
    if (allHosts.length > 0) {
      msg += `\n\nRun '${colors.bold}sshx host list${colors.reset}' to view all saved host profiles.`;
    } else {
      msg += `\n\nNo saved hosts. Run '${colors.bold}sshx host add${colors.reset}' to create a profile.`;
    }
    super(msg);
    this.name = 'TargetNotFoundError';
    this.target = target;
    this.suggestions = suggestions;
  }
}

function parsePort(value: string | number): number {
  if (!/^\d+$/.test(String(value))) throw new Error(`Invalid SSH port: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid SSH port: ${value}`);
  return port;
}

function parseAddress(target: string): { host: string; username?: string; port?: number } {
  const at = target.indexOf('@');
  const username = at === -1 ? undefined : target.slice(0, at);
  let address = at === -1 ? target : target.slice(at + 1);
  if (!address || (at !== -1 && (!username || address.includes('@')))) {
    throw new Error(`Invalid SSH target: ${target}`);
  }

  let port: number | undefined;
  if (address.startsWith('[')) {
    const bracketed = /^\[([^\]]+)\](?::(.+))?$/.exec(address);
    if (!bracketed || isIP(bracketed[1]) !== 6) throw new Error(`Invalid SSH target: ${target}`);
    address = bracketed[1];
    if (bracketed[2] !== undefined) port = parsePort(bracketed[2]);
  } else if (address.includes(':') && isIP(address) !== 6) {
    const colon = address.lastIndexOf(':');
    if (colon !== address.indexOf(':') || !address.slice(0, colon)) {
      throw new Error(`Invalid SSH target: ${target}`);
    }
    port = parsePort(address.slice(colon + 1));
    address = address.slice(0, colon);
  }

  if (!address || /[\s\[\]@]/.test(address)) throw new Error(`Invalid SSH target: ${target}`);
  return { host: address, username, port };
}

/**
 * Resolves destination argument into a HostProfile
 */
export function resolveTarget(target: string, options: ConnectCliOptions = {}): HostProfile {
  const envPassword = process.env.SSH_PASSWORD;
  const requestedPort = options.port === undefined ? undefined : parsePort(options.port);
  const password = options.password ?? envPassword;

  // 1. Direct match: check if target matches existing profile name, id, or host
  let existing = defaultConfigManager.getHost(target);

  // 2. Check if target is in [user@]profile format
  let userPrefix: string | undefined;
  if (!existing && target.includes('@') && !target.includes(':')) {
    const atIdx = target.indexOf('@');
    userPrefix = target.slice(0, atIdx);
    const profileName = target.slice(atIdx + 1);
    existing = defaultConfigManager.getHost(profileName);
  }

  if (existing) {
    const port = requestedPort ?? existing.port;
    const username = options.user ?? userPrefix ?? existing.username;
    const changedEndpoint = port !== existing.port || username !== existing.username;
    const keyPath = options.identity ?? (changedEndpoint || options.password !== undefined ? undefined : existing.privateKeyPath);
    const resolvedPassword = options.password ?? (changedEndpoint || options.identity ? undefined : existing.password) ?? envPassword;
    return {
      ...existing,
      port,
      username,
      privateKeyPath: keyPath ? resolvePortablePath(keyPath, defaultConfigManager.getConfigDir()) : undefined,
      privateKey: changedEndpoint || options.identity || options.password !== undefined ? undefined : existing.privateKey,
      passphrase: changedEndpoint || options.identity || options.password !== undefined ? undefined : existing.passphrase,
      password: resolvedPassword,
      authType: options.password !== undefined ? 'password' : (options.identity ? 'privateKey' : (changedEndpoint ? 'password' : existing.authType)),
      proxyJump: options.jump ?? (changedEndpoint ? undefined : existing.proxyJump),
      proxyCommand: changedEndpoint ? undefined : existing.proxyCommand
    };
  }

  // Check if target looks like an explicit address vs mistyped profile name
  const isExplicitAddress =
    target.includes('@') ||
    target.includes(':') ||
    target.includes('.') ||
    target.toLowerCase() === 'localhost' ||
    Boolean(options.user || requestedPort || options.identity || options.password);

  const allHosts = defaultConfigManager.getHosts();

  if (!isExplicitAddress && allHosts.length > 0) {
    const suggestions = defaultConfigManager.suggestHosts(target);
    throw new TargetNotFoundError(target, suggestions, allHosts);
  }

  // Parse [user@]hostname[:port], [user@][IPv6][:port], or a bare IPv6 address.
  const address = parseAddress(target);
  const username = options.user ?? address.username ?? os.userInfo().username ?? 'root';
  const host = address.host;
  const port = requestedPort ?? address.port ?? 22;

  const defaultKey = path.join(os.homedir(), '.ssh', 'id_ed25519');
  const defaultRsa = path.join(os.homedir(), '.ssh', 'id_rsa');
  let privateKeyPath = options.identity;
  if (!privateKeyPath && !password) {
    if (fs.existsSync(defaultKey)) privateKeyPath = defaultKey;
    else if (fs.existsSync(defaultRsa)) privateKeyPath = defaultRsa;
  }

  if (privateKeyPath) {
    privateKeyPath = resolvePortablePath(privateKeyPath, defaultConfigManager.getConfigDir());
  }

  return {
    id: `temp_${Date.now()}`,
    name: target,
    host,
    port,
    username,
    authType: password ? 'password' : (privateKeyPath ? 'privateKey' : 'password'),
    password,
    privateKeyPath,
    proxyJump: options.jump
  };
}

export interface RunConnectOptions extends ConnectCliOptions {
  noExitOnError?: boolean;
}

export async function runConnect(target: string, options: RunConnectOptions = {}): Promise<void> {
  let profile: HostProfile;
  try {
    profile = resolveTarget(target, options);
  } catch (err) {
    if (err instanceof TargetNotFoundError) {
      process.stderr.write(`${colors.red}Error: ${err.message}${colors.reset}\n`);
      if (options.noExitOnError) throw err;
      process.exit(1);
    }
    throw err;
  }

  // Prompt only when this connection has no stored or supplied password.
  if (!profile.password && profile.authType !== 'agent' && profile.authType !== 'privateKey') {
    profile.password = await prompt(`${colors.cyan}${profile.username}@${profile.host}'s password: ${colors.reset}`, true);
  }

  process.stdout.write(`${colors.dim}Connecting to ${colors.reset}${colors.bold}${profile.username}@${profile.host}:${profile.port}${colors.reset}...\n`);

  const connection = new SSHConnection({ profile });
  const tm = new TunnelManager(connection.getRawClient());

  try {
    await connection.connect();
    process.stdout.write(`${colors.green}✓ Connected successfully.${colors.reset}\n`);

    // Setup tunnels if requested
    if (options.localForward) {
      for (const spec of options.localForward) {
        const tunnelConfig = parsePortForwardString(spec, 'local');
        const tunnel = await tm.addTunnel(tunnelConfig);
        await tunnel.start();
        process.stdout.write(`${colors.green}✓ Forwarding local port ${tunnelConfig.localPort} -> ${tunnelConfig.remoteHost}:${tunnelConfig.remotePort}${colors.reset}\n`);
      }
    }

    if (options.remoteForward) {
      for (const spec of options.remoteForward) {
        const tunnelConfig = parsePortForwardString(spec, 'remote');
        const tunnel = await tm.addTunnel(tunnelConfig);
        await tunnel.start();
        process.stdout.write(`${colors.green}✓ Forwarding remote port ${tunnelConfig.remotePort} -> local ${tunnelConfig.localPort}${colors.reset}\n`);
      }
    }

    if (options.dynamicForward) {
      for (const spec of options.dynamicForward) {
        const tunnelConfig = parsePortForwardString(spec, 'dynamic');
        const tunnel = await tm.addTunnel(tunnelConfig);
        await tunnel.start();
        process.stdout.write(`${colors.green}✓ SOCKS5 proxy active on 127.0.0.1:${tunnelConfig.localPort}${colors.reset}\n`);
      }
    }

    // Launch interactive split-pane session (Shell + Right monitor dashboard)
    const splitSession = new SplitSession(connection.getRawClient(), {
      enableSidebar: options.sidebar,
      recordFilePath: options.record
    });

    await splitSession.start();
    const session = splitSession.getSession();
    if (session.running()) {
      await new Promise<void>((resolve) => {
        session.once('close', () => resolve());
        splitSession.attachToLocalProcess();
      });
    }
  } catch (err) {
    process.stderr.write(`${colors.red}Connection failed: ${errorMessage(err)}${colors.reset}\n`);
    if (options.noExitOnError) {
      throw err;
    }
    process.exitCode = 1;
    return;
  } finally {
    connection.disconnect();
    await tm.stopAll();
  }
  process.stdout.write(`\n${colors.dim}Connection closed.${colors.reset}\n`);
}
