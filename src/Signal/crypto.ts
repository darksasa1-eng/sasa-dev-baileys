import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { DecryptionError } from '../Defaults/errors';

/**
 * Symmetric crypto primitives (all native Node, audited FIPS-capable paths).
 */

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function md5(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(data).digest());
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

export interface HKDFOptions {
  salt?: Uint8Array;
  info?: string | Uint8Array;
}

const ZERO_SALT_32 = new Uint8Array(32);

/** RFC 5869 HKDF-SHA256 key expansion */
export function hkdf(ikm: Uint8Array, size: number, opts: HKDFOptions = {}): Uint8Array {
  const salt = opts.salt ?? ZERO_SALT_32;
  const info = typeof opts.info === 'string' ? Buffer.from(opts.info, 'utf-8') : (opts.info ?? Buffer.alloc(0));
  return new Uint8Array(hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(info), size));
}

/** AES-256-CBC with PKCS#7 padding (Node default) */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error('aesCbcEncrypt: key must be 32 bytes');
  if (iv.byteLength !== 16) throw new Error('aesCbcEncrypt: iv must be 16 bytes');
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]));
}

export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new DecryptionError('aesCbcDecrypt: key must be 32 bytes');
  if (iv.byteLength !== 16) throw new DecryptionError('aesCbcDecrypt: iv must be 16 bytes');
  try {
    const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(iv));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
  } catch (err) {
    throw new DecryptionError('aesCbcDecrypt: invalid ciphertext or key', { cause: err });
  }
}

/**
 * AES-256-GCM. Output layout: `ciphertext || 16-byte auth tag`
 * (single buffer, mirroring the framing used by the Noise handshake).
 */
export function aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error('aesGcmEncrypt: key must be 32 bytes');
  if (iv.byteLength !== 12) throw new Error('aesGcmEncrypt: iv must be 12 bytes');
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
  if (aad) cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return new Uint8Array(Buffer.concat([enc, cipher.getAuthTag()]));
}

export function aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertextAndTag: Uint8Array, aad?: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new DecryptionError('aesGcmDecrypt: key must be 32 bytes');
  if (iv.byteLength !== 12) throw new DecryptionError('aesGcmDecrypt: iv must be 12 bytes');
  if (ciphertextAndTag.byteLength < 16) throw new DecryptionError('aesGcmDecrypt: frame shorter than auth tag');
  const data = ciphertextAndTag.subarray(0, ciphertextAndTag.byteLength - 16);
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.byteLength - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(iv));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag));
    return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]));
  } catch (err) {
    throw new DecryptionError('aesGcmDecrypt: authentication failed (bad tag)', { cause: err });
  }
}
