import { DecryptionError, ProtocolError } from '../../Defaults/errors';
import { bytesEqual } from '../../Utils/buffer';
import type { KeyPair } from '../../Auth/types';
import { aesCbcDecrypt, aesCbcEncrypt, hmacSha256 } from '../crypto';
import { calculateAgreement, generateKeyPair } from '../curve';
import { getFieldBytes, getFieldVarint, ProtoWriter, readFields } from '../proto-wire';
import { deriveMessageKeys, kdfRK, nextChainKey, type MessageKeys } from './ratchet';
import {
  findReceivingChain,
  MESSAGE_KEY_CACHE_LIMIT,
  pushReceivingChain,
  type ReceivingChain,
  type SessionState,
} from './record';

/**
 * Whisper/session cipher: encrypt/decrypt 1:1 messages with the double
 * ratchet. Wire shape mirrors libsignal's SignalMessage / PreKeySignalMessage
 * protobuf envelopes with a version byte prepended and an 8-byte truncated
 * HMAC appended.
 */

export const WHISPER_MESSAGE_VERSION = 3;
const VERSION_BYTE = (WHISPER_MESSAGE_VERSION << 4) | WHISPER_MESSAGE_VERSION; // 0x33
const MAC_LENGTH = 8;

export interface SignalMessageBody {
  ratchetKey: Uint8Array;
  counter: number;
  previousCounter: number;
  ciphertext: Uint8Array;
}

export type EncryptedMessageType = 'msg' | 'pkmsg';

export interface EncryptedMessage {
  type: EncryptedMessageType;
  /** version || proto [|| prekey header proto] || mac */
  serialized: Uint8Array;
}

// ---- protobuf wire shapes ---------------------------------------------------

export function encodeSignalMessage(body: SignalMessageBody): Uint8Array {
  return new ProtoWriter()
    .bytes(1, body.ratchetKey)
    .varint(2, body.counter)
    .varint(3, body.previousCounter)
    .bytes(4, body.ciphertext)
    .finish();
}

export function decodeSignalMessage(data: Uint8Array): SignalMessageBody {
  const fields = readFields(data);
  const ratchetKey = getFieldBytes(fields, 1);
  const ciphertext = getFieldBytes(fields, 4);
  if (!ratchetKey || !ciphertext) throw new ProtocolError('SignalMessage: missing ratchetKey/ciphertext');
  return {
    ratchetKey,
    counter: getFieldVarint(fields, 2) ?? 0,
    previousCounter: getFieldVarint(fields, 3) ?? 0,
    ciphertext,
  };
}

export interface PreKeySignalMessageBody {
  preKeyId?: number;
  signedPreKeyId: number;
  baseKey: Uint8Array;
  identityKey: Uint8Array;
  message: Uint8Array;
  registrationId: number;
}

export function encodePreKeySignalMessage(body: PreKeySignalMessageBody): Uint8Array {
  return new ProtoWriter()
    .varint(1, body.preKeyId)
    .varint(2, body.signedPreKeyId)
    .bytes(3, body.baseKey)
    .bytes(4, body.identityKey)
    .bytes(5, body.message)
    .varint(6, body.registrationId)
    .finish();
}

export function decodePreKeySignalMessage(data: Uint8Array): PreKeySignalMessageBody {
  const fields = readFields(data);
  const baseKey = getFieldBytes(fields, 3);
  const identityKey = getFieldBytes(fields, 4);
  const message = getFieldBytes(fields, 5);
  if (!baseKey || !identityKey || !message) throw new ProtocolError('PreKeySignalMessage: missing fields');
  return {
    preKeyId: getFieldVarint(fields, 1),
    signedPreKeyId: getFieldVarint(fields, 2) ?? 0,
    baseKey,
    identityKey,
    message,
    registrationId: getFieldVarint(fields, 6) ?? 0,
  };
}

// ---- cipher -----------------------------------------------------------------

