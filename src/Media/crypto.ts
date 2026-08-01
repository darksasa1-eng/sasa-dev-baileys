import { createDecipheriv, createCipheriv, createHash, createHmac } from 'node:crypto';
import { DecryptionError } from '../Defaults/errors';
import { hkdf, sha256 } from '../Signal/crypto';
import { randomBytes } from 'node:crypto';
import { getMediaHkdfInfo, type MediaType } from './media-type';

/**
 * Media encryption per the WhatsApp media-attachment scheme.
 *
 * Key expansion: HKDF-SHA256(mediaKey, 112, info='<category> Keys')
 *   iv (16) | cipherKey (32) | macKey (32) | refKey (32)
 *
 * Ciphertext: AES-256-CBC + PKCS7 over the file, with a 10-byte truncated
 * HMAC-SHA256(macKey, iv || ciphertext) appended.
 */

export interface ExpandedMediaKeys {
  iv: Uint8Array;
  cipherKey: Uint8Array;
  macKey: Uint8Array;
  refKey: Uint8Array;
  mediaKey: Uint8Array;
}

export function getMediaKeys(mediaKey: Uint8Array, mediaType: MediaType): ExpandedMediaKeys {
  const expanded = hkdf(mediaKey, 112, { info: getMediaHkdfInfo(mediaType) });
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
    refKey: expanded.subarray(80, 112),
    mediaKey,
  };
}

export interface EncryptedMediaResult {
  /** ciphertext || 10-byte MAC — the exact bytes uploaded */
  body: Uint8Array;
  fileSha256: Uint8Array;
  fileEncSha256: Uint8Array;
  fileLength: number;
  mediaKey: Uint8Array;
}

export function generateMediaKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

/** Encrypt a media buffer with a fresh (or given) mediaKey */
export function encryptMedia(
  plaintext: Uint8Array,
  mediaType: MediaType,
  mediaKey: Uint8Array = generateMediaKey(),
): EncryptedMediaResult {
  const keys = getMediaKeys(mediaKey, mediaType);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(keys.cipherKey), Buffer.from(keys.iv));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const mac = createHmac('sha256', Buffer.from(keys.macKey))
    .update(Buffer.from(keys.iv))
    .update(ciphertext)
    .digest()
    .subarray(0, 10);
  const body = Buffer.concat([ciphertext, mac]);
  return {
    body: new Uint8Array(body),
    fileSha256: sha256(plaintext),
    fileEncSha256: sha256(new Uint8Array(body)),
    fileLength: plaintext.byteLength,
    mediaKey,
  };
}

/**
 * Create a streaming media encrypter: hashes and transforms chunk-by-chunk
 * (single pass). Call `finalize()` to obtain the MAC suffix and hashes.
 *
 * Usage: for await chunk of source → update(chunk) → yield; then yield finalize().body.
 */
export function createMediaCipher(mediaType: MediaType, mediaKey: Uint8Array = generateMediaKey()) {
  const keys = getMediaKeys(mediaKey, mediaType);
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(keys.cipherKey), Buffer.from(keys.iv));
  const fileHash = createHash('sha256');
  const encHash = createHash('sha256');
  const mac = createHmac('sha256', Buffer.from(keys.macKey));
  mac.update(Buffer.from(keys.iv));
  let fileLength = 0;

  return {
    mediaKey,
    update(chunk: Uint8Array): Uint8Array {
      fileHash.update(chunk);
      fileLength += chunk.byteLength;
      const enc = cipher.update(Buffer.from(chunk));
      encHash.update(enc);
      mac.update(enc);
      return new Uint8Array(enc);
    },
    finalize(): {
      body: Uint8Array;
      fileSha256: Uint8Array;
      fileEncSha256: Uint8Array;
      fileLength: number;
      mediaKey: Uint8Array;
    } {
      const tail = cipher.final();
      encHash.update(tail);
      mac.update(tail);
      const macSuffix = mac.digest().subarray(0, 10);
      encHash.update(macSuffix);
      return {
        body: new Uint8Array(Buffer.concat([tail, macSuffix])),
        fileSha256: new Uint8Array(fileHash.digest()),
        fileEncSha256: new Uint8Array(encHash.digest()),
        fileLength,
        mediaKey,
      };
    },
  };
}

export interface DecryptedMediaResult {
  plaintext: Uint8Array;
  fileSha256: Uint8Array;
}

