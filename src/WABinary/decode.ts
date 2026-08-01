import { inflateSync } from 'node:zlib';
import { ProtocolError } from '../Defaults/errors';
import { getServerFromDomainType, jidEncode } from '../Utils/jids';
import { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } from './constants';
import type { BinaryNode, DecodeOptions } from './types';

/** DoS guards — packets from the network are untrusted */
const LIMITS = {
  MAX_INFLATED_SIZE: 64 * 1024 * 1024,
  MAX_STRING_BYTES: 16 * 1024 * 1024,
  MAX_LIST_SIZE: 1_000_000,
  MAX_DEPTH: 256,
} as const;

export { LIMITS as WABINARY_LIMITS };

/**
 * Remove the transport flag byte and inflate the payload when flagged.
 * Byte 0: bit 1 (0x02) set → zlib compressed remainder; 0x00 → raw.
 */
export function decompressingIfRequired(buffer: Uint8Array, maxInflatedSize = LIMITS.MAX_INFLATED_SIZE): Uint8Array {
  if (buffer.byteLength === 0) throw new ProtocolError('decode: empty frame');
  const flags = buffer[0] ?? 0;
  const body = buffer.subarray(1);
  if ((flags & 2) !== 0) {
    try {
      return inflateSync(Buffer.from(body), { maxOutputLength: maxInflatedSize });
    } catch (err) {
      throw new ProtocolError('decode: failed to inflate compressed payload (possibly oversized or corrupt)', {
        cause: err,
      });
    }
  }
  return body;
}

/** Decode one complete {@link BinaryNode} from a transport frame. */
export function decodeBinaryNode(frame: Uint8Array, opts: DecodeOptions = {}): BinaryNode {
  const decompressed = decompressingIfRequired(frame, opts.maxInflatedSize ?? LIMITS.MAX_INFLATED_SIZE);
  return decodeDecompressedBinaryNode(decompressed, opts);
}

/**
 * Decode from an already-decompressed buffer. Exposes `index` so callers can
 * parse sequential nodes from one stream buffer.
 */
