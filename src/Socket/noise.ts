import { HandshakeError } from '../Defaults/errors';
import type { KeyPair } from '../Auth/types';
import { aesGcmDecrypt, aesGcmEncrypt, hkdf, sha256 } from '../Signal/crypto';
import { calculateAgreement, generateKeyPair } from '../Signal/curve';
import { concatBytes } from '../Utils/buffer';

/**
 * Noise Protocol Framework: Noise_XX_25519_AESGCM_SHA256
 * (the handshake WhatsApp Web multi-device uses).
 *
 * This implementation is transport-agnostic: callers feed handshake bytes in
 * and pass produced bytes out, which makes both roles testable in-process.
 * Frames after the handshake are AES-256-GCM sealed with hash-chained keys.
 */

export const NOISE_PROTOCOL_NAME = 'Noise_XX_25519_AESGCM_SHA256';

/** Transport magic prefix sent before handshake msg 1 ("WA" 0x06 0x03) */
export const NOISE_WA_HEADER = Uint8Array.from([87, 65, 6, 3]);

const MAX_NONCE = 0xffffffff;

function buildPrologue(): Uint8Array {
  const enc = new TextEncoder().encode(NOISE_PROTOCOL_NAME);
  const out = new Uint8Array(enc.byteLength + 4);
  out.set(enc, 0);
  // WA appends a 4-byte big-endian "edge-routing" version
  out.set([0, 0, 0, 2], enc.byteLength);
  return out;
}

export interface NoiseHandshakeHooks {
  /**
   * Verify the peer's static key / certificate material.
   * Throw (or return false) to abort the handshake.
   */
  verifyPeerStaticKey?: (staticKey: Uint8Array, payload: Uint8Array) => boolean | Promise<boolean>;
}

class CipherState {
  key?: Uint8Array;
  nonce = 0;

  initializeKey(key: Uint8Array): void {
    this.key = key;
    this.nonce = 0;
  }

  hasKey(): boolean {
    return this.key !== undefined;
  }

  #nonceBytes(): Uint8Array {
    if (this.nonce > MAX_NONCE) throw new HandshakeError('noise cipher nonce exhausted');
    // Noise spec: 96-bit nonce = 4 zero bytes || 8-byte big-endian counter
    const iv = new Uint8Array(12);
    const n = this.nonce;
    // high 4 bytes remain 0 while nonce < 2^32
    iv[8] = (n >>> 24) & 0xff;
    iv[9] = (n >>> 16) & 0xff;
    iv[10] = (n >>> 8) & 0xff;
    iv[11] = n & 0xff;
    this.nonce += 1;
    return iv;
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext;
    return aesGcmEncrypt(this.key, this.#nonceBytes(), plaintext, ad);
  }

  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext;
    return aesGcmDecrypt(this.key, this.#nonceBytes(), ciphertext, ad);
  }
}

export type NoiseRole = 'initiator' | 'responder';

export class NoiseHandshake {
  readonly role: NoiseRole;
  readonly #staticKeyPair: KeyPair;
  readonly #hooks: NoiseHandshakeHooks;

  #hash: Uint8Array;
  #chainingKey: Uint8Array;
  #cipher = new CipherState();
  #ephemeral?: KeyPair;
  #remoteEphemeral?: Uint8Array;
  #remoteStatic?: Uint8Array;
  #messages = 0;
  #finished = false;

  constructor(opts: { role: NoiseRole; staticKeyPair: KeyPair; hooks?: NoiseHandshakeHooks }) {
    this.role = opts.role;
    this.#staticKeyPair = opts.staticKeyPair;
    this.#hooks = opts.hooks ?? {};
    const prologue = buildPrologue();
    const hashedPrologue = sha256(prologue);
    this.#hash = hashedPrologue;
    this.#chainingKey = hashedPrologue;
  }

  get finished(): boolean {
    return this.#finished;
  }

  get remoteStaticKey(): Uint8Array | undefined {
    return this.#remoteStatic;
  }

