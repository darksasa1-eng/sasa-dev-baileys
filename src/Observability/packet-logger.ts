import { binaryNodeToString, summarizeNode } from '../WABinary/generic-utils';
import type { BinaryNode } from '../WABinary/types';

export type PacketDirection = 'in' | 'out';

export interface PacketRecord {
  direction: PacketDirection;
  node: BinaryNode;
  timestamp: number;
}

export interface PacketLoggerOptions {
  /** Attr names whose values must be redacted (e.g. keys, tokens) */
  redactAttrs?: string[];
  /** Max number of attributes kept per node before truncation */
  maxAttrsPerNode?: number;
  /** Sink receiving redacted, summarized records */
  sink: (line: string, record: PacketRecord) => void;
}

const DEFAULT_REDACT = [
  'enckey',
  'mackey',
  'secret',
  'token',
  'password',
  'id', // ids can be large; keep but truncate below
];

/**
 * Packet Logger — taps raw inbound/outbound binary stanzas, redacts
 * sensitive attributes, and forwards structured records to the host app.
 * Attach via `client.packetLogger.attach({ sink })`.
 */
export class PacketLogger {
  readonly #opts: PacketLoggerOptions;
  readonly #redactSet: Set<string>;
  #paused = false;

  constructor(options: PacketLoggerOptions) {
    this.#opts = options;
    this.#redactSet = new Set([...DEFAULT_REDACT, ...(options.redactAttrs ?? [])]);
  }

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  log(direction: PacketDirection, node: BinaryNode): void {
    if (this.#paused) return;
    const redacted = redactNode(node, this.#redactSet, this.#opts.maxAttrsPerNode ?? 30);
    const record: PacketRecord = { direction, node: redacted, timestamp: Date.now() };
    const line = `[pkt ${direction}] ${summarizeNode(redacted as BinaryNode)}`;
    this.#opts.sink(line, record);
  }

  /** Render a record for humans (used by the packet debugger) */
  static render(record: PacketRecord): string {
    return binaryNodeToString(record.node);
  }
}

function redactNode(node: BinaryNode, redact: Set<string>, maxAttrs: number): BinaryNode {
  const attrs: Record<string, string> = {};
  const names = Object.keys(node.attrs).slice(0, maxAttrs);
  for (const name of names) {
    const value = node.attrs[name];
    if (value === undefined) continue;
    if (redact.has(name.toLowerCase())) attrs[name] = '***';
    else if (value.length > 128) attrs[name] = `${value.slice(0, 96)}…(${value.length})`;
    else attrs[name] = value;
  }
  let content = node.content;
  if (Array.isArray(content)) content = content.map((c) => redactNode(c, redact, maxAttrs));
  else if (content instanceof Uint8Array) content = `[${content.byteLength} bytes]`;
  else if (typeof content === 'string' && content.length > 256) content = `${content.slice(0, 200)}…(${content.length})`;
  return { tag: node.tag, attrs, content: content as BinaryNode['content'] };
}
