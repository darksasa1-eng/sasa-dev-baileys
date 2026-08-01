import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../src/Signal/curve';
import { generatePreKey, generateRegistrationId, generateSignedPreKey } from '../src/Signal/key-helper';
import { initSession, processPreKeyBundle } from '../src/Signal/libsignal/session-builder';
import {
  decodePreKeySignalMessage,
  decryptWhisperMessage,
  encryptWhisperMessage,
} from '../src/Signal/libsignal/session-cipher';
import { deserializeSession, serializeSession } from '../src/Signal/libsignal/record';
import {
  createSenderKeyState,
  decryptSenderKeyMessage,
  deserializeSenderKeyRecord,
  encryptSenderKeyMessage,
  processSenderKeyDistributionMessage,
  serializeSenderKeyRecord,
  toSenderKeyDistributionMessage,
  type SenderKeyRecord,
} from '../src/Signal/libsignal/sender-key';
import { kdfRK, nextChainKey, deriveMessageKeys } from '../src/Signal/libsignal/ratchet';
import { DecryptionError } from '../src/Defaults/errors';
import { InMemorySignalKeyStore, addTransactionCapability } from '../src/Signal/libsignal/storage';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function makeParties() {
  const aliceIdentity = generateKeyPair();
  const bobIdentity = generateKeyPair();
  const bobSignedPreKey = generateSignedPreKey(bobIdentity, 1);
  return {
    aliceIdentity,
    bobIdentity,
    bobSignedPreKey,
    regA: generateRegistrationId(),
    regB: generateRegistrationId(),
  };
}

function establishSession() {
  const { aliceIdentity, bobIdentity, bobSignedPreKey, regA, regB } = makeParties();
  const { session: alice, baseKey } = initSession({
    ourIdentityKey: aliceIdentity,
    registrationId: regA,
    theirIdentityKey: bobIdentity.publicKey,
    theirSignedPreKey: { keyId: 1, ...bobSignedPreKey.keyPair },
    theirRegistrationId: regB,
  });
  const first = encryptWhisperMessage(alice, ENC.encode('prekey hello'), {
    preKey: { baseKey, signedPreKeyId: 1, registrationId: regA },
  });
  expect(first.type).toBe('pkmsg');
  const pkBody = decodePreKeySignalMessage(first.serialized.subarray(1));
  const bob = processPreKeyBundle({
    ourIdentityKey: bobIdentity,
    ourSignedPreKey: bobSignedPreKey,
    registrationId: regB,
    theirIdentityKey: pkBody.identityKey,
    theirEphemeralKey: pkBody.baseKey,
    theirRegistrationId: pkBody.registrationId,
  });
  return { alice, bob, first, pkBody };
}

describe('signal: X3DH + double ratchet', () => {
  it('establishes matching sessions (pkmsg decrypts on responder)', () => {
    const { bob, pkBody } = establishSession();
    const plain = decryptWhisperMessage(bob, pkBody.message);
    expect(DEC.decode(plain)).toBe('prekey hello');
  });

  it('rejects tampered ciphertext with typed error', () => {
    const { bob, pkBody } = establishSession();
    const bad = new Uint8Array(pkBody.message);
    bad[10] = (bad[10] ?? 0) ^ 0xff;
    expect(() => decryptWhisperMessage(bob, bad)).toThrow(DecryptionError);
  });

  it('bidirectional conversation ratchets correctly', () => {
    const { alice, bob, pkBody } = establishSession();
    decryptWhisperMessage(bob, pkBody.message);
    const reply = encryptWhisperMessage(bob, ENC.encode('hi alice'));
    expect(reply.type).toBe('msg');
    expect(DEC.decode(decryptWhisperMessage(alice, reply.serialized))).toBe('hi alice');

    for (let i = 0; i < 10; i++) {
      const a = encryptWhisperMessage(alice, ENC.encode(`a${i}`));
      expect(DEC.decode(decryptWhisperMessage(bob, a.serialized))).toBe(`a${i}`);
      const b = encryptWhisperMessage(bob, ENC.encode(`b${i}`));
      expect(DEC.decode(decryptWhisperMessage(alice, b.serialized))).toBe(`b${i}`);
    }
  });

  it('decrypts out-of-order delivery via cached message keys', () => {
    const { alice, bob, pkBody } = establishSession();
    decryptWhisperMessage(bob, pkBody.message);
    const m1 = encryptWhisperMessage(alice, ENC.encode('one'));
    const m2 = encryptWhisperMessage(alice, ENC.encode('two'));
    const m3 = encryptWhisperMessage(alice, ENC.encode('three'));
    // deliver out of order: m3, then m1, then m2
    expect(DEC.decode(decryptWhisperMessage(bob, m3.serialized))).toBe('three');
    expect(DEC.decode(decryptWhisperMessage(bob, m1.serialized))).toBe('one');
    expect(DEC.decode(decryptWhisperMessage(bob, m2.serialized))).toBe('two');
    // second delivery of consumed counter must fail
    expect(() => decryptWhisperMessage(bob, m1.serialized)).toThrow(DecryptionError);
  });

  it('session records serialize and restore', () => {
    const { alice } = establishSession();
    const restored = deserializeSession(serializeSession({ state: alice }));
    expect(Buffer.from(restored.state.rootKey).equals(Buffer.from(alice.rootKey))).toBe(true);
    expect(restored.state.sendingChain?.counter).toBe(alice.sendingChain?.counter);
  });

  it('KDF helpers are chain-consistent', () => {
    const chain = new Uint8Array(32).fill(7);
    const next = nextChainKey(chain);
    expect(Buffer.from(next).equals(Buffer.from(chain))).toBe(false);
    const k1 = deriveMessageKeys(chain);
    const { rootKey, chainKey } = kdfRK(next, k1.cipherKey);
    expect(rootKey.byteLength).toBe(32);
    expect(chainKey.byteLength).toBe(32);
  });
});

