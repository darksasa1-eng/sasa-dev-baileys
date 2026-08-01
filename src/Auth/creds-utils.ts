import { BaileysError } from '../Defaults/errors';
import type { AuthenticationCreds } from './types';

/**
 * Structural validation of loaded credentials. Storage corruption or a
 * version-skewed file throws here instead of deep inside the handshake.
 */
export function validateCreds(creds: unknown): asserts creds is AuthenticationCreds {
  const c = creds as Partial<AuthenticationCreds> | undefined;
  const problems: string[] = [];
  if (!c || typeof c !== 'object') problems.push('credentials are not an object');
  else {
    if (!c.noiseKey?.publicKey || !c.noiseKey?.privateKey) problems.push('noiseKey missing or incomplete');
    if (!c.signedIdentityKey?.publicKey || !c.signedIdentityKey?.privateKey)
      problems.push('signedIdentityKey missing or incomplete');
    if (!c.signedPreKey?.keyPair?.publicKey) problems.push('signedPreKey missing or incomplete');
    if (typeof c.registrationId !== 'number') problems.push('registrationId missing');
    if (typeof c.nextPreKeyId !== 'number') problems.push('nextPreKeyId missing');
  }
  if (problems.length > 0) {
    throw new BaileysError(`invalid credentials: ${problems.join('; ')}`, {
      code: 'ERR_INVALID_CREDS',
      data: { problems },
    });
  }
}

/** Shallow check whether two creds snapshots differ (used to debounce saves) */
export function credsEqual(a: AuthenticationCreds, b: AuthenticationCreds): boolean {
  return a.me?.id === b.me?.id && a.lastPropHash === b.lastPropHash && a.registered === b.registered;
}
