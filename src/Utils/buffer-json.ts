/**
 * Buffer-aware JSON codec. `Buffer`/`Uint8Array` values survive a
 * stringify→parse round trip. Everything is tagged so arbitrary user data
 * that merely *looks* like a marker cannot collide.
 */

const TAG = '@@uint8array:';

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return `${TAG}${Buffer.from(value).toString('base64')}`;
  }
  // Node Buffers nested inside plain objects from JSON.parse of older formats
  if (isLegacyBufferObject(value)) {
    return `${TAG}${Buffer.from(value.data).toString('base64')}`;
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(TAG)) {
    return new Uint8Array(Buffer.from(value.slice(TAG.length), 'base64'));
  }
  if (isLegacyBufferObject(value)) {
    return new Uint8Array(Buffer.from(value.data));
  }
  return value;
}

function isLegacyBufferObject(value: unknown): value is { type: 'Buffer'; data: number[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  );
}

export const BufferJSON = {
  stringify(value: unknown, space?: number): string {
    return JSON.stringify(value, replacer, space);
  },
  parse<T = unknown>(text: string): T {
    return JSON.parse(text, reviver) as T;
  },
};

/** Deep-convert all Buffers in a JSON-parsed structure back to Uint8Array */
export function reviveBuffersDeep<T>(value: T): T {
  return BufferJSON.parse(BufferJSON.stringify(value)) as T;
}
