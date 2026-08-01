import { randomBytes } from 'node:crypto';
import { BaileysError } from '../Defaults/errors';
import { aesCbcEncrypt, hmacSha256 } from '../Signal/crypto';

/**
 * Pair-code (link-with-phone-number) utilities.
 *
 * Pair codes are 8 character `A-Z0-9` codes, conventionally rendered
 * `XXXX-XXXX`.
 */

export const PAIR_CODE_LENGTH = 8;
const PAIR_CODE_PATTERN = /^[A-Z0-9]{8}$/;

/** Normalize user input (strip dashes/spaces, uppercase) */
export function normalizePairCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Render a pair code in the canonical `XXXX-XXXX` form */
export function formatPairCode(code: string): string {
  const normalized = normalizePairCode(code);
  if (!PAIR_CODE_PATTERN.test(normalized)) {
    throw new BaileysError(`invalid pair code: "${code}"`, { code: 'ERR_INVALID_PAIR_CODE' });
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

export function isValidPairCode(input: string): boolean {
  return PAIR_CODE_PATTERN.test(normalizePairCode(input));
}

export interface NormalizedPhone {
  /** digits only, E.164 without `+` */
  digits: string;
  /** jid form */
  jid: string;
}

/**
 * Validate and normalize a phone number for pairing requests.
 * Accepts `+1234567890`, `(123) 456-7890` etc. and returns E.164 digits.
 */
export function normalizePhoneNumber(input: string): NormalizedPhone {
  const digits = input.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new BaileysError(
      `invalid phone number length (${digits.length}); expected the full international format without "+"`,
      { code: 'ERR_INVALID_PHONE', data: { input } },
    );
  }
  return { digits, jid: `${digits}@s.whatsapp.net` };
}

/**
 * Derive the companion pairing-encryption key fragment used to secure the
 * pairing payload: HMAC over (public || phone || ref) material.
 * (Server-side verification; documented as the client-side derivation.)
 */
export function computePairingKeyMaterial(pairingPublic: Uint8Array, phoneDigits: string, ref: string): Uint8Array {
  return hmacSha256(pairingPublic, Buffer.from(`${phoneDigits}@${ref}`, 'utf-8'));
}

/** Encrypt an arbitrary payload for the pairing companion exchange */
export function encryptPairingPayload(keyMaterial: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = new Uint8Array(randomBytes(16));
  const ciphertext = aesCbcEncrypt(keyMaterial, iv, plaintext);
  const out = new Uint8Array(16 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, 16);
  return out;
}
