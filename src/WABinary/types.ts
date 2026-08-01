import type { TAGS } from './constants';

export type BinaryNodeAttributes = { [key: string]: string | undefined };

/**
 * The WhatsApp binary tree node. Every stanza exchanged with the server is
 * one of these: `[tag, attrs, children?]` serialized per the wire format.
 */
export interface BinaryNode {
  tag: string;
  attrs: BinaryNodeAttributes;
  content?: BinaryNode[] | Uint8Array | string;
}

export type BinaryData = BinaryNode[] | Uint8Array | string;

export type TagValue = (typeof TAGS)[keyof typeof TAGS];

export interface DecodeOptions {
  /**
   * Strict mode rejects trailing bytes and unknown tokens.
   * Lenient mode (default) is crash-proof and returns diagnostic values.
   */
  strict?: boolean;
  /** Maximum inflated payload size accepted (DoS guard). Default 64 MiB */
  maxInflatedSize?: number;
}

/** A node that failed to decode cleanly (lenient mode surfaces these) */
export interface DecodingIssue {
  reason: string;
  offset: number;
}