export function decodeDecompressedBinaryNode(
  buffer: Uint8Array,
  opts: DecodeOptions = {},
  indexRef: { index: number } = { index: 0 },
  depth = 0,
): BinaryNode {
  const strict = opts.strict ?? false;
  if (depth > LIMITS.MAX_DEPTH) throw new ProtocolError(`decode: node nesting exceeds ${LIMITS.MAX_DEPTH}`);
  if (indexRef.index >= buffer.byteLength) throw new ProtocolError('decode: unexpected end of frame');

  const readByte = (): number => {
    if (indexRef.index + 1 > buffer.byteLength) throw new ProtocolError(`decode: EOS at ${indexRef.index}`);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return buffer[indexRef.index++]!;
  };

  const readBytes = (n: number): Uint8Array => {
    if (n < 0 || indexRef.index + n > buffer.byteLength) {
      throw new ProtocolError(`decode: EOS reading ${n} bytes at ${indexRef.index}`);
    }
    const out = buffer.subarray(indexRef.index, indexRef.index + n);
    indexRef.index += n;
    return out;
  };

  const readInt = (n: number): number => {
    let val = 0;
    for (let i = 0; i < n; i++) val = val * 256 + readByte();
    return val;
  };

  const readInt20 = (): number => ((readByte() & 15) << 16) | (readByte() << 8) | readByte();

  function readPacked8(tag: number): string {
    const startByte = readByte();
    let value = '';
    for (let i = 0; i < (startByte & 127); i++) {
      const curByte = readByte();
      value += String.fromCharCode(unpackNibble(tag, (curByte & 0xf0) >> 4));
      value += String.fromCharCode(unpackNibble(tag, curByte & 0x0f));
    }
    if (startByte >> 7 !== 0) value = value.slice(0, -1);
    return value.replace(/\0+$/, '');
  }

  function unpackNibble(tag: number, value: number): number {
    if (tag === TAGS.NIBBLE_8) {
      if (value >= 0 && value <= 9) return 48 + value;
      if (value === 10) return 45; // '-'
      if (value === 11) return 46; // '.'
      if (value === 15) return 0; // '\0'
      throw new ProtocolError(`decode: invalid nibble ${value}`);
    }
    // HEX_8 semantics shared
    if (value >= 0 && value < 16) return value < 10 ? 48 + value : 65 + value - 10;
    throw new ProtocolError(`decode: invalid hex nibble ${value}`);
  }

  const readListSize = (tag: number): number => {
    switch (tag) {
      case TAGS.LIST_EMPTY:
        return 0;
      case TAGS.LIST_8:
        return readByte();
      case TAGS.LIST_16:
        return readInt(2);
      default:
        throw new ProtocolError(`decode: invalid list tag ${tag}`);
    }
  };

  function readTokenDouble(dictIndex: number, tokenIndex: number): string {
    const dict = DOUBLE_BYTE_TOKENS[dictIndex];
    const value = dict?.[tokenIndex];
    if (value === undefined) {
      if (strict) throw new ProtocolError(`decode: unknown double token dict=${dictIndex} idx=${tokenIndex}`);
      return `__unknown_token_${dictIndex}_${tokenIndex}`;
    }
    return value;
  }

  function readJidPair(): string {
    const user = readString(readByte());
    const server = readString(readByte());
    if (server) return (user ?? '') + '@' + server;
    throw new ProtocolError(`decode: invalid jid pair '${user}@${server}'`);
  }

  function readAdJid(): string {
    const domainType = readByte();
    const device = readByte();
    const user = readString(readByte());
    const server = getServerFromDomainType('s.whatsapp.net', domainType);
    return jidEncode(user, server, device === 0 ? undefined : device);
  }

  function readFbJid(): string {
    const user = readString(readByte());
    const device = readInt(2);
    const server = readString(readByte());
    return `${user}:${device}@${server}`;
  }

  function readInteropJid(): string {
    const user = readString(readByte());
    const device = readInt(2);
    const integrator = readInt(2);
    let server = 'interop';
    const beforeServer = indexRef.index;
    try {
      server = readString(readByte());
    } catch {
      indexRef.index = beforeServer;
    }
    return `${integrator}-${user}:${device}@${server}`;
  }

  function readString(tag: number): string {
    if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
      const token = SINGLE_BYTE_TOKENS[tag];
      if (token === undefined) {
        if (strict) throw new ProtocolError(`decode: unknown token ${tag}`);
        return `__unknown_token_${tag}`;
      }
      return token;
    }
    switch (tag) {
      case TAGS.DICTIONARY_0:
      case TAGS.DICTIONARY_1:
      case TAGS.DICTIONARY_2:
      case TAGS.DICTIONARY_3:
        return readTokenDouble(tag - TAGS.DICTIONARY_0, readByte());
      case TAGS.LIST_EMPTY:
        return '';
      case TAGS.BINARY_8:
        return readSizedString(readByte());
      case TAGS.BINARY_20:
        return readSizedString(readInt20());
      case TAGS.BINARY_32:
        return readSizedString(readInt(4));
      case TAGS.JID_PAIR:
        return readJidPair();
      case TAGS.FB_JID:
        return readFbJid();
      case TAGS.INTEROP_JID:
        return readInteropJid();
      case TAGS.AD_JID:
        return readAdJid();
      case TAGS.HEX_8:
      case TAGS.NIBBLE_8:
        return readPacked8(tag);
      default:
        if (strict) throw new ProtocolError(`decode: invalid string tag ${tag} at ${indexRef.index - 1}`);
        return `__invalid_string_tag_${tag}`;
    }
  }

  const readSizedString = (length: number): string => {
    if (length > LIMITS.MAX_STRING_BYTES) {
      throw new ProtocolError(`decode: string length ${length} exceeds cap`);
    }
    return Buffer.from(readBytes(length)).toString('utf-8');
  };

  const readList = (tag: number): BinaryNode[] => {
    const size = readListSize(tag);
    if (size > LIMITS.MAX_LIST_SIZE) throw new ProtocolError(`decode: list size ${size} exceeds cap`);
    const items: BinaryNode[] = [];
    for (let i = 0; i < size; i++) {
      items.push(decodeDecompressedBinaryNode(buffer, opts, indexRef, depth + 1));
    }
    return items;
  };

  // ---- node header ----
  const listSize = readListSize(readByte());
  const header = readString(readByte());
  if (listSize === 0 || !header) throw new ProtocolError('decode: invalid node header');

  const attrs: Record<string, string> = {};
  let content: BinaryNode['content'];

  const attributesLength = (listSize - 1) >> 1;
  for (let i = 0; i < attributesLength; i++) {
    const key = readString(readByte());
    attrs[key] = readString(readByte());
  }

  if (listSize % 2 === 0) {
    const tag = readByte();
    if (tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16) {
      content = readList(tag);
    } else if (tag === TAGS.BINARY_8 || tag === TAGS.BINARY_20 || tag === TAGS.BINARY_32) {
      const length = tag === TAGS.BINARY_8 ? readByte() : tag === TAGS.BINARY_20 ? readInt20() : readInt(4);
      if (length > LIMITS.MAX_STRING_BYTES) throw new ProtocolError(`decode: binary content ${length} exceeds cap`);
      content = readBytes(length);
    } else {
      content = readString(tag);
    }
  }

  if (strict && depth === 0 && indexRef.index !== buffer.byteLength) {
    throw new ProtocolError(`decode: ${buffer.byteLength - indexRef.index} trailing bytes after node`);
  }

  return { tag: header, attrs, content };
}
