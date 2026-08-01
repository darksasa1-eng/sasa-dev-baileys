import { describe, expect, it } from 'vitest';
import { encodeBinaryNode, decodeBinaryNode, WABINARY_LIMITS } from '../src/WABinary/index';
import type { BinaryNode } from '../src/WABinary/types';
import { ProtocolError } from '../src/Defaults/errors';
import { deflateSync } from 'node:zlib';

const roundTrip = (node: BinaryNode): BinaryNode => decodeBinaryNode(encodeBinaryNode(node));

describe('WABinary codec', () => {
  it('round-trips a basic stanza with tokenized tags', () => {
    const node: BinaryNode = { tag: 'iq', attrs: { id: '1', to: 's.whatsapp.net', type: 'get' } };
    const decoded = roundTrip(node);
    expect(decoded.tag).toBe('iq');
    expect(decoded.attrs.to).toBe('s.whatsapp.net');
    expect(decoded.attrs.type).toBe('get');
  });

  it('compresses token dictionary strings', () => {
    const node: BinaryNode = { tag: 'receipt', attrs: { type: 'read', to: 's.whatsapp.net' } };
    const bytes = encodeBinaryNode(node);
    // receipt(216) + attrs is a few dozen bytes, never close to the string form
    expect(bytes.byteLength).toBeLessThan(30);
  });

  it('nibble-packs numeric attr values (ids)', () => {
    const node: BinaryNode = { tag: 'message', attrs: { id: '3EB0A1B2C3', from: '41789996011@s.whatsapp.net' } };
    const decoded = roundTrip(node);
    expect(decoded.attrs.id).toBe('3EB0A1B2C3');
    expect(decoded.attrs.from).toBe('41789996011@s.whatsapp.net');
  });

  it('round-trips device JIDs through AD_JID', () => {
    const node: BinaryNode = { tag: 'message', attrs: { from: '41789996011:5@s.whatsapp.net' } };
    expect(roundTrip(node).attrs.from).toBe('41789996011:5@s.whatsapp.net');
  });

  it('round-trips LID device JIDs through AD_JID domain types', () => {
    const node: BinaryNode = { tag: 'message', attrs: { from: '1234:2@lid' } };
    expect(roundTrip(node).attrs.from).toBe('1234:2@lid');
  });

  it('round-trips binary content', () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const decoded = roundTrip({ tag: 'enc', attrs: { v: '2' }, content: payload });
    expect(decoded.content).toBeInstanceOf(Uint8Array);
    expect([...(decoded.content as Uint8Array)]).toEqual([0, 1, 2, 250, 255]);
  });

  it('round-trips children lists', () => {
    const decoded = roundTrip({
      tag: 'list',
      attrs: {},
      content: [
        { tag: 'item', attrs: { v: '1' } },
        { tag: 'item', attrs: { v: '2' }, content: 'text' },
      ],
    });
    expect(Array.isArray(decoded.content)).toBe(true);
    const children = decoded.content as BinaryNode[];
    expect(children).toHaveLength(2);
    expect(children[1]?.content).toBe('text');
  });

  it('skips undefined attrs', () => {
    const node: BinaryNode = { tag: 'iq', attrs: { id: '9', missing: undefined, type: 'set' } };
    const decoded = roundTrip(node);
    expect('missing' in decoded.attrs).toBe(false);
    expect(decoded.attrs.type).toBe('set');
  });

  it('throws typed ProtocolError on truncated input', () => {
    expect(() => decodeBinaryNode(new Uint8Array([0, 249, 255, 1]))).toThrow(ProtocolError);
  });

  it('throws typed ProtocolError on empty frame', () => {
    expect(() => decodeBinaryNode(new Uint8Array(0))).toThrow(ProtocolError);
  });

  it('strict mode rejects unknown tokens', () => {
    // hand-craft: node list 2 (tag + content), tag token 216, content string tag 240 (unknown)
    expect(() => decodeBinaryNode(new Uint8Array([0, 248, 2, 216, 240]), { strict: true })).toThrow(ProtocolError);
  });

  it('lenient mode returns diagnostic sentinel for unknown tokens', () => {
    const node = decodeBinaryNode(new Uint8Array([0, 248, 2, 216, 240]));
    expect(node.content).toBe('__invalid_string_tag_240');
  });

  it('rejects absurd length claims (DoS guard)', () => {
    const frame = new Uint8Array([0, 248, 2, 252, 255, 255, 255, 255]); // tag + BINARY_32 huge
    expect(() => decodeBinaryNode(frame)).toThrow(ProtocolError);
  });

  it('enforces nesting depth cap', () => {
    let node: BinaryNode = { tag: 'leaf', attrs: {} };
    for (let i = 0; i < WABINARY_LIMITS.MAX_DEPTH + 20; i++) node = { tag: 'wrap', attrs: {}, content: [node] };
    expect(() => decodeBinaryNode(encodeBinaryNode(node))).toThrow(/nesting/);
  });

  it('decodes zlib-compressed frames (flag byte 0x02)', () => {
    const node: BinaryNode = { tag: 'iq', attrs: { id: 'c', type: 'get' } };
    const raw = encodeBinaryNode(node).subarray(1); // strip the 0x00 flag
    const compressed = deflateSync(Buffer.from(raw));
    const frame = new Uint8Array(1 + compressed.byteLength);
    frame[0] = 2;
    frame.set(compressed, 1);
    const decoded = decodeBinaryNode(frame);
    expect(decoded.tag).toBe('iq');
  });

  it('double-byte dictionary tokens encode and decode', () => {
    // pick a known double-byte token
    const node: BinaryNode = { tag: 'iq', attrs: { 'web:payload': 'x' as string } };
    const decoded = roundTrip(node);
    expect(decoded.attrs['web:payload']).toBe('x');
  });
});
