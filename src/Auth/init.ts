import { randomBytes } from 'node:crypto';
import type { AuthenticationCreds, AuthenticationState } from './types';
import { generateKeyPair } from '../Signal/curve';
import { generatePreKey, generateRegistrationId, generateSignedPreKey } from '../Signal/key-helper';
import { InMemorySignalKeyStore } from '../Signal/libsignal/storage';

/**
 * Create credentials for a brand-new device registration. All key material
 * comes from the OS RNG (`node:crypto`) — never reuse across devices.
 */
export function initAuthCreds(): AuthenticationCreds {
  const signedIdentityKey = generateKeyPair();
  return {
    noiseKey: generateKeyPair(),
    pairingEphemeralKeyPair: generateKeyPair(),
    signedIdentityKey,
    signedPreKey: generateSignedPreKey(signedIdentityKey, 1),
    registrationId: generateRegistrationId(),
    advSecretKey: randomBytes(32).toString('base64'),

    processedHistoryItems: [],
    nextPreKeyId: 2, // 1 is the signed prekey id
    firstUnuploadedPreKeyId: 2,
    accountSyncCounter: 0,
    accountSettings: { unarchiveChats: false },

    registered: false,
  };
}

/** Fresh in-memory auth state (the legacy `useMemoryAuthState` equivalent) */
export function makeInMemoryAuthState(): AuthenticationState {
  return { creds: initAuthCreds(), keys: new InMemorySignalKeyStore() };
}

/** Mint a batch of pre-keys continuing from the credential sequence */
export function generatePreKeys(creds: AuthenticationCreds, count: number): { keyId: number; keyPair: ReturnType<typeof generateKeyPair> }[] {
  const out = [];
  for (let i = 0; i < count; i++) out.push(generatePreKey(creds.nextPreKeyId + i));
  return out;
}
