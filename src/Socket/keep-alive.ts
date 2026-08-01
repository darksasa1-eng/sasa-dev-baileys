export interface KeepAliveCallbacks {
  /** Send a protocol-level keepalive (returns a promise resolved when acked) */
  ping: () => Promise<unknown>;
  /** Called when a ping exceeds the deadline *and* the grace period */
  onStale: () => void;
}

/**
 * Keep-alive manager: sends pings on an interval, tracks whether the last
 * ping was answered, and triggers a single `onStale` callback (with one
 * grace circle) when the server goes quiet. No timers leak: every interval
 * is cleared in `stop`, and `stop` is idempotent.
 */
export class KeepAliveManager {
  readonly #intervalMs: number;
  readonly #callbacks: KeepAliveCallbacks;
  #timer: NodeJS.Timeout | undefined;
  #awaitingAck = false;
  #missedIntervals = 0;
  readonly #maxMissed: number;

  constructor(options: { intervalMs: number; maxMissedIntervals?: number }, callbacks: KeepAliveCallbacks) {
    this.#intervalMs = options.intervalMs;
    this.#maxMissed = options.maxMissedIntervals ?? 2;
    this.#callbacks = callbacks;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(): void {
    if (this.#timer) return;
    this.#missedIntervals = 0;
    this.#awaitingAck = false;
    this.#timer = setInterval(() => void this.#tick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  async #tick(): Promise<void> {
    if (this.#awaitingAck) {
      this.#missedIntervals += 1;
      if (this.#missedIntervals >= this.#maxMissed) {
        this.stop();
        this.#callbacks.onStale();
        return;
      }
    }
    this.#awaitingAck = true;
    try {
      await this.#callbacks.ping();
      this.#awaitingAck = false;
      this.#missedIntervals = 0;
    } catch {
      // the next tick counts it as a miss
    }
  }

  /** Mark any incoming traffic as liveness even between pings */
  noteExternalActivity(): void {
    this.#awaitingAck = false;
    this.#missedIntervals = 0;
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#awaitingAck = false;
    this.#missedIntervals = 0;
  }
}
