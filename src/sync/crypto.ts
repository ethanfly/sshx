import crypto from 'node:crypto';
import { z } from 'zod';

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

const scryptOptions = { N: 16384, r: 8, p: 1 } as const;
const encryptedPayloadSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal('aes-256-gcm'),
  kdf: z.literal('scrypt'),
  salt: z.string().regex(/^[\da-f]{32}$/i),
  iv: z.string().regex(/^[\da-f]{24}$/i),
  tag: z.string().regex(/^[\da-f]{32}$/i),
  ciphertext: z.string().regex(/^(?:[\da-f]{2})*$/i),
  updatedAt: z.string(),
  itemCount: z.number().int().nonnegative().optional()
});

function requirePassphrase(passphrase: string): void {
  if (!passphrase || passphrase.length < 4) {
    throw new Error('Passphrase must be at least 4 characters long.');
  }
}

function createPayload(plaintext: string, key: Buffer, salt: Buffer, itemCount?: number): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  const payload: EncryptedPayload = {
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    updatedAt: new Date().toISOString(),
    itemCount
  };
  return JSON.stringify(payload, null, 2);
}

function parsePayload(encryptedJson: string): EncryptedPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(encryptedJson);
  } catch {
    throw new Error('Invalid encrypted payload format: expected JSON.');
  }
  const result = encryptedPayloadSchema.safeParse(raw);
  if (!result.success) {
    throw new Error('Invalid or unsupported encrypted payload format.');
  }
  return result.data;
}

function decryptWithKey(payload: EncryptedPayload, key: Buffer): { plaintext: string; payload: EncryptedPayload } {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'hex')),
      decipher.final()
    ]).toString('utf8');
    return { plaintext, payload };
  } catch {
    throw new Error('Decryption failed. Incorrect passphrase or corrupted encrypted data.');
  }
}

function deriveKeyAsync(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, scryptOptions, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Encrypt plaintext data using AES-256-GCM with a user-supplied passphrase.
 * Key derivation uses scrypt with a unique random salt per encryption.
 */
export function encryptPayload(plaintext: string, passphrase: string, itemCount?: number): string {
  requirePassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  return createPayload(plaintext, crypto.scryptSync(passphrase, salt, 32, scryptOptions), salt, itemCount);
}

/** Derive the encryption key off the event loop for cloud sync. */
export async function encryptPayloadAsync(plaintext: string, passphrase: string, itemCount?: number): Promise<string> {
  requirePassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  return createPayload(plaintext, await deriveKeyAsync(passphrase, salt), salt, itemCount);
}

/**
 * Decrypt an AES-256-GCM encrypted payload back into plaintext string.
 * Throws friendly error on incorrect passphrase or tampered data.
 */
export function decryptPayload(encryptedJson: string, passphrase: string): { plaintext: string; payload: EncryptedPayload } {
  if (!passphrase) {
    throw new Error('Passphrase is required to decrypt.');
  }
  const payload = parsePayload(encryptedJson);
  const key = crypto.scryptSync(passphrase, Buffer.from(payload.salt, 'hex'), 32, scryptOptions);
  return decryptWithKey(payload, key);
}

/** Decrypt without blocking the event loop during key derivation. */
export async function decryptPayloadAsync(encryptedJson: string, passphrase: string): Promise<{ plaintext: string; payload: EncryptedPayload }> {
  if (!passphrase) throw new Error('Passphrase is required to decrypt.');
  const payload = parsePayload(encryptedJson);
  const key = await deriveKeyAsync(passphrase, Buffer.from(payload.salt, 'hex'));
  return decryptWithKey(payload, key);
}
