import { describe, expect, it } from 'vitest';
import {
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hkdf,
  hmacSha256,
  sha256,
} from '../src/Signal/crypto';
import { DecryptionError } from '../src/Defaults/errors';
import {
  calculateAgreement,
  calculateSignature,
  generateKeyPair,
  generateSigningKeyPair,
  verifySignature,
} from '../src/Signal/curve';
import { randomBytes } from 'node:crypto';

describe('crypto primitives', () => {
  it('sha256 matches known vector', () => {
    expect(Buffer.from(sha256(new TextEncoder().encode('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hkdf matches RFC 5869 test case 1', () => {
    // IKM=0x0b*22, salt=0x000102..0c, info=0xf0..f9, L=42
    const ikm = new Uint8Array(22).fill(0x0b);
    const salt = Uint8Array.from({ length: 13 }, (_, i) => i);
    const info = Uint8Array.from({ length: 10 }, (_, i) => 0xf0 + i);
    const okm = hkdf(ikm, 42, { salt, info });
    expect(Buffer.from(okm).toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('aes-cbc round trips', () => {
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const pt = randomBytes(1000);
    const ct = aesCbcEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(pt));
    expect(ct.byteLength % 16).toBe(0);
    expect(Buffer.from(aesCbcDecrypt(new Uint8Array(key), new Uint8Array(iv), ct)).equals(pt)).toBe(true);
  });

  it('aes-gcm round trips with aad', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const aad = new TextEncoder().encode('header');
    const pt = new TextEncoder().encode('payload-data');
    const ct = aesGcmEncrypt(new Uint8Array(key), new Uint8Array(iv), pt, aad);
    expect(Buffer.from(aesGcmDecrypt(new Uint8Array(key), new Uint8Array(iv), ct, aad)).equals(Buffer.from(pt))).toBe(
      true,
    );
  });

  it('aes-gcm rejects tampered ciphertext (typed error)', () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const ct = aesGcmEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(randomBytes(64)));
    const tampered = new Uint8Array(ct);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => aesGcmDecrypt(new Uint8Array(key), new Uint8Array(iv), tampered)).toThrow(DecryptionError);
  });

  it('hmac-sha256 is deterministic and key-dependent', () => {
    const k = new TextEncoder().encode('key');
    const a = hmacSha256(k, new TextEncoder().encode('data'));
    const b = hmacSha256(k, new TextEncoder().encode('data'));
    const c = hmacSha256(new TextEncoder().encode('key2'), new TextEncoder().encode('data'));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(false);
  });
});

describe('curve backend', () => {
  it('x25519 agreement is symmetric', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sa = calculateAgreement(b.publicKey, a.privateKey);
    const sb = calculateAgreement(a.publicKey, b.privateKey);
    expect(Buffer.from(sa).equals(Buffer.from(sb))).toBe(true);
    expect(sa.byteLength).toBe(32);
  });

  it('ed25519 signing round trips', () => {
    const pair = generateSigningKeyPair();
    const msg = new TextEncoder().encode('sign me');
    const sig = calculateSignature(pair.privateKey, msg);
    expect(verifySignature(pair.publicKey, msg, sig)).toBe(true);
    expect(verifySignature(pair.publicKey, new TextEncoder().encode('other'), sig)).toBe(false);
    expect(verifySignature(generateSigningKeyPair().publicKey, msg, sig)).toBe(false);
  });

  it('agreement throws on bad key lengths', () => {
    expect(() => calculateAgreement(new Uint8Array(10), new Uint8Array(10))).toThrow();
  });
});
