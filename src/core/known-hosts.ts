import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export interface KnownHostEntry {
  host: string;
  keyType: string;
  publicKey: string;
  comment?: string;
  line: number;
}

export type StrictHostKeyChecking = 'yes' | 'no' | 'accept-new';

export class KnownHostsManager {
  private knownHostsPath: string;

  constructor(customPath?: string) {
    if (customPath) {
      this.knownHostsPath = customPath;
    } else {
      const sshDir = path.join(os.homedir(), '.ssh');
      if (fs.existsSync(sshDir)) {
        this.knownHostsPath = path.join(sshDir, 'known_hosts');
      } else {
        const sshxDir = path.join(os.homedir(), '.sshx');
        if (!fs.existsSync(sshxDir)) {
          fs.mkdirSync(sshxDir, { recursive: true, mode: 0o700 });
        }
        this.knownHostsPath = path.join(sshxDir, 'known_hosts');
      }
    }
  }

  public getFilePath(): string {
    return this.knownHostsPath;
  }

  public getEntries(): KnownHostEntry[] {
    if (!fs.existsSync(this.knownHostsPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.knownHostsPath, 'utf8');
      const lines = content.split('\n');
      const entries: KnownHostEntry[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
          // Format 1: host keyType base64 [comment]
          // Format 2: host,ip keyType base64 [comment]
          // Format 3: |1|hash|salt keyType base64 [comment] (hashed host)
          if (parts[0].startsWith('|1|')) {
            entries.push({
              host: parts[0],
              keyType: parts[1],
              publicKey: parts[2] || '',
              comment: parts.slice(3).join(' ') || undefined,
              line: i + 1
            });
          } else {
            entries.push({
              host: parts[0],
              keyType: parts[1],
              publicKey: parts[2] || '',
              comment: parts.slice(3).join(' ') || undefined,
              line: i + 1
            });
          }
        }
      }
      return entries;
    } catch {
      return [];
    }
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
    const hostIdent = port === 22 ? host : `[${host}]:${port}`;

    if (mode === 'no') {
      return {
        status: 'trusted',
        fingerprint,
        message: 'Host key checking disabled'
      };
    }

    const entries = this.getEntries();
    const matchingEntries = entries.filter(e => {
      const hosts = e.host.split(',');
      if (port === 22) {
        return hosts.includes(hostIdent) || hosts.includes(host) || this.matchesHashedHost(e.host, hostIdent);
      } else {
        return hosts.includes(hostIdent) || this.matchesHashedHost(e.host, hostIdent);
      }
    });

    if (matchingEntries.length === 0) {
      if (mode === 'accept-new') {
        this.addHostKey(hostIdent, keyType, keyBase64);
        return {
          status: 'new',
          fingerprint,
          message: `Permanently added '${hostIdent}' (${keyType}) to the list of known hosts.`
        };
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

    return {
      status: 'mismatch',
      fingerprint,
      message: `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED for '${hostIdent}'! IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!`
    };
  }

  public addHostKey(hostIdent: string, keyType: string, keyBase64: string): void {
    const line = `${hostIdent} ${keyType} ${keyBase64}\n`;
    try {
      const dir = path.dirname(this.knownHostsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.appendFileSync(this.knownHostsPath, line, { mode: 0o644 });
    } catch {
      // Ignore write errors if permissions fail
    }
  }

  public computeFingerprint(keyBuffer: Buffer): string {
    const hash = crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
    return `SHA256:${hash}`;
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
