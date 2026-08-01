import { EventEmitter } from 'node:events';

export type EventHandler<T> = (payload: T) => void;

/**
 * Strongly typed event emitter used across the library.
 *
 * Differences vs the raw Node emitter:
 * - every event name/payload pair is type checked
 * - a duplicate-listener guard prevents the double-subscribe bug that is the
 *   most common source of "event fired twice" reports
 * - `waitFor()` turns an emission into a promise with timeout + cleanup
 */
export class TypedEventEmitter<TEvents extends Record<string, unknown>> {
  readonly #emitter = new EventEmitter({ captureRejections: true });
  readonly #guardDuplicates: boolean;

  constructor(opts: { guardDuplicateListeners?: boolean; maxListeners?: number } = {}) {
    this.#guardDuplicates = opts.guardDuplicateListeners ?? true;
    if (opts.maxListeners !== undefined) this.#emitter.setMaxListeners(opts.maxListeners);
    this.#emitter.on('error', () => {
      /* swallowed: consumers subscribe via on('error') */
    });
  }

  on<K extends keyof TEvents & string>(event: K, handler: EventHandler<TEvents[K]>): void {
    if (this.#guardDuplicates && this.#emitter.listenerCount(event, handler as never) > 0) return;
    this.#emitter.on(event, handler as never);
  }

  once<K extends keyof TEvents & string>(event: K, handler: EventHandler<TEvents[K]>): void {
    this.#emitter.once(event, handler as never);
  }

  off<K extends keyof TEvents & string>(event: K, handler: EventHandler<TEvents[K]>): void {
    this.#emitter.off(event, handler as never);
  }

  removeAllListeners<K extends keyof TEvents & string>(event?: K): void {
    if (event === undefined) this.#emitter.removeAllListeners();
    else this.#emitter.removeAllListeners(event);
  }

  /** Remove every listener owned by this emitter (used on shutdown) */
  dispose(): void {
    this.#emitter.removeAllListeners();
  }

  emit<K extends keyof TEvents & string>(event: K, payload: TEvents[K]): void {
    this.#emitter.emit(event, payload);
  }

  listenerCount<K extends keyof TEvents & string>(event: K): number {
    return this.#emitter.listenerCount(event);
  }

  /**
   * Promise that resolves the next time `event` fires (once-only, self
   * cleaning). Optionally filtered and bounded by a timeout.
   */
  waitFor<K extends keyof TEvents & string>(
    event: K,
    opts: { filter?: (payload: TEvents[K]) => boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TEvents[K]> {
    return new Promise<TEvents[K]>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.off(event, handler as EventHandler<TEvents[K]>);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error(`waitFor('${event}') aborted`));
      };
      const handler = (payload: TEvents[K]): void => {
        if (opts.filter && !opts.filter(payload)) return;
        cleanup();
        resolve(payload);
      };
      this.on(event, handler as EventHandler<TEvents[K]>);
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`waitFor('${event}') timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        timer.unref?.();
      }
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}
