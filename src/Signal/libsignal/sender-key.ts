import { randomBytes } from 'node:crypto';
import { DecryptionError, ProtocolError } from '../../Defaults/errors';
import { bytesEqual } from '../../Utils/buffer';
import { aesCbcDecrypt, aesCbcEncrypt } from '../crypto';
import { calculateSignature, generateSigningKeyPair, verifySignature } from '../curve';
import { getFieldBytes, getFieldVarint, ProtoWriter, readFields } from '../proto-wire';
import { deriveGroupMessageKeys, nextChainKey } from './ratchet';

/**
 * Sender keys — the ratchet used for group messages ("skmsg").
 *
 * Each participant owns a sender-key state per group: a signing key pair and
 * a symmetric chain. Encrypting consumes one chain step; the current state is
 * distributed to (and refreshed for) every group member via
 * SenderKeyDistributionMessages carried inside pairwise sessions.
 */

export const SENDER_MESSAGE_VERSION = 3;
const SENDER_VERSION_BYTE = (SENDER_MESSAGE_VERSION << 4) | SENDER_MESSAGE_VERSION;

let senderKeyIdCounter = Math.floor(Math.random() * 0x7fffffff);

export interface SenderKeyChainState {
  iteration: number;
  chainKey: Uint8Array;
  /** message keys cached for out-of-order group messages */
  messageKeys: Map<number, Uint8Array>;
}

export interface SenderKeyState {
  keyId: number;
  chain: SenderKeyChainState;
  signingKeyPublic: Uint8Array;
  signingKeyPrivate?: Uint8Array; // present only on our own state
}

export interface SenderKeyRecord {
  /** our own state (for sending) */
  senderKeyState?: SenderKeyState;
}

const CACHE_LIMIT = 250;

export function createSenderKeyState(): SenderKeyState {
  const signing = generateSigningKeyPair();
  return {
    keyId: ++senderKeyIdCounter,
    chain: { iteration: 0, chainKey: new Uint8Array(randomBytes(32)), messageKeys: new Map() },
    signingKeyPublic: signing.publicKey,
    signingKeyPrivate: signing.privateKey,
  };
}

// ---- wire shapes ------------------------------------------------------------

export interface SenderKeyDistributionBody {
  id: number;
  iteration: number;
  chainKey: Uint8Array;
  signingKey: Uint8Array;
}

export function encodeSenderKeyDistributionMessage(body: SenderKeyDistributionBody): Uint8Array {
  return new ProtoWriter()
    .varint(1, body.id)
    .varint(2, body.iteration)
    .bytes(3, body.chainKey)
    .bytes(4, body.signingKey)
    .finish();
}

export function decodeSenderKeyDistributionMessage(data: Uint8Array): SenderKeyDistributionBody {
  const fields = readFields(data);
  const chainKey = getFieldBytes(fields, 3);
  const signingKey = getFieldBytes(fields, 4);
  if (!chainKey || !signingKey) throw new ProtocolError('SenderKeyDistributionMessage: missing chainKey/signingKey');
  return {
    id: getFieldVarint(fields, 1) ?? 0,
    iteration: getFieldVarint(fields, 2) ?? 0,
    chainKey,
    signingKey,
  };
}

/** Apply a received distribution message to a record (peer → us) */
export function processSenderKeyDistributionMessage(record: SenderKeyRecord, data: Uint8Array): SenderKeyState {
  const body = decodeSenderKeyDistributionMessage(data);
  record.senderKeyState = {
    keyId: body.id,
    chain: { iteration: body.iteration, chainKey: body.chainKey, messageKeys: new Map() },
    signingKeyPublic: body.signingKey,
  };
  return record.senderKeyState;
}

/** Export our state as a distribution message to share with others */
export function toSenderKeyDistributionMessage(state: SenderKeyState): Uint8Array {
  return encodeSenderKeyDistributionMessage({
    id: state.keyId,
    iteration: state.chain.iteration,
    chainKey: state.chain.chainKey,
    signingKey: state.signingKeyPublic,
  });
}

// ---- encrypt / decrypt ------------------------------------------------------

export function encryptSenderKeyMessage(record: SenderKeyRecord, plaintext: Uint8Array): Uint8Array {
  const state = record.senderKeyState;
  if (!state || !state.signingKeyPrivate) {
    throw new ProtocolError('sender-key: no local sender key state (missing signing key)');
  }
  const keys = deriveGroupMessageKeys(state.chain.chainKey);
  const ciphertext = aesCbcEncrypt(keys.cipherKey, keys.iv, plaintext);

  const proto = new ProtoWriter()
    .varint(1, state.keyId)
    .varint(2, state.chain.iteration)
    .bytes(3, ciphertext)
    .finish();

  const body = new Uint8Array(1 + proto.byteLength);
  body[0] = SENDER_VERSION_BYTE;
  body.set(proto, 1);

  const signature = calculateSignature(state.signingKeyPrivate, body);
  const out = new Uint8Array(body.byteLength + signature.byteLength);
  out.set(body, 0);
  out.set(signature, body.byteLength);

  state.chain.chainKey = nextChainKey(state.chain.chainKey);
  state.chain.iteration += 1;
  return out;
}

