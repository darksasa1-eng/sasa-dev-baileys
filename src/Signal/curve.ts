import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import type { KeyPair } from '../Auth/types';

/**
 * Curve25519 backend abstraction.
 *
 * The default backend uses Node's native crypto:
 * - X25519 for Diffie–Hellman agreement (`generateKeyPair`, `calculateAgreement`)
 * - Ed25519 detached signatures for `calculateSignature` / `verifySignature`
 *
 * WhatsApp's libsignal uses VXEdDSA signatures over Curve25519. If you need
 * byte-level compatibility for signature verification on the server side,
 * inject a libsignal-compatible backend with {@link setCurveBackend}.
 */
export interface CurveBackend {
  /** ECDH-capable key pair (Curve25519) */
  generateKeyPair(): KeyPair;
  /** Signature-capable key pair whose public key verifies `calculateSignature` output */
  generateSigningKeyPair(): KeyPair;
  calculateAgreement(publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array;
  calculateSignature(privateKey: Uint8Array, message: Uint8Array): Uint8Array;
  verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
}

// ---- X25519 raw-key plumbing -----------------------------------------------

// DER prefixes for X25519 keys (RFC 8410): 12-byte SPKI / 16-byte PKCS8 headers
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function x25519Private(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  });
}

function x25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

function ed25519Private(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  });
}

function ed25519Public(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

function exportRawPublic(keyObject: KeyObject): Uint8Array {
  const der = keyObject.export({ format: 'der', type: 'spki' }) as Buffer;
  return new Uint8Array(der.subarray(der.byteLength - 32));
}

function exportRawPrivate(keyObject: KeyObject): Uint8Array {
  const der = keyObject.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return new Uint8Array(der.subarray(der.byteLength - 32));
}

// ---- default (native Node) backend ------------------------------------------

const nativeBackend: CurveBackend = {
  generateKeyPair(): KeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    return { publicKey: exportRawPublic(publicKey), privateKey: exportRawPrivate(privateKey) };
  },
  generateSigningKeyPair(): KeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { publicKey: exportRawPublic(publicKey), privateKey: exportRawPrivate(privateKey) };
  },
  calculateAgreement(publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array {
    if (publicKey.byteLength !== 32 || privateKey.byteLength !== 32) {
      throw new Error('curve: X25519 keys must be 32 bytes');
    }
    return new Uint8Array(diffieHellman({ privateKey: x25519Private(privateKey), publicKey: x25519Public(publicKey) }));
  },
  // The default signature backend is Ed25519; the private key's raw bytes are
  // used as the Ed25519 seed. Signatures produced over keys from
  // `generateSigningKeyPair()` verify correctly with `verifySignature()`
  // against that pair's public key. Signatures over X25519 (ECDH) key bytes
  // are one-way under this backend (no Curve25519↔Ed25519 point mapping in
  // Node) — match VXEdDSA semantics by injecting a libsignal backend.
  calculateSignature(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
    // Ed25519 PKCS8 seed must be exactly 32 bytes; X25519 private keys are 32 bytes.
    return new Uint8Array(edSign(null, Buffer.from(message), ed25519Private(privateKey)));
  },
  verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    try {
      return edVerify(null, Buffer.from(message), ed25519Public(publicKey), Buffer.from(signature));
    } catch {
      return false;
    }
  },
};

let backend: CurveBackend = nativeBackend;

/** Replace the curve backend (e.g. with a WASM libsignal implementation) */
export function setCurveBackend(custom: CurveBackend): void {
  backend = custom;
}

/** Restore Node's native backend */
export function resetCurveBackend(): void {
  backend = nativeBackend;
}

// ---- libsignal-compatible API surface ---------------------------------------

/** Generate a random Curve25519 key pair (32-byte public/private) for ECDH */
export function generateKeyPair(): KeyPair {
  return backend.generateKeyPair();
}

/**
 * Generate a signature-capable key pair. With the native backend this is an
 * Ed25519 pair; use it for sender-key signing keys and identity signatures
 * that must verify with {@link verifySignature}.
 */
export function generateSigningKeyPair(): KeyPair {
  return backend.generateSigningKeyPair();
}

/** Curve25519 Diffie–Hellman shared secret */
export function calculateAgreement(publicKey: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return backend.calculateAgreement(publicKey, privateKey);
}

/** Detached signature over `message` with `privateKey` */
export function calculateSignature(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return backend.calculateSignature(privateKey, message);
}

/** Verify a detached signature; never throws */
export function verifySignature(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return backend.verifySignature(publicKey, message, signature);
}