/** Decrypt media bytes (`ciphertext || 10-byte MAC`). Verifies MAC + optional fileSha256. */
export function decryptMedia(
  data: Uint8Array,
  mediaKey: Uint8Array,
  mediaType: MediaType,
  opts: { fileSha256?: Uint8Array } = {},
): DecryptedMediaResult {
  if (data.byteLength < 10) throw new DecryptionError('media: payload too short for MAC');
  const keys = getMediaKeys(mediaKey, mediaType);
  const ciphertext = data.subarray(0, data.byteLength - 10);
  const expectedMac = data.subarray(data.byteLength - 10);
  const actualMac = createHmac('sha256', Buffer.from(keys.macKey))
    .update(Buffer.from(keys.iv))
    .update(Buffer.from(ciphertext))
    .digest()
    .subarray(0, 10);
  if (!Buffer.from(actualMac).equals(Buffer.from(expectedMac))) {
    throw new DecryptionError('media: MAC verification failed', { data: { mediaType } });
  }
  let plaintext: Uint8Array;
  try {
    const decipher = createDecipheriv('aes-256-cbc', Buffer.from(keys.cipherKey), Buffer.from(keys.iv));
    plaintext = new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]));
  } catch (err) {
    throw new DecryptionError('media: AES decryption failed', { cause: err });
  }
  const fileSha256 = sha256(plaintext);
  if (opts.fileSha256 && !Buffer.from(fileSha256).equals(Buffer.from(opts.fileSha256))) {
    throw new DecryptionError('media: fileSha256 mismatch (tampered file)', { data: { mediaType } });
  }
  return { plaintext, fileSha256 };
}

/**
 * Create a streaming decryptor. MAC is verified incrementally (the last
 * chunks are withheld until `finalize()` — a failure there means the whole
 * stream must be discarded by the caller).
 */
export function createMediaDecipher(mediaKey: Uint8Array, mediaType: MediaType) {
  const keys = getMediaKeys(mediaKey, mediaType);
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(keys.cipherKey), Buffer.from(keys.iv));
  const fileHash = createHash('sha256');
  const mac = createHmac('sha256', Buffer.from(keys.macKey));
  mac.update(Buffer.from(keys.iv));
  // keep the tail so the MAC suffix never enters the plaintext stream
  let pending: Buffer = Buffer.alloc(0);

  const result = {
    update(chunk: Uint8Array): Uint8Array {
      const combined = Buffer.concat([pending, Buffer.from(chunk)]);
      // Always hold back (16-byte CBC block + 10-byte MAC) so the final
      // update is verifiable at finalize().
      const HOLD_BACK = 26;
      if (combined.byteLength <= HOLD_BACK) {
        pending = combined;
        return new Uint8Array(0);
      }
      const toProcess = combined.subarray(0, combined.byteLength - HOLD_BACK);
      const blocksLength = toProcess.byteLength - (toProcess.byteLength % 16);
      if (blocksLength === 0) {
        pending = combined;
        return new Uint8Array(0);
      }
      const blocks = combined.subarray(0, blocksLength);
      pending = combined.subarray(blocksLength);
      mac.update(blocks);
      const plain = decipher.update(blocks);
      fileHash.update(plain);
      return new Uint8Array(plain);
    },
    finalize(opts: { fileSha256?: Uint8Array } = {}): { tail: Uint8Array; fileSha256: Uint8Array } {
      if (pending.byteLength < 10 + 16 || (pending.byteLength - 10) % 16 !== 0) {
        throw new DecryptionError(`media stream: invalid tail length ${pending.byteLength} at finalize`);
      }
      const ciphertext = pending.subarray(0, pending.byteLength - 10);
      const givenMac = pending.subarray(pending.byteLength - 10);
      mac.update(ciphertext);
      const actual = mac.digest().subarray(0, 10);
      if (!Buffer.from(actual).equals(Buffer.from(givenMac))) {
        throw new DecryptionError('media stream: MAC verification failed');
      }
      let tail: Uint8Array;
      try {
        tail = new Uint8Array(decipher.update(ciphertext));
        const finalBlock = decipher.final();
        tail = new Uint8Array(Buffer.concat([Buffer.from(tail), finalBlock]));
      } catch (err) {
        throw new DecryptionError('media stream: AES finalization failed', { cause: err });
      }
      fileHash.update(tail);
      const fileSha256 = new Uint8Array(fileHash.digest());
      if (opts.fileSha256 && !Buffer.from(fileSha256).equals(Buffer.from(opts.fileSha256))) {
        throw new DecryptionError('media stream: fileSha256 mismatch');
      }
      return { tail, fileSha256 };
    },
  };
  return result;
}
