import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface KnownHostEntry {
  /** Set for `@cert-authority` and `@revoked` lines */
  marker?: KnownHostMarker;
  host: string;
  keyType: string;
  publicKey: string;
  comment?: string;
  line: number;
}

export type KnownHostMarker = 'cert-authority' | 'revoked';

export type StrictHostKeyChecking = 'yes' | 'no' | 'accept-new';

export class KnownHostsManager {
  private knownHostsPath: string;

  constructor(customPath?: string) {
    this.knownHostsPath = customPath || defaultKnownHostsPath();
  }

  public getFilePath(): string {
    return this.knownHostsPath;
  }

  public getEntries(): KnownHostEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(this.knownHostsPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Could not read known hosts file '${this.knownHostsPath}': ${(error as Error).message}`);
    }

    const lines = content.split('\n');
    const entries: KnownHostEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(/\s+/);
      let marker: KnownHostMarker | undefined;
      if (parts[0].startsWith('@')) {
        const name = parts.shift()!.slice(1);
        if (name !== 'cert-authority' && name !== 'revoked') continue;
        marker = name;
      }
      if (parts.length >= 2) {
        entries.push({
          marker,
          host: parts[0],
          keyType: parts[1],
          publicKey: parts[2] || '',
          comment: parts.slice(3).join(' ') || undefined,
          line: i + 1
        });
      }
    }
    return entries;
  }

  /**
   * Extract key type from raw SSH wire format public key buffer
   */
  public extractKeyType(keyBuffer: Buffer): string {
    if (Buffer.isBuffer(keyBuffer) && keyBuffer.length >= 4) {
      try {
        const typeLen = keyBuffer.readUInt32BE(0);
        if (typeLen > 0 && 4 + typeLen <= keyBuffer.length) {
          const type = keyBuffer.subarray(4, 4 + typeLen).toString('utf8');
          if (/^[a-zA-Z0-9@.-]+$/.test(type)) {
            return type;
          }
        }
      } catch {
        // Fallback
      }
    }
    return 'ssh-rsa';
  }

  /**
   * Verify a host key against known_hosts
   */
  public verifyHostKey(
    host: string,
    port: number,
    keyType: string,
    keyBuffer: Buffer,
    mode: StrictHostKeyChecking = 'accept-new'
  ): { status: 'trusted' | 'new' | 'mismatch'; fingerprint: string; message: string } {
    const keyBase64 = keyBuffer.toString('base64');
    const fingerprint = this.computeFingerprint(keyBuffer);
    // OpenSSH lowercases host names before matching, hashing and recording them.
    const hostName = host.toLowerCase();
    const hostIdent = port === 22 ? hostName : `[${hostName}]:${port}`;

    if (mode === 'no') {
      return {
        status: 'trusted',
        fingerprint,
        message: 'Host key checking disabled'
      };
    }

    const hostEntries = this.getEntries().filter(e => this.matchesHost(e.host, hostIdent));
    if (hostEntries.some(e => e.marker === 'revoked' && e.publicKey === keyBase64)) {
      return {
        status: 'mismatch',
        fingerprint,
        message: `Host key for '${hostIdent}' has been revoked in ${this.knownHostsPath}.`
      };
    }
    // Certificate authorities sign host certificates; they never match a plain host key.
    const matchingEntries = hostEntries.filter(e => !e.marker);

    if (matchingEntries.length === 0) {
      if (mode === 'accept-new') {
        return this.acceptNewHostKey(hostIdent, keyType, keyBase64, fingerprint);
      } else {
        return {
          status: 'mismatch',
          fingerprint,
          message: `Host key for '${hostIdent}' is not known and StrictHostKeyChecking=yes.`
        };
      }
    }

    const exactMatch = matchingEntries.find(e => e.publicKey === keyBase64);
    if (exactMatch) {
      return {
        status: 'trusted',
        fingerprint,
        message: 'Host key matched known_hosts'
      };
    }

    // If host was recorded under a different key type, but never under this keyType:
    // Under 'accept-new', accept and record this new key type for the host.
    const sameTypeEntries = matchingEntries.filter(e => e.keyType === keyType);
    if (sameTypeEntries.length === 0) {
      if (mode === 'accept-new') {
        return this.acceptNewHostKey(hostIdent, keyType, keyBase64, fingerprint);
      } else {
        return {
          status: 'mismatch',
          fingerprint,
          message: `Host key for '${hostIdent}' (${keyType}) is not known and StrictHostKeyChecking=yes.`
        };
      }
    }

    return {
      status: 'mismatch',
      fingerprint,
      message: `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for '${hostIdent}'! IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!`
    };
  }

  public addHostKey(hostIdent: string, keyType: string, keyBase64: string): void {
    fs.mkdirSync(path.dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.knownHostsPath, 'a+', 0o600);
    try {
      // A hand-edited file may lack its final newline; never glue the new key onto that entry.
      const { size } = fs.fstatSync(fd);
      const lastByte = Buffer.alloc(1);
      const separator = size > 0 && fs.readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a ? '\n' : '';
      fs.writeSync(fd, `${separator}${hostIdent} ${keyType} ${keyBase64}\n`);
    } finally {
      fs.closeSync(fd);
    }
  }

  private acceptNewHostKey(
    hostIdent: string,
    keyType: string,
    keyBase64: string,
    fingerprint: string
  ): { status: 'new' | 'mismatch'; fingerprint: string; message: string } {
    try {
      this.addHostKey(hostIdent, keyType, keyBase64);
      return {
        status: 'new',
        fingerprint,
        message: `Permanently added '${hostIdent}' (${keyType}) to the list of known hosts.`
      };
    } catch (error) {
      return {
        status: 'mismatch',
        fingerprint,
        message: `Could not persist the host key for '${hostIdent}': ${(error as Error).message}`
      };
    }
  }

  public computeFingerprint(keyBuffer: Buffer): string {
    const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
    return `SHA256:${hash}`;
  }

  /** OpenSSH host pattern lists: comma-separated, `*`/`?` wildcards, `!` negation, or one hashed name. */
  private matchesHost(patterns: string, hostIdent: string): boolean {
    if (patterns.startsWith('|')) return this.matchesHashedHost(patterns, hostIdent);
    let matched = false;
    for (const entry of patterns.toLowerCase().split(',')) {
      const negated = entry.startsWith('!');
      if (!matchesWildcard(hostIdent, negated ? entry.slice(1) : entry)) continue;
      if (negated) return false;
      matched = true;
    }
    return matched;
  }

  private matchesHashedHost(hashedEntry: string, host: string): boolean {
    if (!hashedEntry.startsWith('|1|')) return false;
    const parts = hashedEntry.split('|');
    if (parts.length < 4) return false;
    const saltBase64 = parts[2];
    const hashBase64 = parts[3];

    try {
      const salt = Buffer.from(saltBase64, 'base64');
      const hmac = crypto.createHmac('sha1', salt).update(host).digest('base64');
      return hmac === hashBase64;
    } catch {
      return false;
    }
  }
}

function defaultKnownHostsPath(): string {
  const sshDir = path.join(os.homedir(), '.ssh');
  if (fs.existsSync(sshDir)) return path.join(sshDir, 'known_hosts');
  return path.join(os.homedir(), '.sshx', 'known_hosts');
}

function matchesWildcard(value: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return value === pattern;
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(value);
}
