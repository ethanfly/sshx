import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultConfigManager, HostProfile, resolvePortablePath } from '../core/config.js';
import { SSHConnection } from '../core/client.js';
import { InteractiveSession } from '../core/session.js';
import { TunnelManager, parsePortForwardString } from '../core/tunnel.js';
import { colors, prompt } from './utils.js';

export interface ConnectCliOptions {
  port?: number | string;
  user?: string;
  identity?: string;
  password?: string;
  jump?: string;
  record?: string;
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

/**
 * Resolves destination argument into a HostProfile
 */
export function resolveTarget(target: string, options: ConnectCliOptions = {}): HostProfile {
  const envPassword = process.env.SSH_PASSWORD;
  const password = options.password || envPassword;

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
    const keyPath = options.identity || existing.privateKeyPath;
    const resolvedPassword = options.password || existing.password || envPassword;
    return {
      ...existing,
      port: options.port ? Number(options.port) : existing.port,
      username: options.user || userPrefix || existing.username,
      privateKeyPath: keyPath ? resolvePortablePath(keyPath, defaultConfigManager.getConfigDir()) : undefined,
      password: resolvedPassword,
      authType: options.password ? 'password' : (options.identity ? 'privateKey' : existing.authType),
      proxyJump: options.jump || existing.proxyJump
    };
  }

  // Check if target looks like an explicit address vs mistyped profile name
  const isExplicitAddress =
    target.includes('@') ||
    target.includes(':') ||
    target.includes('.') ||
    target.toLowerCase() === 'localhost' ||
    Boolean(options.user || options.port || options.identity || options.password);

  const allHosts = defaultConfigManager.getHosts();

  if (!isExplicitAddress && allHosts.length > 0) {
    const suggestions = defaultConfigManager.suggestHosts(target);
    throw new TargetNotFoundError(target, suggestions, allHosts);
  }

  // Parse [user@]hostname[:port]
  let username = options.user || os.userInfo().username || 'root';
  let host = target;
  let port = options.port ? Number(options.port) : 22;

  if (host.includes('@')) {
    const parts = host.split('@');
    username = parts[0];
    host = parts[1];
  }

  if (host.includes(':')) {
    const parts = host.split(':');
    host = parts[0];
    port = Number(parts[1]) || 22;
  }

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

export async function runConnect(target: string, options: ConnectCliOptions = {}): Promise<void> {
  let profile: HostProfile;
  try {
    profile = resolveTarget(target, options);
  } catch (err: any) {
    if (err instanceof TargetNotFoundError) {
      process.stderr.write(`${colors.red}Error: ${err.message}${colors.reset}\n`);
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

  try {
    await connection.connect();
    process.stdout.write(`${colors.green}✓ Connected successfully.${colors.reset}\n`);

    // Setup tunnels if requested
    const tm = new TunnelManager(connection.getRawClient());

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

    // Launch interactive session
    const session = new InteractiveSession(connection.getRawClient(), {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      recordFilePath: options.record
    });

    await session.start();
    session.attachToLocalProcess();

    await new Promise<void>((resolve) => {
      session.once('close', () => resolve());
    });

    await tm.stopAll();
    connection.disconnect();
    process.stdout.write(`\n${colors.dim}Connection closed.${colors.reset}\n`);
  } catch (err: any) {
    connection.disconnect();
    process.stderr.write(`${colors.red}Connection failed: ${err.message || String(err)}${colors.reset}\n`);
    const suggestions = defaultConfigManager.suggestHosts(target);
    if (suggestions.length > 0) {
      process.stderr.write(`\n${colors.yellow}Did you mean one of your configured hosts?${colors.reset}\n`);
      for (const s of suggestions) {
        process.stderr.write(`  ${colors.cyan}• ${s.name}${colors.reset} (${s.username}@${s.host}:${s.port})\n`);
      }
    }
    process.exit(1);
  }
}
