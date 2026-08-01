import { ProtocolError } from '../Defaults/errors';

/**
 * Minimal protobuf wire-format codec (varint + length-delimited fields only).
 * Enough to encode/decode Signal protocol message envelopes without pulling
 * in a full protobuf runtime.
 */

export const WIRE_VARINT = 0;
export const WIRE_LENGTH_DELIMITED = 2;

export function writeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolError(`writeVarint: bad value ${value}`);
  const out: number[] = [];
  let v = value;

  while (true) {
    if (v < 0x80) {
      out.push(v);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  return Uint8Array.from(out);
}

export function readVarint(data: Uint8Array, indexRef: { index: number }): number {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    if (indexRef.index >= data.byteLength) throw new ProtocolError('readVarint: EOS');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const byte = data[indexRef.index++]!;
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  throw new ProtocolError('readVarint: varint too long');
}

function fieldKey(fieldNumber: number, wireType: number): number {
  return (fieldNumber << 3) | wireType;
}

export class ProtoWriter {
  #parts: Uint8Array[] = [];

  varint(fieldNumber: number, value: number | undefined): this {
    if (value === undefined || value === 0) return this;
    this.#parts.push(writeVarint(fieldKey(fieldNumber, WIRE_VARINT)));
    this.#parts.push(writeVarint(value));
    return this;
  }

  bytes(fieldNumber: number, value: Uint8Array | undefined): this {
    if (value === undefined || value.byteLength === 0) return this;
    this.#parts.push(writeVarint(fieldKey(fieldNumber, WIRE_LENGTH_DELIMITED)));
    this.#parts.push(writeVarint(value.byteLength));
    this.#parts.push(value);
    return this;
  }

  finish(): Uint8Array {
    let total = 0;
    for (const p of this.#parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of this.#parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out;
  }
}

export interface ProtoField {
  fieldNumber: number;
  wireType: number;
  /** present when wireType === WIRE_VARINT */
  varint?: number;
  /** present when wireType === WIRE_LENGTH_DELIMITED */
  bytes?: Uint8Array;
}

/** Iterate fields of a protobuf payload (bounds-checked, unknown wire types rejected) */
export function readFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  const indexRef = { index: 0 };
  while (indexRef.index < data.byteLength) {
    const key = readVarint(data, indexRef);
    const fieldNumber = key >>> 3;
    const wireType = key & 0x7;
    if (wireType === WIRE_VARINT) {
      fields.push({ fieldNumber, wireType, varint: readVarint(data, indexRef) });
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(data, indexRef);
      if (indexRef.index + length > data.byteLength) throw new ProtocolError('readFields: LEN overruns buffer');
      const bytes = data.subarray(indexRef.index, indexRef.index + length);
      indexRef.index += length;
      fields.push({ fieldNumber, wireType, bytes });
    } else {
      throw new ProtocolError(`readFields: unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

export function getFieldVarint(fields: ProtoField[], fieldNumber: number): number | undefined {
  return fields.find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_VARINT)?.varint;
}

export function getFieldBytes(fields: ProtoField[], fieldNumber: number): Uint8Array | undefined {
  return fields.find((f) => f.fieldNumber === fieldNumber && f.wireType === WIRE_LENGTH_DELIMITED)?.bytes;
}