function computeMac(
  keys: MessageKeys,
  senderIdentity: Uint8Array,
  receiverIdentity: Uint8Array,
  serialized: Uint8Array,
): Uint8Array {
  const macInput = new Uint8Array(senderIdentity.byteLength + receiverIdentity.byteLength + serialized.byteLength);
  macInput.set(senderIdentity, 0);
  macInput.set(receiverIdentity, senderIdentity.byteLength);
  macInput.set(serialized, senderIdentity.byteLength + receiverIdentity.byteLength);
  return hmacSha256(keys.macKey, macInput).subarray(0, MAC_LENGTH);
}

/**
 * Encrypts plaintext under the session's sending chain, creating one when
 * needed. NOTE: callers must persist the mutated `session` afterwards
 * (the store transaction in `SessionManager` does this).
 */
export function encryptWhisperMessage(
  session: SessionState,
  plaintext: Uint8Array,
  opts: { preKey?: { baseKey: KeyPair; signedPreKeyId: number; preKeyId?: number; registrationId: number } } = {},
): EncryptedMessage {
  if (!session.remoteRatchetKey) throw new ProtocolError('encrypt: session has no remote ratchet key');

  if (!session.sendingChain) {
    const ratchetKeyPair = generateKeyPair();
    const dh = calculateAgreement(session.remoteRatchetKey, ratchetKeyPair.privateKey);
    const { rootKey, chainKey } = kdfRK(session.rootKey, dh);
    session.rootKey = rootKey;
    session.sendingChain = { ratchetKeyPair, chainKey, counter: 0 };
  }

  const chain = session.sendingChain;
  const keys = deriveMessageKeys(chain.chainKey);
  const ciphertext = aesCbcEncrypt(keys.cipherKey, keys.iv, plaintext);

  const signalMessage = encodeSignalMessage({
    ratchetKey: chain.ratchetKeyPair.publicKey,
    counter: chain.counter,
    previousCounter: session.previousCounter,
    ciphertext,
  });

  const body = new Uint8Array(1 + signalMessage.byteLength);
  body[0] = VERSION_BYTE;
  body.set(signalMessage, 1);

  const mac = computeMac(keys, session.localIdentityKey, session.remoteIdentityKey, body);

  let serialized = new Uint8Array(body.byteLength + MAC_LENGTH);
  serialized.set(body, 0);
  serialized.set(mac, body.byteLength);

  let type: EncryptedMessageType = 'msg';

  if (opts.preKey) {
    type = 'pkmsg';
    const preKeyProto = encodePreKeySignalMessage({
      preKeyId: opts.preKey.preKeyId,
      signedPreKeyId: opts.preKey.signedPreKeyId,
      baseKey: opts.preKey.baseKey.publicKey,
      identityKey: session.localIdentityKey,
      message: serialized,
      registrationId: opts.preKey.registrationId,
    });
    const wrapped = new Uint8Array(1 + preKeyProto.byteLength);
    wrapped[0] = VERSION_BYTE;
    wrapped.set(preKeyProto, 1);
    serialized = wrapped;
  }

  // advance chain (forward secrecy)
  chain.chainKey = nextChainKey(chain.chainKey);
  chain.counter += 1;

  return { type, serialized };
}

