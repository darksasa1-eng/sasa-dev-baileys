import { BackpressureError } from './errors';

export interface AsyncEventQueueOptions {
  /** Maximum number of tasks allowed to wait; throws {@link BackpressureError} beyond it */
  maxPending?: number;
}

/**
 * Serial async task queue ("async event queue").
 *
 * Guarantees in-order execution of async jobs without reentrancy — crucial
 * for auth state persistence, session ratchet updates and message processing
 * where parallel mutation corrupts state.
 */
export class AsyncEventQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #paused = false;
  readonly #maxPending: number;

  constructor(options: AsyncEventQueueOptions = {}) {
    this.#maxPending = options.maxPending ?? 10_000;
  }

  /** Number of jobs currently waiting to run (excludes the one executing) */
  get pending(): number {
    return this.#pending;
  }

  /** Enqueue a job; resolves/rejects with the job's own result */
  enqueue<T>(job: () => Promise<T> | T): Promise<T> {
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(new BackpressureError(`AsyncEventQueue full (${this.#maxPending} pending)`));
    }
    this.#pending += 1;
    const run = async (): Promise<T> => {
      try {
        if (this.#paused) await this.#waitForResume();
        return await job();
      } finally {
        this.#pending -= 1;
      }
    };
    const result = this.#tail.then(run);
    // Keep the tail alive regardless of job failures.
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #resumeWaiters = new Set<() => void>();

  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    for (const wake of this.#resumeWaiters) wake();
    this.#resumeWaiters.clear();
  }

  #waitForResume(): Promise<void> {
    if (!this.#paused) return Promise.resolve();
    return new Promise<void>((resolve) => this.#resumeWaiters.add(resolve));
  }

  /** Wait until all enqueued jobs have finished */
  async drain(): Promise<void> {
    while (this.#pending > 0) {
      await this.#tail;
    }
  }

  /** Drop reference chain to allow GC of completed jobs' results */
  clear(): void {
    this.#tail = Promise.resolve();
    this.#pending = 0;
    this.#resumeWaiters.clear();
  }
}
