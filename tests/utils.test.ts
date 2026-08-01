import { describe, expect, it } from 'vitest';
import {
  areJidsSameUser,
  isJidBroadcast,
  isJidGroup,
  isLidUser,
  isJidNewsletter,
  isJidUser,
  jidDecode,
  jidEncode,
  jidNormalizedUser,
  jidToPhoneNumber,
} from '../src/Utils/jids';
import { computeBackoff, generateMessageID, isPlainObject, promiseTimeout } from '../src/Utils/generics';
import { TimedOutError } from '../src/Defaults/errors';
import { bytesEqual, encodeBigEndian, readUInt24BE, safeSlice } from '../src/Utils/buffer';
import { ProtocolError } from '../src/Defaults/errors';
import { BufferJSON } from '../src/Utils/buffer-json';

describe('jids', () => {
  it('encode/decode round trip', () => {
    const jid = jidEncode('41789996011', 's.whatsapp.net', 5);
    expect(jid).toBe('41789996011:5@s.whatsapp.net');
    const dec = jidDecode(jid);
    expect(dec?.user).toBe('41789996011');
    expect(dec?.device).toBe(5);
    expect(dec?.server).toBe('s.whatsapp.net');
  });

  it('decodes agent+device combos in the right order', () => {
    const dec = jidDecode('123_1:2@s.whatsapp.net');
    expect(dec?.user).toBe('123');
    expect(dec?.agent).toBe(1);
    expect(dec?.device).toBe(2);
  });

  it('classifies servers', () => {
    expect(isJidUser('1@s.whatsapp.net')).toBe(true);
    expect(isJidGroup('1@g.us')).toBe(true);
    expect(isLidUser('1@lid')).toBe(true);
    expect(isJidNewsletter('1@newsletter')).toBe(true);
    expect(isJidBroadcast('news@broadcast')).toBe(true);
  });

  it('normalization + same-user comparison', () => {
    expect(jidNormalizedUser('41789996011:5@s.whatsapp.net')).toBe('41789996011@s.whatsapp.net');
    expect(areJidsSameUser('41789996011:5@s.whatsapp.net', '41789996011@s.whatsapp.net')).toBe(true);
    expect(areJidsSameUser('41789996011@s.whatsapp.net', '1@g.us')).toBe(false);
    expect(jidToPhoneNumber('41789996011:5@s.whatsapp.net')).toBe('41789996011');
  });

  it('never throws on malformed input', () => {
    expect(jidDecode('')).toBeUndefined();
    expect(jidDecode(undefined)).toBeUndefined();
    expect(jidDecode('no-at-sign')).toBeUndefined();
  });
});

describe('generics', () => {
  it('backoff stays within [0, maxMs] and grows exponentially', () => {
    const d0 = computeBackoff(0, { baseMs: 1000, factor: 2, maxMs: 10_000, jitter: 0 });
    const d3 = computeBackoff(3, { baseMs: 1000, factor: 2, maxMs: 10_000, jitter: 0 });
    const capped = computeBackoff(30, { baseMs: 1000, factor: 2, maxMs: 10_000, jitter: 0 });
    expect(d0).toBe(1000);
    expect(d3).toBe(8000);
    expect(capped).toBe(10_000);
    for (let i = 0; i < 20; i++) {
      const j = computeBackoff(5, { baseMs: 1000, jitter: 1, maxMs: 60_000 });
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(60_000);
    }
  });

  it('message ids are 32 uppercase hex', () => {
    const id = generateMessageID();
    expect(id).toMatch(/^[0-9A-F]{32}$/);
    expect(generateMessageID()).not.toBe(id);
  });

  it('promiseTimeout rejects with TimedOutError', async () => {
    await expect(promiseTimeout(new Promise(() => {}), { timeoutMs: 10 })).rejects.toBeInstanceOf(TimedOutError);
  });

  it('isPlainObject is strict', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
});

describe('buffer helpers', () => {
  it('big-endian encode/read round trip', () => {
    const enc = encodeBigEndian(0xabcdef, 3);
    expect(readUInt24BE(enc)).toBe(0xabcdef);
  });

  it('bounds violations throw typed errors, not crashes', () => {
    expect(() => safeSlice(new Uint8Array(2), 1, 5)).toThrow(ProtocolError);
    expect(() => encodeBigEndian(-1)).toThrow(ProtocolError);
  });

  it('bytesEqual is length safe', () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(1))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1]))).toBe(true);
  });

  it('BufferJSON round trips buffers', () => {
    const obj = { a: new Uint8Array([1, 2, 3]), b: 'text', n: 5 };
    const parsed = BufferJSON.parse<typeof obj>(BufferJSON.stringify(obj));
    expect(parsed.a).toBeInstanceOf(Uint8Array);
    expect([...parsed.a]).toEqual([1, 2, 3]);
    expect(parsed.n).toBe(5);
  });
});
