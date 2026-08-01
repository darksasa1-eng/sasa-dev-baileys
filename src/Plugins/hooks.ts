/**
 * Plugin Hook System.
 *
 * Named tap points across the pipeline. Each hook runs every tap in
 * registration order; async/await aware. Errors in one tap never break
 * the chain — they are reported to `onError` and the chain continues.
 */

export type HookTap<TContext> = (ctx: TContext) => void | boolean | Promise<void | boolean>;

export interface HookRegistration<TContext> {
  /** Owning plugin name (for unregister) */
  plugin?: string;
  tap: HookTap<TContext>;
}

export class Hook<TContext> {
  readonly name: string;
  readonly #taps: HookRegistration<TContext>[] = [];
  onError?: (err: unknown, tap: HookRegistration<TContext>) => void;

  constructor(name: string) {
    this.name = name;
  }

  tap(plugin: string | undefined, fn: HookTap<TContext>): () => void {
    const reg: HookRegistration<TContext> = { plugin, tap: fn };
    this.#taps.push(reg);
    return () => this.untap(fn);
  }

  untap(fn: HookTap<TContext>): boolean {
    const idx = this.#taps.findIndex((t) => t.tap === fn);
    if (idx >= 0) {
      this.#taps.splice(idx, 1);
      return true;
    }
    return false;
  }

  untapPlugin(plugin: string): number {
    let removed = 0;
    for (let i = this.#taps.length - 1; i >= 0; i--) {
      const t = this.#taps[i];
      if (t?.plugin === plugin) {
        this.#taps.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#taps.length;
  }

  /** Run taps sequentially; errors are isolated per tap */
  async run(ctx: TContext): Promise<void> {
    for (const tap of [...this.#taps]) {
      try {
        await tap.tap(ctx);
      } catch (err) {
        this.onError?.(err, tap);
      }
    }
  }

  /** Run taps until one returns false (bail-out semantics) */
  async runUntilFalse(ctx: TContext): Promise<boolean> {
    for (const tap of [...this.#taps]) {
      try {
        const result = await tap.tap(ctx);
        if (result === false) return false;
      } catch (err) {
        this.onError?.(err, tap);
      }
    }
    return true;
  }
}

/**
 * A set of named hooks: `hooks.get('beforeSend')` etc.
 */
export class HookSystem {
  #hooks = new Map<string, Hook<unknown>>();
  onError?: (hook: string, err: unknown) => void;

  define<TContext>(name: string): Hook<TContext> {
    const hook = new Hook<TContext>(name);
    hook.onError = (err) => this.onError?.(name, err);
    this.#hooks.set(name, hook as Hook<unknown>);
    return hook;
  }

  get<TContext>(name: string): Hook<TContext> {
    let hook = this.#hooks.get(name);
    if (!hook) hook = this.define(name) as Hook<unknown>;
    return hook as Hook<TContext>;
  }

  /** Remove all taps of a plugin across every hook */
  unregisterPlugin(plugin: string): number {
    let removed = 0;
    for (const hook of this.#hooks.values()) removed += hook.untapPlugin(plugin);
    return removed;
  }

  clear(): void {
    this.#hooks.clear();
  }
}
