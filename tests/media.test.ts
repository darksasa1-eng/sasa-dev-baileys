import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptMedia, decryptMedia, createMediaCipher, getMediaKeys, generateMediaKey } from '../src/Media/crypto';
import { MediaCache } from '../src/Media/cache';
import { detectMimeType, getMediaHkdfInfo, getUploadPath } from '../src/Media/media-type';
import { DecryptionError } from '../src/Defaults/errors';

describe('media crypto', () => {
  it('encrypt/decrypt round trip across all media types', () => {
    const data = new Uint8Array(randomBytes(65_537));
    for (const type of ['image', 'video', 'audio', 'document', 'link-preview'] as const) {
      const enc = encryptMedia(data, type);
      const dec = decryptMedia(enc.body, enc.mediaKey, type, { fileSha256: enc.fileSha256 });
      expect(Buffer.from(dec.plaintext).equals(Buffer.from(data))).toBe(true);
    }
  });

  it('derives 112-byte expanded keys with category info', () => {
    const keys = getMediaKeys(generateMediaKey(), 'image');
    expect(keys.iv.byteLength).toBe(16);
    expect(keys.cipherKey.byteLength).toBe(32);
    expect(keys.macKey.byteLength).toBe(32);
    expect(keys.refKey.byteLength).toBe(32);
    expect(getMediaHkdfInfo('image')).toBe('WhatsApp Image Keys');
  });

  it('verify fails with shortened/truncated data', () => {
    const enc = encryptMedia(new Uint8Array(randomBytes(100)), 'image');
    expect(() => decryptMedia(enc.body.subarray(0, 20), enc.mediaKey, 'image')).toThrow(DecryptionError);
  });

  it('streaming cipher produces identical output to one-shot', () => {
    const mediaKey = generateMediaKey();
    const data = new Uint8Array(randomBytes(100_000));
    const oneshot = encryptMedia(data, 'video', mediaKey);
    const cipher = createMediaCipher('video', mediaKey);
    const parts: Uint8Array[] = [];
    for (let off = 0; off < data.byteLength; off += 7_777) {
      parts.push(cipher.update(data.subarray(off, off + 7_777)));
    }
    const fin = cipher.finalize();
    parts.push(fin.body);
    const streamed = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      streamed.set(p, o);
      o += p.byteLength;
    }
    expect(Buffer.from(streamed).equals(Buffer.from(oneshot.body))).toBe(true);
    expect(Buffer.from(fin.fileSha256).equals(Buffer.from(oneshot.fileSha256))).toBe(true);
  });
});

describe('media cache', () => {
  it('serves hits and evicts LRU on byte cap', () => {
    const cache = new MediaCache({ maxBytes: 300, maxEntries: 100 });
    cache.set('a', new Uint8Array(100));
    cache.set('b', new Uint8Array(100));
    cache.set('c', new Uint8Array(100));
    cache.set('d', new Uint8Array(100)); // exceeds → evicts 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBeDefined();
  });

  it('never caches entries larger than the cap', () => {
    const cache = new MediaCache({ maxBytes: 10 });
    cache.set('big', new Uint8Array(11));
    expect(cache.get('big')).toBeUndefined();
  });

  it('tracks hit rate', () => {
    const cache = new MediaCache();
    cache.set('x', new Uint8Array(1));
    cache.get('x');
    cache.get('y');
    const stats = cache.stats;
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(0.5);
  });
});

describe('media type utils', () => {
  it('detects mime by extension', () => {
    expect(detectMimeType('photo.JPG')).toBe('image/jpeg');
    expect(detectMimeType('video.mp4')).toBe('video/mp4');
    expect(detectMimeType('archive.zip')).toBe('application/zip');
    expect(detectMimeType('weird.xyz')).toBe('application/octet-stream');
  });

  it('maps upload paths', () => {
    expect(getUploadPath('image')).toBe('mms/image');
    expect(getUploadPath('sticker')).toBe('mms/image');
    expect(getUploadPath('document')).toBe('mms/document');
  });
});
