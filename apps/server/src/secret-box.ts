import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Shared AES-256-GCM secret box for server-only provider credentials
 * (Swiggy bearer tokens, PKCE code verifiers, dynamic client secrets).
 *
 * The envelope is `v1.<iv>.<authTag>.<ciphertext>`, base64url-encoded. The
 * key is server-only, must decode from base64 to exactly 32 bytes, and must
 * never be logged or embedded in any client bundle (issue 07, AC#7).
 */

/** Decode and validate a base64-encoded 32-byte encryption key. */
export function decodeSecretKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('Encryption key must be a base64-encoded 32-byte key.');
  }
  return key;
}

/** Encrypt a credential into the versioned envelope. */
export function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a credential from the versioned envelope. Throws when the envelope
 * is malformed, the key has changed, or the ciphertext was tampered with;
 * callers must fail closed (treat the credential as absent), never log it.
 */
export function decryptSecret(value: string, key: Buffer): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('Stored credential has an unsupported encryption envelope.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
