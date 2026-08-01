import type { BinaryNode } from '../WABinary/types';

/**
 * WebSocket Middleware — raw stanza-level pre/post processing.
 *
 * `outgoing` middleware can transform or veto nodes right before they hit
 * the wire; `incoming` middleware sees nodes right after decryption. Return
 * `null` to drop the stanza entirely.
 */

export type OutgoingStanzaMiddleware = (node: BinaryNode) => BinaryNode | null | Promise<BinaryNode | null>;
export type IncomingStanzaMiddleware = (node: BinaryNode) => BinaryNode | null | Promise<BinaryNode | null>;

export class WebSocketMiddleware {
  #outgoing: OutgoingStanzaMiddleware[] = [];
  #incoming: IncomingStanzaMiddleware[] = [];
  onError?: (err: unknown) => void;

  useOutgoing(mw: OutgoingStanzaMiddleware): () => void {
    this.#outgoing.push(mw);
    return () => {
      this.#outgoing = this.#outgoing.filter((m) => m !== mw);
    };
  }

  useIncoming(mw: IncomingStanzaMiddleware): () => void {
    this.#incoming.push(mw);
    return () => {
      this.#incoming = this.#incoming.filter((m) => m !== mw);
    };
  }

  async applyOutgoing(node: BinaryNode): Promise<BinaryNode | null> {
    let current: BinaryNode | null = node;
    for (const mw of this.#outgoing) {
      if (current === null) return null;
      try {
        current = await mw(current);
      } catch (err) {
        this.onError?.(err);
      }
    }
    return current;
  }

  async applyIncoming(node: BinaryNode): Promise<BinaryNode | null> {
    let current: BinaryNode | null = node;
    for (const mw of this.#incoming) {
      if (current === null) return null;
      try {
        current = await mw(current);
      } catch (err) {
        this.onError?.(err);
      }
    }
    return current;
  }

  clear(): void {
    this.#outgoing = [];
    this.#incoming = [];
  }
}
