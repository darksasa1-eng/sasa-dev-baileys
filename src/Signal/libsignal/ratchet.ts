import { hkdf, hmacSha256 } from '../crypto';

/**
 * Signal-protocol KDF functions (root-key / chain-key / message-key).
 *
 * These follow the classic libsignal constructions using HKDF-SHA256:
 * - KDF_RK: root key ratchet step → new root key + new chain key (64 bytes)
 * - KDF_CK: chain key step → message-key seed  + next chain key (HMAC 0x01/0x02)
 * - message keys: HKDF-80 from the seed → iv(16) | cipherKey(32) | macKey(32)
 */

export interface RootChainOutput {
  rootKey: Uint8Array;
  chainKey: Uint8Array;
}

const INFO_RATCHET = 'WhisperRatchet';
const INFO_MESSAGE_KEYS = 'WhatsAppMessageKeys';
const INFO_GROUP_KEYS = 'WhisperGroup';
const ZERO_SEED_32 = new Uint8Array(32);
const SEED_MESSAGE = Uint8Array.from([0x01]);
const SEED_CHAIN = Uint8Array.from([0x02]);

/** KDF_RK: derive the next root key + a new chain key from a DH output */
export function kdfRK(rootKey: Uint8Array, dhOutput: Uint8Array): RootChainOutput {
  const output = hkdf(dhOutput, 64, { salt: rootKey, info: INFO_RATCHET });
  return {
    rootKey: output.subarray(0, 32),
    chainKey: output.subarray(32, 64),
  };
}

/** KDF_CK seed: HMAC(chainKey, 0x01) — input to message key expansion */
export function chainMessageSeed(chainKey: Uint8Array): Uint8Array {
  return hmacSha256(chainKey, SEED_MESSAGE);
}

/** KDF_CK step: HMAC(chainKey, 0x02) — the next chain key */
export function nextChainKey(chainKey: Uint8Array): Uint8Array {
  return hmacSha256(chainKey, SEED_CHAIN);
}

export interface MessageKeys {
  iv: Uint8Array;
  cipherKey: Uint8Array;
  macKey: Uint8Array;
}

/** Expand message keys for personal (1:1) messages: iv | cipherKey | macKey */
export function deriveMessageKeys(chainKey: Uint8Array): MessageKeys {
  const seed = chainMessageSeed(chainKey);
  const expanded = hkdf(seed, 80, { salt: ZERO_SEED_32, info: INFO_MESSAGE_KEYS });
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
  };
}

export interface GroupMessageKeys {
  iv: Uint8Array;
  cipherKey: Uint8Array;
}

/** Expand message keys for sender-key (group) messages: iv | cipherKey */
export function deriveGroupMessageKeys(chainKey: Uint8Array): GroupMessageKeys {
  const seed = chainMessageSeed(chainKey);
  const expanded = hkdf(seed, 96, { salt: ZERO_SEED_32, info: INFO_GROUP_KEYS });
  return {
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
  };
}