export function decryptWhisperMessage(session: SessionState, serialized: Uint8Array): Uint8Array {
  if (serialized.byteLength < 1 + MAC_LENGTH) throw new DecryptionError('decrypt: message too short');
  const version = serialized[0];
  if (version !== VERSION_BYTE) {
    throw new DecryptionError(`decrypt: unsupported message version 0x${(version ?? 0).toString(16)}`);
  }
  // MAC input includes the version byte (mirrors the encrypt side)
  const versionedBody = serialized.subarray(0, serialized.byteLength - MAC_LENGTH);
  const body = versionedBody.subarray(1);
  const theirMac = serialized.subarray(serialized.byteLength - MAC_LENGTH);

  const message = decodeSignalMessage(body);

  // 1) try cached out-of-order keys first
  const chain = findReceivingChain(session, message.ratchetKey);
  const cached = chain?.messageKeys.get(message.counter);
  if (cached && chain) {
    chain.messageKeys.delete(message.counter);
    const keys: MessageKeys = {
      iv: cached.subarray(0, 16),
      cipherKey: cached.subarray(16, 48),
      macKey: cached.subarray(48, 80),
    };
    verifyMac(keys, versionedBody, theirMac, session);
    return aesCbcDecrypt(keys.cipherKey, keys.iv, message.ciphertext);
  }

  // 2) existing receiving chain — roll forward
  if (chain) {
    if (message.counter < chain.counter) {
      throw new DecryptionError(`decrypt: message counter ${message.counter} already consumed`);
    }
    rollChainTo(chain, message.counter);
    const keys = deriveMessageKeys(chain.chainKey);
    chain.counter += 1;
    chain.chainKey = nextChainKey(chain.chainKey);
    verifyMac(keys, versionedBody, theirMac, session);
    return aesCbcDecrypt(keys.cipherKey, keys.iv, message.ciphertext);
  }

  // 3) new ratchet key from peer → DH ratchet step
  if (!session.sendingChain) throw new DecryptionError('decrypt: unknown ratchet key and no sending chain');
  const previousCounter = session.sendingChain.counter;
  const dhReceive = calculateAgreement(message.ratchetKey, session.sendingChain.ratchetKeyPair.privateKey);
  const receiveStep = kdfRK(session.rootKey, dhReceive);
  session.rootKey = receiveStep.rootKey;
  const newChain: ReceivingChain = {
    ratchetPublicKey: message.ratchetKey,
    chainKey: receiveStep.chainKey,
    counter: 0,
    messageKeys: new Map(),
  };
  pushReceivingChain(session, newChain);

  // prepare next sending chain (double ratchet)
  const newRatchetKeyPair = generateKeyPair();
  const dhSend = calculateAgreement(message.ratchetKey, newRatchetKeyPair.privateKey);
  const sendStep = kdfRK(session.rootKey, dhSend);
  session.rootKey = sendStep.rootKey;
  session.previousCounter = previousCounter;
  session.sendingChain = { ratchetKeyPair: newRatchetKeyPair, chainKey: sendStep.chainKey, counter: 0 };
  session.remoteRatchetKey = message.ratchetKey;

  rollChainTo(newChain, message.counter);
  const keys = deriveMessageKeys(newChain.chainKey);
  newChain.counter += 1;
  newChain.chainKey = nextChainKey(newChain.chainKey);
  verifyMac(keys, versionedBody, theirMac, session);
  session.established = true;
  return aesCbcDecrypt(keys.cipherKey, keys.iv, message.ciphertext);
}

function verifyMac(keys: MessageKeys, body: Uint8Array, theirMac: Uint8Array, session: SessionState): void {
  // NOTE: on decrypt, sender identity is remote, receiver identity is local.
  const ourMac = computeMac(keys, session.remoteIdentityKey, session.localIdentityKey, body);
  if (!bytesEqual(ourMac, theirMac)) throw new DecryptionError('decrypt: bad MAC');
}

/** Advance the receiving chain, caching skipped message keys for out-of-order delivery */
function rollChainTo(chain: ReceivingChain, counter: number): void {
  const MAX_ROLL_AHEAD = 5000;
  if (counter - chain.counter > MAX_ROLL_AHEAD) {
    throw new DecryptionError(`decrypt: cannot skip ${counter - chain.counter} chain steps`);
  }
  while (chain.counter < counter) {
    if (chain.messageKeys.size >= MESSAGE_KEY_CACHE_LIMIT) {
      const oldest = chain.messageKeys.keys().next().value;
      if (oldest !== undefined) chain.messageKeys.delete(oldest);
    }
    const keys = deriveMessageKeys(chain.chainKey);
    const expanded = new Uint8Array(80);
    expanded.set(keys.iv, 0);
    expanded.set(keys.cipherKey, 16);
    expanded.set(keys.macKey, 48);
    chain.messageKeys.set(chain.counter, expanded);
    chain.chainKey = nextChainKey(chain.chainKey);
    chain.counter += 1;
  }
}
