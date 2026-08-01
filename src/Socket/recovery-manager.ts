import { TypedEventEmitter } from '../Defaults/events';
import { getStatusCode } from '../Defaults/errors';
import { isFatalDisconnect, isRetryableDisconnect } from '../Defaults/disconnect-reason';
import { computeBackoff } from '../Utils/generics';

export interface RecoveryEvents {
  /** A reconnect will happen after `delayMs` */
  scheduled: { attempt: number; delayMs: number };
  /** The reconnect timer fired — consumer should connect now */
  trigger: { attempt: number };
  /** Recovery gave up (non-retryable error or attempt budget spent) */
  exhausted: { reason: string; lastErrorCode?: number };
}

export interface RecoveryPolicy {
  /** 0 = unlimited */
  maxAttempts: number;
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: number;
}

/**
 * Connection Recovery Manager — owns reconnect scheduling with exponential
 * backoff + jitter, attempt budgeting, and fatal-vs-retryable
 * classification. Multiple/duplicate schedule requests collapse into one
 * timer, so racy close events can't spawn parallel reconnect loops.
 */
export class ConnectionRecoveryManager extends TypedEventEmitter<RecoveryEvents> {
  readonly #policy: RecoveryPolicy;
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;
  #armed = false;
  #disposed = false;

  constructor(policy: Partial<RecoveryPolicy> = {}) {
    super();
    this.#policy = {
      maxAttempts: policy.maxAttempts ?? 0,
      baseMs: policy.baseMs ?? 1_000,
      factor: policy.factor ?? 2,
      maxMs: policy.maxMs ?? 120_000,
      jitter: policy.jitter ?? 1,
    };
  }

  get currentAttempt(): number {
    return this.#attempt;
  }

  get isScheduled(): boolean {
    return this.#armed;
  }

  /**
   * Decide what to do with a disconnect error and, if appropriate, schedule
   * a reconnect. Returns true when a reconnect was scheduled.
   */
  handleDisconnect(err: unknown): boolean {
    if (this.#disposed) return false;
    const code = getStatusCode(err);
    if (code !== undefined && isFatalDisconnect(code)) {
      this.emit('exhausted', { reason: 'fatal-disconnect', lastErrorCode: code });
      this.cancel();
      return false;
    }
    if (code !== undefined && !isRetryableDisconnect(code) && code !== 1000 && code !== 1001) {
      // Unknown close codes: still retry (WA uses app-specific close codes freely)
    }
    if (this.#policy.maxAttempts > 0 && this.#attempt >= this.#policy.maxAttempts) {
      this.emit('exhausted', { reason: 'max-attempts', lastErrorCode: code });
      return false;
    }
    this.#schedule();
    return true;
  }

  #schedule(): void {
    if (this.#armed || this.#disposed) return; // collapse duplicates
    const attempt = this.#attempt + 1;
    const delayMs = computeBackoff(attempt - 1, this.#policy);
    this.#armed = true;
    this.emit('scheduled', { attempt, delayMs });
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#armed = false;
      if (this.#disposed) return;
      this.#attempt = attempt;
      this.emit('trigger', { attempt });
    }, delayMs);
    this.#timer.unref?.();
  }

  /** Call after a successful connection to clear the failure budget */
  reset(): void {
    this.#attempt = 0;
    this.cancel();
  }

  /** Cancel any pending reconnect (e.g. user-initiated connect) */
  cancel(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#armed = false;
  }

  override dispose(): void {
    this.#disposed = true;
    this.cancel();
    this.removeAllListeners();
  }

  /**
   * Session Auto Recovery: if a stored session exists but the creds look
   * corrupted, callers can force re-pairing instead of looping forever.
   * Implemented as a policy hook at the client level; exposed here so the
   * recovery layer can flip into "stopped" cleanly.
   */
  forceStop(reason: string): void {
    this.emit('exhausted', { reason });
    this.cancel();
  }
}
