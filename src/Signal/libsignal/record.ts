import type { KeyPair } from '../../Auth/types';

/**
 * Serializable signal session state ("session record").
 * Persisted per `<address>.<device>` in the signal key store.
 */

export interface ChainState {
  /** Chain key seed for the next KDF_CK step */
  chainKey: Uint8Array;
  /** How many KDF_CK steps have been taken on this chain */
  counter: number;
}

export interface SendingChain extends ChainState {
  /** Our current ratchet DH key pair for this session */
  ratchetKeyPair: KeyPair;
}

export interface ReceivingChain extends ChainState {
  /** The peer's ratchet public key that produced this chain */
  ratchetPublicKey: Uint8Array;
  /** Out-of-order message keys: counter → 80-byte expanded key material */
  messageKeys: Map<number, Uint8Array>;
}

export interface SessionState {
  rootKey: Uint8Array;
  /** Local identity public key */
  localIdentityKey: Uint8Array;
  /** Remote identity public key */
  remoteIdentityKey: Uint8Array;
  localRegistrationId: number;
  remoteRegistrationId: number;
  /** Peer's current ratchet public key (their signed-prekey at init) */
  remoteRatchetKey?: Uint8Array;
  sendingChain?: SendingChain;
  receivingChains: ReceivingChain[];
  /** sending-chain counter before the last ratchet step (msg.prevCounter) */
  previousCounter: number;
  /** Marked once we have successfully exchanged at least one message */
  established: boolean;
}

export interface SessionRecord {
  state: SessionState;
}

/** Bump when the (internal) record layout changes — old records are dropped */
export const SESSION_RECORD_VERSION = 1;

const MAX_RECEIVING_CHAINS = 5;
const MAX_CACHED_MESSAGE_KEYS = 2030; // libsignal rounds to 2030

export function createSessionState(input: {
  rootKey: Uint8Array;
  localIdentityKey: Uint8Array;
  remoteIdentityKey: Uint8Array;
  localRegistrationId: number;
  remoteRegistrationId: number;
  remoteRatchetKey: Uint8Array;
}): SessionState {
  return {
    rootKey: input.rootKey,
    localIdentityKey: input.localIdentityKey,
    remoteIdentityKey: input.remoteIdentityKey,
    localRegistrationId: input.localRegistrationId,
    remoteRegistrationId: input.remoteRegistrationId,
    remoteRatchetKey: input.remoteRatchetKey,
    receivingChains: [],
    previousCounter: 0,
    established: false,
  };
}

export function pushReceivingChain(state: SessionState, chain: ReceivingChain): void {
  state.receivingChains.unshift(chain);
  if (state.receivingChains.length > MAX_RECEIVING_CHAINS) state.receivingChains.pop();
}

export function findReceivingChain(state: SessionState, ratchetPublicKey: Uint8Array): ReceivingChain | undefined {
  return state.receivingChains.find((c) => Buffer.from(c.ratchetPublicKey).equals(Buffer.from(ratchetPublicKey)));
}

const HEX = (data: Uint8Array): string => Buffer.from(data).toString('hex');
const UNHEX = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

/**
 * Serialize a session record to bytes (version prefix + JSON with hex keys).
 * Binary fields are hex — sessions are small and this keeps the format
 * debuggable while staying ~2x more compact than base64 JSON.
 */
export function serializeSession(record: SessionRecord): Uint8Array {
  const state = record.state;
  const json = {
    v: SESSION_RECORD_VERSION,
    s: {
      rootKey: HEX(state.rootKey),
      localIdentityKey: HEX(state.localIdentityKey),
      remoteIdentityKey: HEX(state.remoteIdentityKey),
      localRegistrationId: state.localRegistrationId,
      remoteRegistrationId: state.remoteRegistrationId,
      remoteRatchetKey: state.remoteRatchetKey ? HEX(state.remoteRatchetKey) : undefined,
      sendingChain: state.sendingChain
        ? {
            chainKey: HEX(state.sendingChain.chainKey),
            counter: state.sendingChain.counter,
            ratchetKeyPair: {
              publicKey: HEX(state.sendingChain.ratchetKeyPair.publicKey),
              privateKey: HEX(state.sendingChain.ratchetKeyPair.privateKey),
            },
          }
        : undefined,
      receivingChains: state.receivingChains.map((c) => ({
        chainKey: HEX(c.chainKey),
        counter: c.counter,
        ratchetPublicKey: HEX(c.ratchetPublicKey),
        messageKeys: [...c.messageKeys.entries()].map(([counter, key]) => [counter, HEX(key)] as const),
      })),
      previousCounter: state.previousCounter,
      established: state.established,
    },
  };
  return Buffer.from(JSON.stringify(json), 'utf-8');
}

export function deserializeSession(bytes: Uint8Array): SessionRecord {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as {
    v: number;
    s: {
      rootKey: string;
      localIdentityKey: string;
      remoteIdentityKey: string;
      localRegistrationId: number;
      remoteRegistrationId: number;
      remoteRatchetKey?: string;
      sendingChain?: {
        chainKey: string;
        counter: number;
        ratchetKeyPair: { publicKey: string; privateKey: string };
      };
      receivingChains?: {
        chainKey: string;
        counter: number;
        ratchetPublicKey: string;
        messageKeys?: (readonly [number, string])[];
      }[];
      previousCounter: number;
      established: boolean;
    };
  };
  if (parsed.v !== SESSION_RECORD_VERSION) {
    throw new Error(`session record version mismatch: ${parsed.v} !== ${SESSION_RECORD_VERSION}`);
  }
  const s = parsed.s;
  const chains = (s.receivingChains ?? []).map((c) => {
    const mk = new Map<number, Uint8Array>();
    for (const [counter, hex] of c.messageKeys ?? []) mk.set(counter, UNHEX(hex));
    // bound cache growth on load as well
    while (mk.size > MAX_CACHED_MESSAGE_KEYS) {
      const oldest = mk.keys().next().value;
      if (oldest === undefined) break;
      mk.delete(oldest);
    }
    return {
      chainKey: UNHEX(c.chainKey),
      counter: c.counter,
      ratchetPublicKey: UNHEX(c.ratchetPublicKey),
      messageKeys: mk,
    };
  });
  return {
    state: {
      rootKey: UNHEX(s.rootKey),
      localIdentityKey: UNHEX(s.localIdentityKey),
      remoteIdentityKey: UNHEX(s.remoteIdentityKey),
      localRegistrationId: s.localRegistrationId,
      remoteRegistrationId: s.remoteRegistrationId,
      remoteRatchetKey: s.remoteRatchetKey ? UNHEX(s.remoteRatchetKey) : undefined,
      sendingChain: s.sendingChain
        ? {
            chainKey: UNHEX(s.sendingChain.chainKey),
            counter: s.sendingChain.counter,
            ratchetKeyPair: {
              publicKey: UNHEX(s.sendingChain.ratchetKeyPair.publicKey),
              privateKey: UNHEX(s.sendingChain.ratchetKeyPair.privateKey),
            },
          }
        : undefined,
      receivingChains: chains,
      previousCounter: s.previousCounter,
      established: s.established,
    },
  };
}

export const MESSAGE_KEY_CACHE_LIMIT = MAX_CACHED_MESSAGE_KEYS;