  #mixHash(data: Uint8Array): void {
    this.#hash = sha256(concatBytes(this.#hash, data));
  }

  #mixKey(inputKeyMaterial: Uint8Array): void {
    const output = hkdf(inputKeyMaterial, 64, { salt: this.#chainingKey });
    this.#chainingKey = output.subarray(0, 32);
    this.#cipher.initializeKey(output.subarray(32, 64));
  }

  #encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.#cipher.encrypt(this.#hash, plaintext);
    this.#mixHash(ct);
    return ct;
  }

  #decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.#cipher.decrypt(this.#hash, ciphertext);
    this.#mixHash(ciphertext);
    return pt;
  }

  #dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    try {
      return calculateAgreement(publicKey, privateKey);
    } catch (err) {
      throw new HandshakeError('noise DH failed', { cause: err });
    }
  }

  /**
   * Produce the next handshake message.
   * - initiator: msg1 (e + plaintext payload), msg3 (enc(s) + enc payload)
   * - responder: msg2 (e + enc stuff), after receiving msg1
   */
  generateHandshakeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.#finished) throw new HandshakeError('handshake already finished');

    if (this.role === 'initiator') {
      if (this.#messages === 0) {
        // -> e
        this.#ephemeral = generateKeyPair();
        this.#mixHash(this.#ephemeral.publicKey);
        this.#messages = 1;
        return concatBytes(this.#ephemeral.publicKey, payload);
      }
      if (this.#messages === 2) {
        // -> s, se  (initiator static encrypted, then DH(s_local, re))
        if (!this.#remoteEphemeral) throw new HandshakeError('missing remote ephemeral for msg3');
        const encStatic = this.#encryptAndHash(this.#staticKeyPair.publicKey);
        this.#mixKey(this.#dh(this.#staticKeyPair.privateKey, this.#remoteEphemeral));
        const encPayload = this.#encryptAndHash(payload);
        this.#messages = 3;
        this.#finished = true;
        return concatBytes(encStatic, encPayload);
      }
      throw new HandshakeError('initiator out of turn');
    }

    // responder: msg2 <- e, ee, s, es
    if (this.#messages !== 1 || !this.#ephemeral || !this.#remoteEphemeral) {
      throw new HandshakeError('responder out of turn');
    }
    this.#mixHash(this.#ephemeral.publicKey);
    // ee = DH(initiator ephemeral, responder ephemeral)
    this.#mixKey(this.#dh(this.#ephemeral.privateKey, this.#remoteEphemeral));
    // s (encrypted own static)
    const encStatic = this.#encryptAndHash(this.#staticKeyPair.publicKey);
    // es = DH(initiator ephemeral, responder static)
    const esSecret = this.#dh(this.#staticKeyPair.privateKey, this.#remoteEphemeral);
    this.#mixKey(esSecret);
    const encPayload = this.#encryptAndHash(payload);
    this.#messages = 2;
    return concatBytes(this.#ephemeral.publicKey, encStatic, encPayload);
  }

  /** Consume a handshake message from the peer; returns its decrypted payload */
  receiveHandshakeMessage(data: Uint8Array): Uint8Array {
    if (this.#finished) throw new HandshakeError('handshake already finished');

    if (this.role === 'initiator') {
      // <- e, ee, s, es
      if (this.#messages !== 1) throw new HandshakeError('initiator expected to receive msg2');
      if (data.byteLength < 32 + 48) throw new HandshakeError('msg2 too short');
      this.#remoteEphemeral = data.subarray(0, 32);
      this.#mixHash(this.#remoteEphemeral);
      this.#mixKey(this.#dh(this.#ephemeral!.privateKey, this.#remoteEphemeral)); // ee
      const encStatic = data.subarray(32, 32 + 48);
      this.#remoteStatic = this.#decryptAndHash(encStatic); // s
      this.#mixKey(this.#dh(this.#ephemeral!.privateKey, this.#remoteStatic)); // es
      const payload = this.#decryptAndHash(data.subarray(80));
      this.#messages = 2;
      this.#hookVerify('responder-static', this.#remoteStatic, payload);
      return payload;
    }

    if (this.#messages === 0) {
      // -> e (msg1)
      if (data.byteLength < 32) throw new HandshakeError('msg1 too short');
      this.#remoteEphemeral = data.subarray(0, 32);
      this.#mixHash(this.#remoteEphemeral);
      this.#ephemeral = generateKeyPair();
      this.#messages = 1;
      return data.subarray(32); // plaintext payload (client hello)
    }

    if (this.#messages === 2) {
      // -> s, se (msg3)
      if (data.byteLength < 48) throw new HandshakeError('msg3 too short');
      const encStatic = data.subarray(0, 48);
      this.#remoteStatic = this.#decryptAndHash(encStatic); // s
      this.#mixKey(this.#dh(this.#ephemeral!.privateKey, this.#remoteStatic)); // se
      const payload = this.#decryptAndHash(data.subarray(48));
      this.#messages = 3;
      this.#finished = true;
      this.#hookVerify('initiator-static', this.#remoteStatic, payload);
      return payload;
    }

    throw new HandshakeError('responder out of turn');
  }

  #hookVerify(which: 'responder-static' | 'initiator-static', staticKey: Uint8Array, payload: Uint8Array): void {
    const verdict = this.#hooks.verifyPeerStaticKey?.(staticKey, payload);
    if (verdict === false) throw new HandshakeError(`${which} rejected by verification hook`);
    if (verdict instanceof Promise) {
      throw new HandshakeError('async verifyPeerStaticKey hooks are not supported in receiveHandshakeMessage');
    }
  }

  /**
   * Split the handshake into traffic ciphers (call after {@link finished}).
   * Returns `{ send, receive }` cipher states keyed per direction.
   */
  split(): { send: NoiseTrafficCipher; receive: NoiseTrafficCipher } {
    if (!this.#finished) throw new HandshakeError('split: handshake not finished');
    const output = hkdf(new Uint8Array(0), 64, { salt: this.#chainingKey });
    const k1 = output.slice(0, 32);
    const k2 = output.slice(32, 64);
    return this.role === 'initiator'
      ? { send: new NoiseTrafficCipher(k1), receive: new NoiseTrafficCipher(k2) }
      : { send: new NoiseTrafficCipher(k2), receive: new NoiseTrafficCipher(k1) };
  }
}

/** Post-handshake frame cipher (AES-256-GCM, counter nonces) */
export class NoiseTrafficCipher {
  #key: Uint8Array;
  #nonce = 0;

  constructor(key: Uint8Array) {
    this.#key = key;
  }

  #nonceBytes(): Uint8Array {
    if (this.#nonce > MAX_NONCE) throw new HandshakeError('traffic cipher nonce exhausted');
    const iv = new Uint8Array(12);
    const n = this.#nonce;
    iv[8] = (n >>> 24) & 0xff;
    iv[9] = (n >>> 16) & 0xff;
    iv[10] = (n >>> 8) & 0xff;
    iv[11] = n & 0xff;
    this.#nonce += 1;
    return iv;
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    return aesGcmEncrypt(this.#key, this.#nonceBytes(), plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    return aesGcmDecrypt(this.#key, this.#nonceBytes(), ciphertext);
  }
}
