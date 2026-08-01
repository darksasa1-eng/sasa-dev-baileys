import { BaileysError } from '../Defaults/errors';

/**
 * QR login utilities.
 *
 * WhatsApp QR payloads are comma-separated: `ref,publicKey,clientId[,...]`.
 * Refs rotate roughly every 20 seconds and expire after the server's TTL —
 * the client API emits every new ref through `connection.update` so UI can
 * re-render promptly.
 */

export interface QrPayload {
  /** Server-generated rotating reference */
  ref: string;
  /** base64 ephemeral public key of this device */
  publicKey: string;
  /** base64 client identifier */
  clientId: string;
  /** Any additional segments newer servers append */
  extra: string[];
}

/** Build the string encoded into the QR image */
export function buildQrPayload(ref: string, publicKey: Uint8Array, clientId: Uint8Array): string {
  return [ref, Buffer.from(publicKey).toString('base64'), Buffer.from(clientId).toString('base64')].join(',');
}

/** Parse a QR payload; throws a typed error on malformed input */
export function parseQrPayload(qr: string): QrPayload {
  const parts = qr.split(',');
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new BaileysError('invalid QR payload', { code: 'ERR_INVALID_QR', data: { parts: parts.length } });
  }
  const [ref, publicKey, clientId, ...extra] = parts as [string, string, string, ...string[]];
  return { ref, publicKey, clientId, extra };
}

/** QRs older than this should be considered stale by UIs */
export const QR_REF_TTL_MS = 20_000;
/** Absolute expiry: after this, the server will reject the ref */
export const QR_TIMEOUT_MS = 60_000;
