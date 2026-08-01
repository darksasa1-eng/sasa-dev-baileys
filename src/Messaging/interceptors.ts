import type { WAMessage } from '../Types/messages';

/**
 * Message Interceptor — pipeline sitting between `messages.upsert`
 * emission and consumers.
 *
 * - `incoming` interceptors can transform messages or drop them (return null)
 * - `outgoing` interceptors shape what `sendMessage` will transmit
 *
 * Interceptors run in registration order (or by `priority` when set —
 * higher runs earlier).
 */

export interface IncomingMessageContext {
  messages: WAMessage[];
  upsertType: 'notify' | 'append';
}

export type IncomingMessageInterceptor = (
  ctx: IncomingMessageContext,
) => IncomingMessageContext | null | Promise<IncomingMessageContext | null>;

export type OutgoingMessageInterceptor = (msg: WAMessage) => WAMessage | null | Promise<WAMessage | null>;

interface Registered<TFn> {
  fn: TFn;
  priority: number;
  seq: number;
}

export class MessageInterceptor {
  #incoming: Registered<IncomingMessageInterceptor>[] = [];
  #outgoing: Registered<OutgoingMessageInterceptor>[] = [];
  #seq = 0;
  onError?: (err: unknown) => void;

  addIncoming(fn: IncomingMessageInterceptor, priority = 0): () => void {
    const reg: Registered<IncomingMessageInterceptor> = { fn, priority, seq: this.#seq++ };
    this.#incoming.push(reg);
    this.#incoming.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    return () => {
      this.#incoming = this.#incoming.filter((r) => r !== reg);
    };
  }

  addOutgoing(fn: OutgoingMessageInterceptor, priority = 0): () => void {
    const reg: Registered<OutgoingMessageInterceptor> = { fn, priority, seq: this.#seq++ };
    this.#outgoing.push(reg);
    this.#outgoing.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    return () => {
      this.#outgoing = this.#outgoing.filter((r) => r !== reg);
    };
  }

  async applyIncoming(ctx: IncomingMessageContext): Promise<IncomingMessageContext | null> {
    let current: IncomingMessageContext | null = ctx;
    for (const { fn } of this.#incoming) {
      if (current === null) return null;
      try {
        current = await fn(current);
      } catch (err) {
        this.onError?.(err);
      }
    }
    return current;
  }

  async applyOutgoing(msg: WAMessage): Promise<WAMessage | null> {
    let current: WAMessage | null = msg;
    for (const { fn } of this.#outgoing) {
      if (current === null) return null;
      try {
        current = await fn(current);
      } catch (err) {
        this.onError?.(err);
      }
    }
    return current;
  }

  get incomingCount(): number {
    return this.#incoming.length;
  }

  get outgoingCount(): number {
    return this.#outgoing.length;
  }
}
