/**
 * Cooperative async mutex. Not reentrant.
 *
 * Usage:
 * ```ts
 * const release = await mutex.acquire();
 * try { ... } finally { release(); }
 * ```
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = this.#tail.then(() => release);
    this.#tail = this.#tail.then(() => next);
    return acquired;
  }

  /** Convenience: run `fn` while holding the lock */
  async exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Per-key mutex: only serializes work that shares a key (e.g. a chat id or
 * session id), letting unrelated keys progress in parallel.
 * Entries self-clean once they have no waiters, so the map cannot leak.
 */
export class KeyedMutex {
  #locks = new Map<string, Promise<unknown>>();

  get trackedKeys(): number {
    return this.#locks.size;
  }

  async exclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    let release!: (value: T | Promise<T>) => void;
    const resultPromise = new Promise<T>((resolve) => {
      release = resolve;
    });
    this.#locks.set(
      key,
      prev.then(() => resultPromise),
    );
    await prev;
    try {
      const result = await fn();
      release(result);
      return result;
    } finally {
      // Only delete if no one queued behind us.
      const current = this.#locks.get(key);
      if (current) {
        void current.then(() => {
          if (this.#locks.get(key) === current) this.#locks.delete(key);
        });
      } else {
        this.#locks.delete(key);
      }
    }
  }
}
