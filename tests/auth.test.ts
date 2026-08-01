import { describe, expect, it } from 'vitest';
import { initAuthCreds, makeInMemoryAuthState } from '../src/Auth/init';
import { buildQrPayload, parseQrPayload, QR_REF_TTL_MS, QR_TIMEOUT_MS } from '../src/Auth/qr';
import {
  computePairingKeyMaterial,
  encryptPairingPayload,
  formatPairCode,
  isValidPairCode,
  normalizePairCode,
  normalizePhoneNumber,
} from '../src/Auth/pair-code';
import { collectSignalDataSet, exportSession, importSession } from '../src/Auth/session-codec';
import { BaileysError } from '../src/Defaults/errors';
import { InMemorySignalKeyStore } from '../src/Signal/libsignal/storage';
import { MemoryStorageAdapter } from '../src/Store/adapters/memory';

describe('credential init', () => {
  it('produces complete, unique credentials', () => {
    const a = initAuthCreds();
    const b = initAuthCreds();
    expect(a.noiseKey.publicKey.byteLength).toBe(32);
    expect(a.signedPreKey.keyId).toBe(1);
    expect(a.signedPreKey.signature.byteLength).toBeGreaterThan(0);
    expect(a.advSecretKey.length).toBeGreaterThan(0);
    expect(a.registered).toBe(false);
    expect(a.nextPreKeyId).toBe(2);
    expect(Buffer.from(a.noiseKey.privateKey).equals(Buffer.from(b.noiseKey.privateKey))).toBe(false);
  });

  it('in-memory auth state is wired', async () => {
    const state = makeInMemoryAuthState();
    await state.keys.set({ 'pre-key': { '2': state.creds.signedPreKey.keyPair } });
    const got = await state.keys.get('pre-key', ['2']);
    expect(got['2']?.publicKey).toBeDefined();
  });
});

describe('qr api', () => {
  it('builds/parses payloads', () => {
    const qr = buildQrPayload('ref123', new Uint8Array(32).fill(1), new Uint8Array(8).fill(2));
    const parsed = parseQrPayload(qr);
    expect(parsed.ref).toBe('ref123');
    expect(parsed.publicKey.length).toBeGreaterThan(0);
  });

  it('rejects malformed payloads with typed error', () => {
    expect(() => parseQrPayload('only-one-part')).toThrow(BaileysError);
    expect(QR_REF_TTL_MS).toBeGreaterThan(0);
    expect(QR_TIMEOUT_MS).toBeGreaterThan(QR_REF_TTL_MS);
  });
});

describe('pair code api', () => {
  it('normalizes and formats codes', () => {
    expect(normalizePairCode('ab-cd 12ef')).toBe('ABCD12EF');
    expect(formatPairCode('abcd12ef')).toBe('ABCD-12EF');
    expect(isValidPairCode('ABCD-12EF')).toBe(true);
    expect(isValidPairCode('2shrt')).toBe(false);
    expect(() => formatPairCode('bad!')).toThrow(BaileysError);
  });

  it('validates phone numbers', () => {
    expect(normalizePhoneNumber('+1 (415) 555-0100').digits).toBe('14155550100');
    expect(normalizePhoneNumber('14155550100').jid).toBe('14155550100@s.whatsapp.net');
    expect(() => normalizePhoneNumber('123')).toThrow(BaileysError);
    expect(() => normalizePhoneNumber('0'.repeat(20))).toThrow(BaileysError);
  });

  it('computes deterministic pairing key material + encrypts payloads', () => {
    const pub = new Uint8Array(32).fill(7);
    const k1 = computePairingKeyMaterial(pub, '14155550100', 'REF');
    const k2 = computePairingKeyMaterial(pub, '14155550100', 'REF');
    const k3 = computePairingKeyMaterial(pub, '14155550101', 'REF');
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true);
    expect(Buffer.from(k1).equals(Buffer.from(k3))).toBe(false);
    const encrypted = encryptPairingPayload(k1, new TextEncoder().encode('hello'));
    expect(encrypted.byteLength).toBeGreaterThan(16);
  });
});

describe('session export/import', () => {
  it('round trips creds + signal keys', async () => {
    const creds = initAuthCreds();
    creds.me = { id: '41789996011:5@s.whatsapp.net' };
    const keysStore = new InMemorySignalKeyStore();
    await keysStore.set({ session: { '41789996011-5.0': new Uint8Array([4, 5, 6]) } });

    const adapter = new MemoryStorageAdapter();
    for (const [category, entries] of Object.entries(await keysStore.get('session', ['41789996011-5.0']))) {
      void category;
      void entries;
    }
    await adapter.set('session:41789996011-5.0', new Uint8Array([4, 5, 6]));
    const ds = await collectSignalDataSet(
      (p) => adapter.keys(p),
      (k) => adapter.get(k),
    );

    const envelope = exportSession(creds, ds);
    const imported = importSession(envelope);
    expect(imported.creds.me?.id).toBe('41789996011:5@s.whatsapp.net');
    expect([...(imported.keys.session?.['41789996011-5.0'] ?? [])]).toEqual([4, 5, 6]);
  });

  it('rejects tampered envelopes', () => {
    const envelope = exportSession(initAuthCreds(), {});
    const [body, checksum] = envelope.split('.');
    expect(() => importSession(`${body}x.${checksum}`)).toThrow(BaileysError);
    expect(() => importSession(`${body}.${checksum}00`)).toThrow(BaileysError);
    expect(() => importSession('garbage')).toThrow(BaileysError);
  });
});