describe('signal: sender keys (groups)', () => {
  it('distribution → group encrypt/decrypt works', () => {
    const aliceState = createSenderKeyState();
    const aliceRec: SenderKeyRecord = { senderKeyState: aliceState };
    const bobRec: SenderKeyRecord = { senderKeyState: undefined };
    processSenderKeyDistributionMessage(bobRec, toSenderKeyDistributionMessage(aliceState));

    const ct = encryptSenderKeyMessage(aliceRec, ENC.encode('group msg'));
    expect(DEC.decode(decryptSenderKeyMessage(bobRec, ct))).toBe('group msg');
  });

  it('handles out-of-order group messages', () => {
    const aliceState = createSenderKeyState();
    const aliceRec: SenderKeyRecord = { senderKeyState: aliceState };
    const bobRec: SenderKeyRecord = { senderKeyState: undefined };
    processSenderKeyDistributionMessage(bobRec, toSenderKeyDistributionMessage(aliceState));
    const a = encryptSenderKeyMessage(aliceRec, ENC.encode('A'));
    const b = encryptSenderKeyMessage(aliceRec, ENC.encode('B'));
    expect(DEC.decode(decryptSenderKeyMessage(bobRec, b))).toBe('B');
    expect(DEC.decode(decryptSenderKeyMessage(bobRec, a))).toBe('A');
  });

  it('rejects tampered signature', () => {
    const st = createSenderKeyState();
    const rec: SenderKeyRecord = { senderKeyState: st };
    const other: SenderKeyRecord = { senderKeyState: undefined };
    processSenderKeyDistributionMessage(other, toSenderKeyDistributionMessage(st));
    const ct = encryptSenderKeyMessage(rec, ENC.encode('x'));
    const bad = new Uint8Array(ct);
    bad[3] = (bad[3] ?? 0) ^ 1;
    expect(() => decryptSenderKeyMessage(other, bad)).toThrow(DecryptionError);
  });

  it('sender key records round-trip', () => {
    const st = createSenderKeyState();
    const rec: SenderKeyRecord = { senderKeyState: st };
    const restored = deserializeSenderKeyRecord(serializeSenderKeyRecord(rec));
    expect(restored.senderKeyState?.keyId).toBe(st.keyId);
    const restoredState = restored.senderKeyState;
    expect(restoredState).toBeDefined();
    expect(Buffer.from(restoredState?.chain.chainKey ?? []).equals(Buffer.from(st.chain.chainKey))).toBe(true);
  });
});

describe('signal: storage', () => {
  it('in-memory store get/set/delete works', async () => {
    const store = new InMemorySignalKeyStore();
    await store.set({ 'pre-key': { '5': { publicKey: new Uint8Array([1]), privateKey: new Uint8Array([2]) } } });
    const got = await store.get('pre-key', ['5', '6']);
    expect(got['5']?.publicKey[0]).toBe(1);
    expect(got['6']).toBeUndefined();
    await store.set({ 'pre-key': { '5': null } });
    expect((await store.get('pre-key', ['5']))['5']).toBeUndefined();
  });

  it('transactions serialize concurrent sections with same key', async () => {
    const store = addTransactionCapability(new InMemorySignalKeyStore());
    const order: number[] = [];
    await Promise.all([
      store.transaction(async () => {
        await new Promise((r) => setTimeout(r, 40));
        order.push(1);
      }, 'same'),
      store.transaction(async () => {
        order.push(2);
      }, 'same'),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it('pre-key helpers produce sane material', () => {
    expect(generateRegistrationId()).toBeGreaterThan(0);
    expect(generateRegistrationId()).toBeLessThan(16384);
    const pk = generatePreKey(7);
    expect(pk.keyId).toBe(7);
    expect(pk.keyPair.publicKey.byteLength).toBe(32);
  });
});