export function decryptSenderKeyMessage(record: SenderKeyRecord, serialized: Uint8Array): Uint8Array {
  const state = record.senderKeyState;
  if (!state) throw new DecryptionError('sender-key: no state for this sender');

  // signature length depends on the backend; ed25519 = 64 bytes
  if (serialized.byteLength < 1 + 64) throw new DecryptionError('sender-key: message too short');
  const body = serialized.subarray(0, serialized.byteLength - 64);
  const signature = serialized.subarray(serialized.byteLength - 64);

  if (body[0] !== SENDER_VERSION_BYTE) {
    throw new DecryptionError(`sender-key: unsupported version 0x${(body[0] ?? 0).toString(16)}`);
  }
  if (!verifySignature(state.signingKeyPublic, body, signature)) {
    throw new DecryptionError('sender-key: bad signature');
  }

  const fields = readFields(body.subarray(1));
  const id = getFieldVarint(fields, 1) ?? 0;
  const iteration = (getFieldVarint(fields, 2) ?? 0) as number;
  const ciphertext = getFieldBytes(fields, 3);
  if (id !== state.keyId) throw new DecryptionError(`sender-key: key id mismatch ${id} != ${state.keyId}`);
  if (!ciphertext) throw new ProtocolError('sender-key: malformed message');

  // cached key (out-of-order)
  const cached = state.chain.messageKeys.get(iteration);
  if (cached) {
    state.chain.messageKeys.delete(iteration);
    const keys = { iv: cached.subarray(0, 16), cipherKey: cached.subarray(16, 48) };
    return aesCbcDecrypt(keys.cipherKey, keys.iv, ciphertext);
  }

  if (iteration < state.chain.iteration) {
    throw new DecryptionError('sender-key: message iteration already consumed');
  }
  const MAX_ROLL = 2000;
  if (iteration - state.chain.iteration > MAX_ROLL) {
    throw new DecryptionError('sender-key: too many skipped iterations');
  }
  while (state.chain.iteration < iteration) {
    if (state.chain.messageKeys.size >= CACHE_LIMIT) {
      const oldest = state.chain.messageKeys.keys().next().value;
      if (oldest !== undefined) state.chain.messageKeys.delete(oldest);
    }
    const expanded = deriveGroupMessageKeys(state.chain.chainKey);
    const cacheEntry = new Uint8Array(48);
    cacheEntry.set(expanded.iv, 0);
    cacheEntry.set(expanded.cipherKey, 16);
    state.chain.messageKeys.set(state.chain.iteration, cacheEntry);
    state.chain.chainKey = nextChainKey(state.chain.chainKey);
    state.chain.iteration += 1;
  }

  const keys = deriveGroupMessageKeys(state.chain.chainKey);
  const plaintext = aesCbcDecrypt(keys.cipherKey, keys.iv, ciphertext);
  state.chain.chainKey = nextChainKey(state.chain.chainKey);
  state.chain.iteration += 1;
  return plaintext;
}

// ---- serialization ----------------------------------------------------------

export function serializeSenderKeyRecord(record: SenderKeyRecord): Uint8Array {
  const state = record.senderKeyState;
  if (!state) return Buffer.from(JSON.stringify({ v: 1 }));
  return Buffer.from(
    JSON.stringify({
      v: 1,
      id: state.keyId,
      iteration: state.chain.iteration,
      chainKey: Buffer.from(state.chain.chainKey).toString('hex'),
      signPub: Buffer.from(state.signingKeyPublic).toString('hex'),
      signPriv: state.signingKeyPrivate ? Buffer.from(state.signingKeyPrivate).toString('hex') : undefined,
      messageKeys: [...state.chain.messageKeys.entries()].map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
    }),
  );
}

export function deserializeSenderKeyRecord(data: Uint8Array): SenderKeyRecord {
  const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as {
    v: number;
    id?: number;
    iteration?: number;
    chainKey?: string;
    signPub?: string;
    signPriv?: string;
    messageKeys?: [number, string][];
  };
  if (parsed.id === undefined || !parsed.chainKey || !parsed.signPub) return { senderKeyState: undefined };
  const messageKeys = new Map<number, Uint8Array>();
  for (const [k, hex] of parsed.messageKeys ?? []) messageKeys.set(k, new Uint8Array(Buffer.from(hex, 'hex')));
  return {
    senderKeyState: {
      keyId: parsed.id,
      chain: {
        iteration: parsed.iteration ?? 0,
        chainKey: new Uint8Array(Buffer.from(parsed.chainKey, 'hex')),
        messageKeys,
      },
      signingKeyPublic: new Uint8Array(Buffer.from(parsed.signPub, 'hex')),
      signingKeyPrivate: parsed.signPriv ? new Uint8Array(Buffer.from(parsed.signPriv, 'hex')) : undefined,
    },
  };
}
