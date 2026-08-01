import { bytesToHex } from '../Utils/buffer';
import { binaryNodeToString } from '../WABinary/generic-utils';
import type { BinaryNode } from '../WABinary/types';

/**
 * Packet Debugger — developer-facing utilities for inspecting wire traffic.
 */
export class PacketDebugger {
  /** Classic 16-byte hexdump lines */
  static hexDump(data: Uint8Array, bytesPerLine = 16): string {
    const lines: string[] = [];
    for (let offset = 0; offset < data.byteLength; offset += bytesPerLine) {
      const slice = data.subarray(offset, Math.min(offset + bytesPerLine, data.byteLength));
      const hex = bytesToHex(slice);
      const hexFormatted = hex
        .replace(/(..)/g, '$1 ')
        .trim()
        .padEnd(bytesPerLine * 3 - 1, ' ');
      const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${hexFormatted}  |${ascii}|`);
    }
    return lines.join('\n');
  }

  /** Pretty print a stanza tree (truncating binary blobs) */
  static printNode(node: BinaryNode, indent = 0): string {
    return binaryNodeToString(node, indent);
  }

  /** Diff-friendly structural fingerprint of a node (ignores attr values) */
  static fingerprint(node: BinaryNode): string {
    const parts: string[] = [node.tag];
    const attrNames = Object.keys(node.attrs).sort();
    parts.push(`(${attrNames.join(',')})`);
    if (Array.isArray(node.content)) {
      parts.push(`[${node.content.map((c) => PacketDebugger.fingerprint(c)).join(' ')}]`);
    } else if (node.content instanceof Uint8Array) {
      parts.push(`<bin:${node.content.byteLength}>`);
    } else if (typeof node.content === 'string') {
      parts.push(`<str:${node.content.length}>`);
    }
    return parts.join('');
  }
}
