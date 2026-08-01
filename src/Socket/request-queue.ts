import { BackpressureError, TimedOutError } from '../Defaults/errors';
import type { TokenBucketRateLimiter } from './rate-limiter';

export interface RequestQueueOptions {
  /** Maximum tasks executing at once */
  concurrency: number;
  /** Hard cap on waiting tasks (rejects with BackpressureError beyond) */
  maxPending?: number;
  /** Optional rate limiter consulted before starting a task */
  rateLimiter?: TokenBucketRateLimiter;
  /** Default per-task execution timeout */
  taskTimeoutMs?: number;
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  priority: number;
  enqueuedAt: number;
  timeoutMs?: number;
}

/**
 * Priority-aware, concurrency-limited, optionally rate-limited request
 * queue. Backpressure: rejects enqueue once `maxPending` waiting tasks
 * accumulate, protecting RAM under extended outages.
 */
export class RequestQueue {
  readonly #opts: Required<Omit<RequestQueueOptions, 'rateLimiter'>> & Pick<RequestQueueOptions, 'rateLimiter'>;
  #queue: QueuedTask<unknown>[] = [];
  #running = 0;
  #disposed = false;
  #totalExecuted = 0;
  #totalRejected = 0;

  constructor(options: RequestQueueOptions) {
    this.#opts = {
      concurrency: Math.max(1, options.concurrency),
      maxPending: options.maxPending ?? 10_000,
      taskTimeoutMs: options.taskTimeoutMs ?? 60_000,
      rateLimiter: options.rateLimiter,
    };
  }

  get pending(): number {
    return this.#queue.length;
  }

  get running(): number {
    return this.#running;
  }

  get stats(): { pending: number; running: number; executed: number; rejected: number } {
    return { pending: this.pending, running: this.#running, executed: this.#totalExecuted, rejected: this.#totalRejected };
  }

  /**
   * Enqueue a task. Higher `priority` starts sooner (FIFO within a
   * priority). The returned promise settles with the task's own result.
   */
  enqueue<T>(run: () => Promise<T>, opts: { priority?: number; timeoutMs?: number } = {}): Promise<T> {
    if (this.#disposed) return Promise.reject(new BackpressureError('RequestQueue disposed'));
    if (this.#queue.length >= this.#opts.maxPending) {
      this.#totalRejected += 1;
      return Promise.reject(new BackpressureError(`RequestQueue full (${this.#opts.maxPending} pending)`));
    }
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        run,
        resolve,
        reject,
        priority: opts.priority ?? 0,
        enqueuedAt: Date.now(),
        timeoutMs: opts.timeoutMs,
      };
      // insert keeping priority desc, FIFO within same priority
      let idx = this.#queue.findIndex((t) => t.priority < task.priority);
      if (idx === -1) idx = this.#queue.length;
      this.#queue.splice(idx, 0, task as QueuedTask<unknown>);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#running < this.#opts.concurrency && this.#queue.length > 0) {
      const task = this.#queue.shift();
      if (!task) return;
      this.#running += 1;
      void this.#execute(task).finally(() => {
        this.#running -= 1;
        this.#totalExecuted += 1;
        this.#drain();
      });
    }
  }

  async #execute<T>(task: QueuedTask<T>): Promise<void> {
    const timeoutMs = task.timeoutMs ?? this.#opts.taskTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (this.#opts.rateLimiter) await this.#opts.rateLimiter.acquire(1, timeoutMs);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimedOutError(`queued task exceeded ${timeoutMs}ms`, { timeoutMs })), timeoutMs);
        timer.unref?.();
      });
      const result = await Promise.race([task.run(), timeout]);
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Reject all waiting tasks and stop draining */
  dispose(reason = 'RequestQueue disposed'): void {
    this.#disposed = true;
    const err = new BackpressureError(reason);
    for (const task of this.#queue.splice(0)) task.reject(err);
  }
}
