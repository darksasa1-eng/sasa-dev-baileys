import { ProtocolError } from '../Defaults/errors';
import { getDomainTypeFromServer, jidDecode } from '../Utils/jids';
import { TAGS, TOKEN_MAP } from './constants';
import type { BinaryNode } from './types';

/**
 * Grow-only byte sink. ~10x faster than `number[]` pushes for large frames
 * because it amortizes writes and produces a single allocation at the end.
 */
class ByteWriter {
  #buf = new Uint8Array(1024);
  #len = 0;

  get length(): number {
    return this.#len;
  }

  #ensure(extra: number): void {
    if (this.#len + extra <= this.#buf.byteLength) return;
    let newCap = this.#buf.byteLength * 2;
    while (newCap < this.#len + extra) newCap *= 2;
    const nextBuf = new Uint8Array(newCap);
    nextBuf.set(this.#buf.subarray(0, this.#len));
    this.#buf = nextBuf;
  }

  pushByte(value: number): void {
    this.#ensure(1);
    this.#buf[this.#len] = value & 0xff;
    this.#len += 1;
  }

  /** Big-endian `n`-byte integer (n ≤ 4) */
  pushInt(value: number, n: number): void {
    if (!Number.isSafeInteger(value)) throw new ProtocolError(`pushInt: unsafe integer ${value}`);
    this.#ensure(n);
    for (let i = n - 1; i >= 0; i--) {
      this.#buf[this.#len++] = (value >>> (i * 8)) & 0xff;
    }
  }

  pushBytes(bytes: Uint8Array): void {
    this.#ensure(bytes.byteLength);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.byteLength;
  }

  finish(): Uint8Array {
    return this.#buf.slice(0, this.#len);
  }
}

const UTF8 = new TextEncoder();

export interface EncodeBinaryNodeOptions {
  /**
   * Emit the leading transport byte. WhatsApp frames carry a leading flags
   * byte (0x00 = raw, 0x02 = zlib). The encoder always emits 0x00 — disable
   * when writing unit tests for the tree format alone.
   */
  transportPrefix?: boolean;
}

/** Serialize a {@link BinaryNode} tree to wire bytes. */
export function encodeBinaryNode(node: BinaryNode, opts: EncodeBinaryNodeOptions = {}): Uint8Array {
  const writer = new ByteWriter();
  if (opts.transportPrefix !== false) writer.pushByte(0);
  encodeNodeInner(node, writer);
  return writer.finish();
}

function encodeNodeInner({ tag, attrs, content }: BinaryNode, w: ByteWriter): void {
  if (!tag) throw new ProtocolError('encodeBinaryNode: tag cannot be empty');

  const attrEntries = Object.entries(attrs ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );

  // list-size = 2 * nAttrs + 1 (the tag) + 1 if content present
  writeListStart(w, 2 * attrEntries.length + 1 + (content !== undefined ? 1 : 0));
  writeString(w, tag);

  for (const [key, value] of attrEntries) {
    writeString(w, key);
    writeString(w, value);
  }

  if (typeof content === 'string') {
    writeString(w, content);
  } else if (content instanceof Uint8Array) {
    writeByteLength(w, content.byteLength);
    w.pushBytes(content);
  } else if (Array.isArray(content)) {
    writeListStart(w, content.length);
    for (const child of content) {
      if (child && child.tag) encodeNodeInner(child, w);
      else throw new ProtocolError('encodeBinaryNode: invalid child node');
    }
  } else if (content !== undefined) {
    throw new ProtocolError(`encodeBinaryNode: unsupported content type ${typeof content}`);
  }
}

function writeByteLength(w: ByteWriter, length: number): void {
  if (length >= 4294967296) throw new ProtocolError(`encodeBinaryNode: payload too large (${length})`);
  if (length >= 1 << 20) {
    w.pushByte(TAGS.BINARY_32);
    w.pushInt(length, 4);
  } else if (length >= 256) {
    w.pushByte(TAGS.BINARY_20);
    w.pushInt(length & 0x0fffff, 3);
  } else {
    w.pushByte(TAGS.BINARY_8);
    w.pushByte(length);
  }
}

function writeStringRaw(w: ByteWriter, str: string): void {
  const bytes = UTF8.encode(str);
  writeByteLength(w, bytes.byteLength);
  w.pushBytes(bytes);
}

function writeListStart(w: ByteWriter, listSize: number): void {
  if (listSize === 0) w.pushByte(TAGS.LIST_EMPTY);
  else if (listSize < 256) {
    w.pushByte(TAGS.LIST_8);
    w.pushByte(listSize);
  } else {
    w.pushByte(TAGS.LIST_16);
    w.pushInt(listSize, 2);
  }
}

function writeJid(w: ByteWriter, jid: string): void {
  const decoded = jidDecode(jid);
  if (!decoded) {
    writeStringRaw(w, jid);
    return;
  }
  const { user, server, device } = decoded;
  if (device !== undefined) {
    w.pushByte(TAGS.AD_JID);
    w.pushByte(getDomainTypeFromServer(server));
    w.pushByte(device);
    writeString(w, user);
  } else {
    w.pushByte(TAGS.JID_PAIR);
    if (user.length > 0) writeString(w, user);
    else w.pushByte(TAGS.LIST_EMPTY);
    writeString(w, server);
  }
}

function packNibble(char: string): number {
  if (char >= '0' && char <= '9') return char.charCodeAt(0) - 48;
  if (char === '-') return 10;
  if (char === '.') return 11;
  if (char === '\0') return 15;
  throw new ProtocolError(`encodeBinaryNode: invalid nibble char "${char}"`);
}

function packHex(charCode: number): number {
  if (charCode >= 48 && charCode <= 57) return charCode - 48; // '0'-'9'
  if (charCode >= 65 && charCode <= 70) return 10 + charCode - 65; // 'A'-'F'
  if (charCode >= 97 && charCode <= 102) return 10 + charCode - 97; // 'a'-'f'
  if (charCode === 0) return 15; // '\0' padding terminator
  throw new ProtocolError(`encodeBinaryNode: invalid hex char code ${charCode}`);
}

function writePackedBytes(w: ByteWriter, str: string, type: 'nibble' | 'hex'): void {
  if (str.length > TAGS.PACKED_MAX) throw new ProtocolError('encodeBinaryNode: packed string too long');
  w.pushByte(type === 'nibble' ? TAGS.NIBBLE_8 : TAGS.HEX_8);
  let roundedLength = Math.ceil(str.length / 2);
  if (str.length % 2 !== 0) roundedLength |= 128;
  w.pushByte(roundedLength);
  const half = Math.floor(str.length / 2);
  if (type === 'nibble') {
    for (let i = 0; i < half; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      w.pushByte((packNibble(str[2 * i]!) << 4) | packNibble(str[2 * i + 1]!));
    }
    if (str.length % 2 !== 0) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      w.pushByte((packNibble(str[str.length - 1]!) << 4) | 0x0f);
    }
  } else {
    for (let i = 0; i < half; i++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      w.pushByte((packHex(str.charCodeAt(2 * i)) << 4) | packHex(str.charCodeAt(2 * i + 1)));
    }
    if (str.length % 2 !== 0) {
      w.pushByte((packHex(str.charCodeAt(str.length - 1)) << 4) | 0x0f);
    }
  }
}

function isNibble(str: string): boolean {
  if (!str || str.length > TAGS.PACKED_MAX) return false;
  for (const char of str) {
    if (!(char >= '0' && char <= '9') && char !== '-' && char !== '.') return false;
  }
  return true;
}

function isHex(str: string): boolean {
  if (!str || str.length > TAGS.PACKED_MAX) return false;
  for (const char of str) {
    if (!(char >= '0' && char <= '9') && !(char >= 'A' && char <= 'F')) return false;
  }
  return true;
}

function writeString(w: ByteWriter, str: string | number): void {
  const s = String(str);
  if (s === '') {
    writeStringRaw(w, s);
    return;
  }
  const token = TOKEN_MAP[s];
  if (token) {
    if ('dict' in token) w.pushByte(TAGS.DICTIONARY_0 + token.dict);
    w.pushByte(token.index);
    return;
  }
  if (isNibble(s)) {
    writePackedBytes(w, s, 'nibble');
    return;
  }
  if (isHex(s)) {
    writePackedBytes(w, s, 'hex');
    return;
  }
  if (s.indexOf('@') >= 0 && s.indexOf('@') < s.length - 1) {
    writeJid(w, s);
    return;
  }
  writeStringRaw(w, s);
}
