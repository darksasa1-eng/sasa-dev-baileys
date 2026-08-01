import { timingSafeEqual } from 'node:crypto';
import { ProtocolError } from '../Defaults/errors';

/**
 * Buffer helpers used by the binary codec and crypto modules.
 * Everything works on `Uint8Array`; Node `Buffer` satisfies that type.
 */

export function toUint8(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === 'string') return Buffer.from(data, 'utf-8');
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Constant-time byte comparison; length-safe */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function bytesToHex(data: Uint8Array): string {
  return Buffer.from(data).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new ProtocolError('hexToBytes: odd-length hex string');
  return Buffer.from(hex, 'hex');
}

/** Encode up to a 32-bit integer as big-endian bytes */
export function encodeBigEndian(value: number, byteLength = 4): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError(`encodeBigEndian: invalid value ${value}`);
  const out = new Uint8Array(byteLength);
  let v = value;
  for (let i = byteLength - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v >>>= 8;
  }
  if (v !== 0) throw new ProtocolError(`encodeBigEndian: value ${value} does not fit in ${byteLength} bytes`);
  return out;
}

export function readUInt24BE(data: Uint8Array, offset = 0): number {
  assertBounds(data, offset, 3, 'readUInt24BE');
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return (data[offset]! << 16) | (data[offset + 1]! << 8) | data[offset + 2]!;
}

export function readUInt32BE(data: Uint8Array, offset = 0): number {
  assertBounds(data, offset, 4, 'readUInt32BE');
  return Buffer.from(data).readUInt32BE(offset);
}

export function readUInt16BE(data: Uint8Array, offset = 0): number {
  assertBounds(data, offset, 2, 'readUInt16BE');
  return Buffer.from(data).readUInt16BE(offset);
}

export function readUInt8(data: Uint8Array, offset = 0): number {
  assertBounds(data, offset, 1, 'readUInt8');
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return data[offset]!;
}

/**
 * Slice with a hard bound check. Any out-of-range read in the decoder must
 * throw a {@link ProtocolError} — never crash with an obscure index error.
 */
export function safeSlice(data: Uint8Array, start: number, length: number): Uint8Array {
  assertBounds(data, start, length, 'safeSlice');
  return data.subarray(start, start + length);
}

export function assertBounds(data: Uint8Array, offset: number, length: number, ctx: string): void {
  if (offset < 0 || length < 0 || offset + length > data.byteLength) {
    throw new ProtocolError(`${ctx}: out of bounds read (offset ${offset}, length ${length}, size ${data.byteLength})`);
  }
}
