import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface KeyPairResult {
  publicKeyOpenSSH: string;
  privateKeyPem: string;
  fingerprintSha256: string;
  keyType: 'ed25519' | 'rsa';
  bits?: number;
}

export interface GeneratedKeyFiles {
  privateKeyPath: string;
  publicKeyPath: string;
  fingerprintSha256: string;
}

export interface StoredKeyInfo {
  name: string;
  path: string;
  publicKeyPath?: string;
  type: string;
  fingerprint?: string;
  comment?: string;
}

export class KeyManager {
  /**
   * Generates a new SSH keypair (Ed25519 or RSA)
   */
  public static generateKeyPair(options: {
    type?: 'ed25519' | 'rsa';
    bits?: number;
    comment?: string;
    passphrase?: string;
  }): KeyPairResult {
    const keyType = options.type || 'ed25519';
    const comment = options.comment || `${os.userInfo().username}@${os.hostname()}`;

    if (keyType === 'ed25519') {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: {
          type: 'spki',
          format: 'der'
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
          cipher: options.passphrase ? 'aes-256-cbc' : undefined,
          passphrase: options.passphrase
        }
      });

      // Extract raw 32 bytes ed25519 public key from SPKI DER (last 32 bytes)
      const rawPub = publicKey.subarray(publicKey.length - 32);
      const wireBuffer = encodeSshWire(['ssh-ed25519', rawPub]);
      const publicKeyOpenSSH = `ssh-ed25519 ${wireBuffer.toString('base64')} ${comment}`.trim();
      const fingerprintSha256 = `SHA256:${crypto.createHash('sha256').update(wireBuffer).digest('base64').replace(/=+$/, '')}`;

      return {
        publicKeyOpenSSH,
        privateKeyPem: privateKey,
        fingerprintSha256,
        keyType: 'ed25519'
      };
    } else {
      const modulusLength = options.bits || 3072;
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength,
        publicKeyEncoding: {
          type: 'pkcs1',
          format: 'der'
        },
        privateKeyEncoding: {
          type: 'pkcs1',
          format: 'pem',
          cipher: options.passphrase ? 'aes-256-cbc' : undefined,
          passphrase: options.passphrase
        }
      });

      // Parse PKCS#1 RSAPublicKey DER: Sequence of (n: INTEGER, e: INTEGER)
      const { n, e } = parseRsaPkcs1Der(publicKey);
      const wireBuffer = encodeSshWire(['ssh-rsa', e, n]);
      const publicKeyOpenSSH = `ssh-rsa ${wireBuffer.toString('base64')} ${comment}`.trim();
      const fingerprintSha256 = `SHA256:${crypto.createHash('sha256').update(wireBuffer).digest('base64').replace(/=+$/, '')}`;

      return {
        publicKeyOpenSSH,
        privateKeyPem: privateKey,
        fingerprintSha256,
        keyType: 'rsa',
        bits: modulusLength
      };
    }
  }

  /**
   * Generates and writes key files to disk with strict permissions
   */
  public static saveKeyPairToDisk(
    outputFilePath: string,
    options: {
      type?: 'ed25519' | 'rsa';
      bits?: number;
      comment?: string;
      passphrase?: string;
    }
  ): GeneratedKeyFiles {
    const result = this.generateKeyPair(options);
    const resolvedPath = path.resolve(outputFilePath);
    const pubPath = `${resolvedPath}.pub`;

    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    fs.writeFileSync(resolvedPath, result.privateKeyPem, { mode: 0o600 });
    fs.writeFileSync(pubPath, `${result.publicKeyOpenSSH}\n`, { mode: 0o644 });

    return {
      privateKeyPath: resolvedPath,
      publicKeyPath: pubPath,
      fingerprintSha256: result.fingerprintSha256
    };
  }

  /**
   * List keys available in ~/.ssh and ~/.sshx/keys
   */
  public static listAvailableKeys(additionalDir?: string): StoredKeyInfo[] {
    const dirs = [
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.sshx', 'keys')
    ];
    if (additionalDir && !dirs.includes(additionalDir)) {
      dirs.push(additionalDir);
    }

    const keys: StoredKeyInfo[] = [];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.pub') || file === 'known_hosts' || file === 'config' || file === 'authorized_keys') {
            continue;
          }

          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) continue;

          // Check if it's a private key
          try {
            const head = fs.readFileSync(fullPath, 'utf8').slice(0, 100);
            if (head.includes('BEGIN') && head.includes('PRIVATE KEY')) {
              const pubPath = `${fullPath}.pub`;
              let type = 'unknown';
              let comment: string | undefined;
              let fingerprint: string | undefined;

              if (head.includes('ED25519')) type = 'ed25519';
              else if (head.includes('RSA')) type = 'rsa';
              else if (head.includes('OPENSSH')) type = 'openssh';

              if (fs.existsSync(pubPath)) {
                try {
                  const pubContent = fs.readFileSync(pubPath, 'utf8').trim();
                  const parts = pubContent.split(/\s+/);
                  if (parts.length >= 2) {
                    type = parts[0].replace(/^ssh-/, '');
                    comment = parts.slice(2).join(' ') || undefined;
                    const wireBuffer = Buffer.from(parts[1], 'base64');
                    fingerprint = `SHA256:${crypto.createHash('sha256').update(wireBuffer).digest('base64').replace(/=+$/, '')}`;
                  }
                } catch {
                  // ignore
                }
              }

              keys.push({
                name: file,
                path: fullPath,
                publicKeyPath: fs.existsSync(pubPath) ? pubPath : undefined,
                type,
                comment,
                fingerprint
              });
            }
          } catch {
            // ignore unreadable files
          }
        }
      } catch {
        // ignore dir read errors
      }
    }

    return keys;
  }
}

