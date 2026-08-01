import { randomBytes } from 'node:crypto';
import type { KeyPair, PreKey, SignedPreKey } from '../Auth/types';
import { calculateSignature, generateKeyPair } from './curve';

/** Generate a 14-bit registration id (1..16380) */
export function generateRegistrationId(): number {
  const bytes = randomBytes(2);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const uint16 = (bytes[0]! << 8) | bytes[1]!;
  return (uint16 & 0x3fff) || 1;
}

/** Generate a fresh pre-key (id sequencing is caller-managed) */
export function generatePreKey(keyId: number): PreKey {
  return { keyId, keyPair: generateKeyPair() };
}

/**
 * Generate a signed pre-key: a Curve25519 key pair whose public key is
 * signed with the identity private key.
 */
export function generateSignedPreKey(identityKeyPair: KeyPair, keyId: number): SignedPreKey {
  const keyPair = generateKeyPair();
  const signature = calculateSignature(identityKeyPair.privateKey, keyPair.publicKey);
  return { keyId, keyPair, signature };
}
