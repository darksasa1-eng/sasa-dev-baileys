import { randomBytes, randomUUID } from 'node:crypto';
import { TimedOutError } from '../Defaults/errors';

/** Resolve after `ms` (timer is unref'd so it never keeps the process alive) */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export interface TimeoutOptions {
  timeoutMs: number;
  message?: string;
}

/** Race a promise against a timeout; cleans up its timer either way */
export async function promiseTimeout<T>(promise: Promise<T>, opts: TimeoutOptions): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimedOutError(opts.message ?? `Timed out after ${opts.timeoutMs}ms`, { timeoutMs: opts.timeoutMs }));
    }, opts.timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * WhatsApp-style message ID: 32 uppercase hex chars (16 random bytes).
 * Honest entropy — no Math.random in message identity.
 */
export function generateMessageID(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}

/** UUID message registration id used by the MD client */
export function generateRegistrationId(): string {
  return randomUUID().replace(/-/g, '').toUpperCase();
}

export interface BackoffOptions {
  /** Base delay (ms) — delay before attempt #1 */
  baseMs?: number;
  /** Multiplier per attempt */
  factor?: number;
  /** Ceiling (ms) */
  maxMs?: number;
  /** 0..1 — fraction of full jitter applied to each delay */
  jitter?: number;
  /** Deterministic RNG override for tests */
  random?: () => number;
}

/**
 * Exponential backoff with full jitter.
 * Returns the delay for attempt `attempt` (0-based).
 */
export function computeBackoff(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs = 1_000, factor = 2, maxMs = 60_000, jitter = 1, random = Math.random } = options;
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, attempt));
  if (jitter <= 0) return raw;
  const spread = raw * jitter;
  const jittered = raw - spread + random() * spread;
  return Math.max(0, Math.min(maxMs, Math.round(jittered)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Debounce: only the last call within `waitMs` runs */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
    timer.unref?.();
  };
}

/** Throttle: at most one call per `intervalMs` (leading edge) */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, intervalMs: number): (...args: A) => void {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      fn(...args);
    }
  };
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Deep freeze (dev-time guard for shared config objects) */
export function deepFreeze<T>(obj: T): T {
  if (typeof obj === 'object' && obj !== null) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
    Object.freeze(obj);
  }
  return obj;
}
