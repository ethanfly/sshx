import crypto from 'node:crypto';

export interface EncryptedPayload {
  version: 1;
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  salt: string; // hex
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
  updatedAt: string; // ISO 8601
  itemCount?: number;
}

/**
 * Encrypt plaintext data using AES-256-GCM with a user-supplied passphrase.
 * Key derivation uses scrypt with a unique random salt per encryption.
 */
export function encryptPayload(plaintext: string, passphrase: string, itemCount?: number): string {
  if (!passphrase || passphrase.length < 4) {
    throw new Error('Passphrase must be at least 4 characters long.');
  }

  const salt = crypto.randomBytes(16);
  // scrypt: N=16384, r=8, p=1, keylen=32
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const iv = crypto.randomBytes(12); // standard 96-bit IV for AES-GCM

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    updatedAt: new Date().toISOString(),
    itemCount
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Decrypt an AES-256-GCM encrypted payload back into plaintext string.
 * Throws friendly error on incorrect passphrase or tampered data.
 */
export function decryptPayload(encryptedJson: string, passphrase: string): { plaintext: string; payload: EncryptedPayload } {
  if (!passphrase) {
    throw new Error('Passphrase is required to decrypt.');
  }

  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(encryptedJson);
  } catch {
    throw new Error('Invalid encrypted payload format: expected JSON.');
  }

  if (payload.version !== 1 || payload.algorithm !== 'aes-256-gcm') {
    throw new Error(`Unsupported encryption version or algorithm: ${payload.algorithm || 'unknown'}`);
  }

  try {
    const salt = Buffer.from(payload.salt, 'hex');
    const iv = Buffer.from(payload.iv, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');
    const ciphertext = Buffer.from(payload.ciphertext, 'hex');

    const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString('utf8');

    return { plaintext, payload };
  } catch (err: any) {
    throw new Error('Decryption failed. Incorrect passphrase or corrupted encrypted data.');
  }
}
