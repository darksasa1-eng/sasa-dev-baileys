import { ProtocolError } from '../Defaults/errors';
import type { BinaryNode } from './types';

/** Query helpers over {@link BinaryNode} trees. All are defensive: they
 * accept `undefined` children and return `undefined` instead of throwing. */

export function getBinaryNodeChild(node: BinaryNode | undefined, childTag: string): BinaryNode | undefined {
  if (!node || !Array.isArray(node.content)) return undefined;
  return node.content.find((item) => item.tag === childTag);
}

export function getAllBinaryNodeChildren(node: BinaryNode | undefined): BinaryNode[] {
  if (!node || !Array.isArray(node.content)) return [];
  return node.content;
}

export function getBinaryNodeChildren(node: BinaryNode | undefined, childTag: string): BinaryNode[] {
  if (!node || !Array.isArray(node.content)) return [];
  return node.content.filter((item) => item.tag === childTag);
}

/** Child content as UTF-8 string (works for string and binary content) */
export function getBinaryNodeChildString(node: BinaryNode | undefined, childTag: string): string | undefined {
  const child = getBinaryNodeChild(node, childTag);
  if (!child) return undefined;
  if (typeof child.content === 'string') return child.content;
  if (child.content instanceof Uint8Array) return Buffer.from(child.content).toString('utf-8');
  return undefined;
}

export function getBinaryNodeChildBuffer(node: BinaryNode | undefined, childTag: string): Uint8Array | undefined {
  const child = getBinaryNodeChild(node, childTag);
  if (!child) return undefined;
  if (child.content instanceof Uint8Array) return child.content;
  if (typeof child.content === 'string') return Buffer.from(child.content, 'utf-8');
  return undefined;
}

export function getBinaryNodeChildUInt(
  node: BinaryNode | undefined,
  childTag: string,
  length: number,
): number | undefined {
  const buff = getBinaryNodeChildBuffer(node, childTag);
  if (!buff || buff.byteLength < length) return undefined;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (buff[i] ?? 0);
  return value;
}

/** `<message>` children of a `<notification>` / `<receipt>` style node */
export function getBinaryNodeMessages(node: BinaryNode | undefined): BinaryNode[] {
  return getBinaryNodeChildren(node, 'message');
}

/** Flatten node children into `{ [childTag]: childString }` */
export function reduceBinaryNodeToDictionary(node: BinaryNode | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const child of getAllBinaryNodeChildren(node)) {
    if (typeof child.content === 'string') out[child.tag] = child.content;
    else if (child.content instanceof Uint8Array) out[child.tag] = Buffer.from(child.content).toString('utf-8');
  }
  return out;
}

/** Throw a {@link ProtocolError} when the node is a `<stream:error>` or `<error>` stanza */
export function assertNodeErrorFree(node: BinaryNode): void {
  const errNode = getBinaryNodeChild(node, 'error') ?? (node.tag === 'stream:error' ? node : undefined);
  if (errNode) {
    throw new ProtocolError(`stream error [${errNode.attrs.code ?? node.attrs.code ?? 'unknown'}]`, {
      data: { node: summarizeNode(errNode) },
    });
  }
}

/** One-line structural summary of a node (for logs / debugger) */
export function summarizeNode(node: BinaryNode): string {
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const contentLen = Array.isArray(node.content)
    ? `${node.content.length} children`
    : node.content instanceof Uint8Array
      ? `${node.content.byteLength} bytes`
      : typeof node.content === 'string'
        ? `${node.content.length} chars`
        : 'empty';
  return `<${node.tag}${attrs ? ' ' + attrs : ''}> (${contentLen})`;
}

/**
 * Canonical XML-ish rendering of a node tree. Used by the packet debugger
 * and logging hooks. Binary content is rendered as `<binary N bytes>`.
 */
export function binaryNodeToString(node: BinaryNode, indent = 0): string {
  const pad = '  '.repeat(indent);
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  if (node.content === undefined) return `${pad}<${node.tag}${attrs}/>`;
  if (typeof node.content === 'string') return `${pad}<${node.tag}${attrs}>${node.content}</${node.tag}>`;
  if (node.content instanceof Uint8Array) {
    return `${pad}<${node.tag}${attrs}> [${node.content.byteLength} bytes] </${node.tag}>`;
  }
  const children = node.content.map((c) => binaryNodeToString(c, indent + 1)).join('\n');
  return `${pad}<${node.tag}${attrs}>\n${children}\n${pad}</${node.tag}>`;
}
