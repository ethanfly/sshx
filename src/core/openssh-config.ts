import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePortablePath, toPortablePath } from './config-paths.js';
import type { HostProfile } from './config.js';

/**
 * Parses OpenSSH config file resolving Include directives
 */
export function parseOpenSSHConfigFile(filePath: string, visited: Set<string> = new Set()): Array<Omit<HostProfile, 'id'>> {
  const resolvedPath = resolvePortablePath(filePath);
  if (visited.has(resolvedPath) || !fs.existsSync(resolvedPath)) {
    return [];
  }
  visited.add(resolvedPath);

  const baseDir = path.dirname(resolvedPath);
  const content = fs.readFileSync(resolvedPath, 'utf8');
  return parseOpenSSHConfigContents(content, value => {
    const includePattern = value.startsWith('/') || value.startsWith('~')
      ? resolvePortablePath(value)
      : path.resolve(baseDir, value);
    const includeDir = path.dirname(includePattern);
    const filePattern = path.basename(includePattern);
    if (!fs.existsSync(includeDir)) return [];

    const regex = new RegExp(`^${filePattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const hosts: Array<Omit<HostProfile, 'id'>> = [];
    for (const entry of fs.readdirSync(includeDir).sort()) {
      if (!regex.test(entry)) continue;
      const fullPath = path.join(includeDir, entry);
      if (fs.statSync(fullPath).isFile()) hosts.push(...parseOpenSSHConfigFile(fullPath, visited));
    }
    return hosts;
  });
}

/**
 * Parses OpenSSH ~/.ssh/config format string
 */
export function parseOpenSSHConfig(content: string): Array<Omit<HostProfile, 'id'>> {
  return parseOpenSSHConfigContents(content);
}

function parseOpenSSHConfigContents(
  content: string,
  include?: (pattern: string) => Array<Omit<HostProfile, 'id'>>
): Array<Omit<HostProfile, 'id'>> {
  const lines = content.split('\n');
  const hosts: Array<Omit<HostProfile, 'id'>> = [];
  let currentHost: Partial<HostProfile> | null = null;

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const keyword = parts[0].toLowerCase();
    const value = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');

    if (keyword === 'include') {
      if (include) hosts.push(...include(value));
    } else if (keyword === 'host') {
      if (currentHost && currentHost.name && currentHost.name !== '*') {
        finalizeHost(currentHost, hosts);
      }
      currentHost = {
        name: value,
        host: value,
        port: 22,
        username: os.userInfo().username || 'root',
        authType: 'privateKey',
        tags: ['imported-ssh-config']
      };
    } else if (currentHost) {
      switch (keyword) {
        case 'hostname':
          currentHost.host = value;
          break;
        case 'user':
          currentHost.username = value;
          break;
        case 'port':
          currentHost.port = parseInt(value, 10) || 22;
          break;
        case 'identityfile':
          currentHost.privateKeyPath = toPortablePath(value);
          currentHost.authType = 'privateKey';
          break;
        case 'preferredauthentications':
          if (value.toLowerCase().startsWith('password')) currentHost.authType = 'password';
          break;
        case 'proxyjump':
          currentHost.proxyJump = value;
          break;
        case 'proxycommand':
          currentHost.proxyCommand = value;
          break;
        case 'serveraliveinterval':
          currentHost.keepaliveInterval = (parseInt(value, 10) || 15) * 1000;
          break;
        case 'serveralivecountmax':
          currentHost.keepaliveCountMax = parseInt(value, 10) || 3;
          break;
      }
    }
  }

  if (currentHost && currentHost.name && currentHost.name !== '*') {
    finalizeHost(currentHost, hosts);
  }

  return hosts;
}

function finalizeHost(host: Partial<HostProfile>, list: Array<Omit<HostProfile, 'id'>>) {
  if (!host.name || host.name.includes('*') || host.name.includes('?')) return;
  list.push({
    name: host.name,
    host: host.host || host.name,
    port: host.port || 22,
    username: host.username || os.userInfo().username || 'root',
    authType: host.authType || 'privateKey',
    privateKeyPath: host.privateKeyPath,
    proxyJump: host.proxyJump,
    proxyCommand: host.proxyCommand,
    keepaliveInterval: host.keepaliveInterval,
    keepaliveCountMax: host.keepaliveCountMax,
    tags: host.tags || ['imported-ssh-config']
  });
}
