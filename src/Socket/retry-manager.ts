import type { Logger } from '../Defaults/logger';
import { NOOP_LOGGER } from '../Defaults/logger';
import { computeBackoff } from '../Utils/generics';
import { getStatusCode } from '../Defaults/errors';
import { isFatalDisconnect } from '../Defaults/disconnect-reason';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: number;
  /** return false to stop early even with attempts remaining */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

export interface RetryAttemptRecord {
  attempt: number;
  delayMs: number;
  error?: string;
  timestamp: number;
}

/**
 * RetryManager — centralizes "should I retry and when" decision making with
 * exponential backoff + jitter, non-retryable error classification, and a
 * history of recent attempts (visible to the metrics layer).
 */
export class RetryManager {
  readonly policy: RetryPolicy;
  readonly #logger: Logger;
  readonly #history: RetryAttemptRecord[] = [];
  readonly #historyLimit = 100;

  constructor(policy: Partial<RetryPolicy> = {}, logger: Logger = NOOP_LOGGER) {
    this.policy = {
      maxAttempts: policy.maxAttempts ?? 3,
      baseMs: policy.baseMs ?? 1_000,
      factor: policy.factor ?? 2,
      maxMs: policy.maxMs ?? 60_000,
      jitter: policy.jitter ?? 1,
      shouldRetry: policy.shouldRetry,
    };
    this.#logger = logger;
  }

  /** Default retry classifier: fatal stream codes stop, Baileys code ERR_... */
  static networkRetryable(err: unknown): boolean {
    const status = getStatusCode(err);
    if (status !== undefined && isFatalDisconnect(status)) return false;
    return true;
  }

  delayFor(attempt: number): number {
    return computeBackoff(attempt, this.policy);
  }

  canRetry(err: unknown, attempt: number): boolean {
    if (this.policy.maxAttempts > 0 && attempt >= this.policy.maxAttempts) return false;
    if (this.policy.shouldRetry) return this.policy.shouldRetry(err, attempt);
    return RetryManager.networkRetryable(err);
  }

  /**
   * Execute `fn` until success, retry budget exhausted, or a non-retryable
   * error surfaces.
   */
  async execute<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        const result = await fn(attempt);
        return result;
      } catch (err) {
        const delayMs = this.delayFor(attempt);
        this.#record(attempt, delayMs, err);
        if (!this.canRetry(err, attempt + 1)) throw err;
        this.#logger.debug({ attempt, delayMs, err: String(err) }, 'retry scheduled');
        await sleep(delayMs);
        attempt += 1;
      }
    }
  }

  #record(attempt: number, delayMs: number, err: unknown): void {
    this.#history.push({
      attempt,
      delayMs,
      error: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    });
    if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);
  }

  get history(): readonly RetryAttemptRecord[] {
    return this.#history;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
