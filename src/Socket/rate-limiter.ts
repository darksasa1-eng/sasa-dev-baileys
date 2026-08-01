import { RateLimitError } from '../Defaults/errors';

/**
 * Token-bucket rate limiter (async waiting, reservation-based).
 *
 * Waiters reserve capacity in FD order — when traffic exceeds the rate every
 * waiter still gets scheduled at the earliest lawful instant, so bursts are
 * smoothed instead of starved.
 */
export class TokenBucketRateLimiter {
  readonly #capacity: number;
  #ratePerMs: number;
  #tokens: number;
  #lastRefill: number;
  #reservationEnd = 0;
  #pending = new Set<NodeJS.Timeout>();

  constructor(opts: { ratePerSecond: number; burst?: number }) {
    if (opts.ratePerSecond <= 0) throw new RangeError('ratePerSecond must be > 0');
    this.#ratePerMs = opts.ratePerSecond / 1000;
    this.#capacity = opts.burst ?? opts.ratePerSecond;
    this.#tokens = this.#capacity;
    this.#lastRefill = Date.now();
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefill;
    if (elapsed > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#ratePerMs);
      this.#lastRefill = now;
    }
  }

  /** Tokens available *right now* (does not count future reservations) */
  get available(): number {
    this.#refill(Date.now());
    return this.#tokens;
  }

  get ratePerSecond(): number {
    return this.#ratePerMs * 1000;
  }

  setRatePerSecond(rate: number): void {
    if (rate <= 0) throw new RangeError('rate must be > 0');
    this.#ratePerMs = rate / 1000;
  }

  /**
   * Wait until `tokens` can be consumed. If the computed wait exceeds
   * `maxWaitMs`, rejects with {@link RateLimitError}.
   */
  acquire(tokens = 1, maxWaitMs = 30_000): Promise<void> {
    const now = Date.now();
    this.#refill(now);
    if (tokens > this.#capacity) {
      return Promise.reject(new RangeError(`requested ${tokens} tokens but capacity is ${this.#capacity}`));
    }
    if (tokens <= this.#tokens && this.#reservationEnd <= now) {
      this.#tokens -= tokens;
      return Promise.resolve();
    }

    const waitForTokensMs = Math.ceil((tokens - this.#tokens) / this.#ratePerMs);
    const grantAt = Math.max(now + waitForTokensMs, this.#reservationEnd);
    const totalWait = grantAt - now;
    if (totalWait > maxWaitMs) {
      return Promise.reject(
        new RateLimitError(`rate limiter wait ${totalWait}ms exceeds budget ${maxWaitMs}ms`, {
          retryAfterMs: totalWait,
        }),
      );
    }

    // Reserve the slot now so concurrent callers queue behind us.
    this.#tokens = Math.max(0, this.#tokens - tokens);
    this.#reservationEnd = Math.max(grantAt, now);

    return new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(timer);
          resolve();
        },
        Math.max(0, totalWait),
      );
      timer.unref?.();
      this.#pending.add(timer);
    });
  }

  /** Consume synchronously only if tokens are available right now */
  tryAcquire(tokens = 1): boolean {
    const now = Date.now();
    this.#refill(now);
    if (tokens <= this.#tokens && this.#reservationEnd <= now) {
      this.#tokens -= tokens;
      return true;
    }
    return false;
  }

  /** Cancel pending reservations (shutdown) */
  dispose(): void {
    for (const timer of this.#pending) clearTimeout(timer);
    this.#pending.clear();
    this.#reservationEnd = 0;
    this.#tokens = this.#capacity;
  }
}
