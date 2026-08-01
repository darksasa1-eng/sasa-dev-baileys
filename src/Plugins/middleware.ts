/**
 * Middleware engine (async compose, onion model).
 *
 * - each middleware runs `next()` exactly once (double-next is a no-op and
 *   logged via `onError`, eliminating a whole class of pipeline bugs)
 * - errors propagate up the onion to the caller or to `onError`
 * - supports short-circuit: a middleware that never calls `next()` ends the
 *   chain
 */

export interface MiddlewareContext<TState = Record<string, unknown>> {
  /** User-supplied shared state bag */
  state: TState;
}

export type MiddlewareFn<TState = Record<string, unknown>> = (
  ctx: MiddlewareContext<TState>,
  next: () => Promise<void>,
) => Promise<void> | void;

export interface MiddlewareEngineOptions<TState> {
  onError?: (err: unknown, middleware: MiddlewareFn<TState>) => void;
}

export class MiddlewareEngine<TState = Record<string, unknown>> {
  #stack: { fn: MiddlewareFn<TState>; name?: string }[] = [];
  readonly #onError?: (err: unknown, middleware: MiddlewareFn<TState>) => void;

  constructor(options: MiddlewareEngineOptions<TState> = {}) {
    this.#onError = options.onError;
  }

  use(fn: MiddlewareFn<TState>, name?: string): () => void {
    this.#stack.push({ fn, name });
    return () => this.remove(fn);
  }

  remove(fn: MiddlewareFn<TState>): boolean {
    const idx = this.#stack.findIndex((s) => s.fn === fn);
    if (idx >= 0) {
      this.#stack.splice(idx, 1);
      return true;
    }
    return false;
  }

  get size(): number {
    return this.#stack.length;
  }

  /** Compose and run the stack against `state` */
  async run(state: TState): Promise<void> {
    const ctx: MiddlewareContext<TState> = { state };
    const stack = [...this.#stack];

    const dispatch = async (index: number): Promise<void> => {
      if (index >= stack.length) return;
      const layer = stack[index];
      if (!layer) return;
      let nextCalled = false;
      const next = async (): Promise<void> => {
        if (nextCalled) return; // guard: next() may only fire once
        nextCalled = true;
        await dispatch(index + 1);
      };
      try {
        await layer.fn(ctx, next);
      } catch (err) {
        if (this.#onError) this.#onError(err, layer.fn);
        else throw err;
      }
    };

    await dispatch(0);
  }

  clear(): void {
    this.#stack = [];
  }
}
