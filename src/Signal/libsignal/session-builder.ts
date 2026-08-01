import type { KeyPair, SignedPreKey } from '../../Auth/types';
import { hkdf } from '../crypto';
import { kdfRK } from './ratchet';
import { calculateAgreement, generateKeyPair } from '../curve';
import { createSessionState, pushReceivingChain, type SessionState } from './record';

/**
 * X3DH session setup.
 *
 * Both sides derive the same root key from the classic DH triple
 * (identity × signed-prekey × ephemeral[, one-time prekey]) with the
 * 32×0xFF forward-secrecy prefix, expanded via HKDF-SHA256 with the
 * `WhisperText` info string.
 */

const X3DH_PREFIX = new Uint8Array(32).fill(0xff);
const INFO_WHISPER_TEXT = 'WhisperText';

export interface InitSessionParams {
  ourIdentityKey: KeyPair;
  registrationId: number;
  /** The peer's long-term identity public key */
  theirIdentityKey: Uint8Array;
  /** The peer's signed pre-key (from their published bundle) */
  theirSignedPreKey: KeyPair & { keyId: number };
  theirOneTimePreKey?: Uint8Array;
  theirRegistrationId: number;
}

export interface ProcessPreKeyParams {
  ourIdentityKey: KeyPair;
  ourSignedPreKey: SignedPreKey;
  ourOneTimePreKey?: KeyPair;
  registrationId: number;
  theirIdentityKey: Uint8Array;
  theirEphemeralKey: Uint8Array;
  theirRegistrationId: number;
}

function triple3(a: Uint8Array, b: Uint8Array, c: Uint8Array, d?: Uint8Array): Uint8Array {
  const total = 32 + 32 * (d ? 4 : 3);
  const out = new Uint8Array(total);
  out.set(X3DH_PREFIX, 0);
  out.set(a, 32);
  out.set(b, 64);
  out.set(c, 96);
  if (d) out.set(d, 128);
  return out;
}

function deriveRootKey(secretMaterial: Uint8Array): Uint8Array {
  return hkdf(secretMaterial, 32, { info: INFO_WHISPER_TEXT });
}

/**
 * Initialize a session as the initiator (a.k.a. "Alice").
 * The returned `baseKey` plays two roles: it is the X3DH ephemeral key AND
 * the first ratchet key pair, matching the classic libsignal construction.
 * It must be transmitted inside the first prekey message.
 */
export function initSession(
  params: InitSessionParams,
  baseKey: KeyPair = generateKeyPair(),
): { session: SessionState; baseKey: KeyPair } {
  // Classic X3DH initiator: DH1 = DH(IKa, SPKb) — we only publish the base
  // key inside the prekey message, never a prekey bundle of our own.
  const dh1 = calculateAgreement(params.theirSignedPreKey.publicKey, params.ourIdentityKey.privateKey);
  const dh2 = calculateAgreement(params.theirIdentityKey, baseKey.privateKey);
  const dh3 = calculateAgreement(params.theirSignedPreKey.publicKey, baseKey.privateKey);
  const dh4 = params.theirOneTimePreKey ? calculateAgreement(params.theirOneTimePreKey, baseKey.privateKey) : undefined;

  const x3dhRoot = deriveRootKey(triple3(dh1, dh2, dh3, dh4));

  // Double-ratchet send step over the X3DH root, keyed by the base key.
  const sendStep = kdfRK(x3dhRoot, calculateAgreement(params.theirSignedPreKey.publicKey, baseKey.privateKey));

  const session = createSessionState({
    rootKey: sendStep.rootKey,
    localIdentityKey: params.ourIdentityKey.publicKey,
    remoteIdentityKey: params.theirIdentityKey,
    localRegistrationId: params.registrationId,
    remoteRegistrationId: params.theirRegistrationId,
    remoteRatchetKey: params.theirSignedPreKey.publicKey,
  });
  session.sendingChain = { ratchetKeyPair: baseKey, chainKey: sendStep.chainKey, counter: 0 };

  return { session, baseKey };
}

/**
 * Initialize a session as the responder ("Bob") from a received prekey
 * message. Pre-derives the first receiving chain keyed by the peer's
 * ephemeral/base key, so the first prekey message decrypts directly.
 */
export function processPreKeyBundle(params: ProcessPreKeyParams): SessionState {
  const dh1 = calculateAgreement(params.theirIdentityKey, params.ourSignedPreKey.keyPair.privateKey);
  const dh2 = calculateAgreement(params.theirEphemeralKey, params.ourIdentityKey.privateKey);
  const dh3 = calculateAgreement(params.theirEphemeralKey, params.ourSignedPreKey.keyPair.privateKey);
  const dh4 = params.ourOneTimePreKey
    ? calculateAgreement(params.theirEphemeralKey, params.ourOneTimePreKey.privateKey)
    : undefined;

  const x3dhRoot = deriveRootKey(triple3(dh1, dh2, dh3, dh4));

  // First receiving chain: kdfRK(SK, DH(SPK_local, baseKey_remote)).
  const receiveStep = kdfRK(
    x3dhRoot,
    calculateAgreement(params.theirEphemeralKey, params.ourSignedPreKey.keyPair.privateKey),
  );

  const session = createSessionState({
    rootKey: receiveStep.rootKey,
    localIdentityKey: params.ourIdentityKey.publicKey,
    remoteIdentityKey: params.theirIdentityKey,
    localRegistrationId: params.registrationId,
    remoteRegistrationId: params.theirRegistrationId,
    remoteRatchetKey: params.theirEphemeralKey,
  });
  pushReceivingChain(session, {
    ratchetPublicKey: params.theirEphemeralKey,
    chainKey: receiveStep.chainKey,
    counter: 0,
    messageKeys: new Map(),
  });

  return session;
}