/**
 * Encode SSH wire format values: string / buffer / mpint
 */
function encodeSshWire(items: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [];

  for (const item of items) {
    if (typeof item === 'string') {
      const buf = Buffer.from(item, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buf.length, 0);
      parts.push(len, buf);
    } else {
      // Buffer / mpint: if first bit is 1, prepend 0x00 for positive signed integer
      let buf = item;
      if (buf.length > 0 && buf[0] & 0x80) {
        buf = Buffer.concat([Buffer.from([0x00]), buf]);
      }
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buf.length, 0);
      parts.push(len, buf);
    }
  }

  return Buffer.concat(parts);
}

/**
 * Minimal ASN.1 DER parser for PKCS#1 RSA public key (Sequence { modulus: INTEGER, publicExponent: INTEGER })
 */
function parseRsaPkcs1Der(der: Buffer): { n: Buffer; e: Buffer } {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('Invalid PKCS#1 RSA public key: expected SEQUENCE');

  // Skip sequence length
  let len = der[offset++];
  if (len & 0x80) {
    const numBytes = len & 0x7f;
    offset += numBytes;
  }

  // Modulus INTEGER
  if (der[offset++] !== 0x02) throw new Error('Invalid PKCS#1: expected INTEGER for modulus');
  let nLen = der[offset++];
  if (nLen & 0x80) {
    const numBytes = nLen & 0x7f;
    nLen = 0;
    for (let i = 0; i < numBytes; i++) {
      nLen = (nLen << 8) | der[offset++];
    }
  }
  let n = der.subarray(offset, offset + nLen);
  // Strip leading 0x00 if present
  if (n.length > 0 && n[0] === 0x00) {
    n = n.subarray(1);
  }
  offset += nLen;

  // Exponent INTEGER
  if (der[offset++] !== 0x02) throw new Error('Invalid PKCS#1: expected INTEGER for exponent');
  let eLen = der[offset++];
  if (eLen & 0x80) {
    const numBytes = eLen & 0x7f;
    eLen = 0;
    for (let i = 0; i < numBytes; i++) {
      eLen = (eLen << 8) | der[offset++];
    }
  }
  let e = der.subarray(offset, offset + eLen);
  if (e.length > 0 && e[0] === 0x00) {
    e = e.subarray(1);
  }

  return { n, e };
}
