import { type DisconnectReason, disconnectReasonLabel } from './disconnect-reason';

export interface BaileysErrorOptions {
  /** Machine readable error code, e.g. `ERR_CONNECTION_CLOSED` */
  code?: string;
  /** Structured context attached to the error */
  data?: Record<string, unknown>;
  /** Original error that caused this one */
  cause?: unknown;
}

/**
 * Base class for every error thrown by the library.
 * Carries a stable machine readable `code` plus optional structured `data`.
 */
export class BaileysError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;
  readonly isBoom: boolean = false;

  constructor(message: string, options: BaileysErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'ERR_BAILEYS';
    this.data = options.data ?? {};
    if (Error.captureStackTrace) Error.captureStackTrace(this, new.target);
  }

  /** Serialize to a JSON safe object (useful for logging across processes) */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      data: this.data,
      stack: this.stack,
    };
  }
}

/** Thrown when an operation needs an open socket but none exists */
export class ConnectionClosedError extends BaileysError {
  constructor(message = 'Connection closed', options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_CONNECTION_CLOSED', ...options });
  }
}

/** Thrown when the underlying transport dies unexpectedly */
export class ConnectionLostError extends BaileysError {
  readonly statusCode?: number;

  constructor(message = 'Connection lost', options: BaileysErrorOptions & { statusCode?: number } = {}) {
    super(message, { code: 'ERR_CONNECTION_LOST', ...options });
    this.statusCode = options.statusCode;
  }
}

/** Thrown when a query/ack does not arrive within its timeout */
export class TimedOutError extends BaileysError {
  readonly timeoutMs: number;

  constructor(message = 'Operation timed out', options: BaileysErrorOptions & { timeoutMs?: number } = {}) {
    super(message, { code: 'ERR_TIMED_OUT', ...options });
    this.timeoutMs = options.timeoutMs ?? 0;
  }
}

/** Thrown when the handshake or authentication flow fails */
export class HandshakeError extends BaileysError {
  constructor(message: string, options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_HANDSHAKE_FAILED', ...options });
  }
}

/** Thrown when a payload fails cryptographic verification */
export class DecryptionError extends BaileysError {
  constructor(message: string, options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_DECRYPTION_FAILED', ...options });
  }
}

/** Thrown when incoming bytes violate the wire protocol */
export class ProtocolError extends BaileysError {
  constructor(message: string, options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_PROTOCOL', ...options });
  }
}

/** Thrown for media upload/download/encryption failures */
export class MediaError extends BaileysError {
  constructor(message: string, options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_MEDIA', ...options });
  }
}

/** Thrown by storage adapters */
export class StorageError extends BaileysError {
  constructor(message: string, options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_STORAGE', ...options });
  }
}

/** Thrown when client side rate limiting rejects a call */
export class RateLimitError extends BaileysError {
  readonly retryAfterMs: number;

  constructor(message = 'Rate limited', options: BaileysErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, { code: 'ERR_RATE_LIMITED', ...options });
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

/** Thrown when the queue / backpressure limits are exceeded */
export class BackpressureError extends BaileysError {
  constructor(message = 'Backpressure limit exceeded', options: BaileysErrorOptions = {}) {
    super(message, { code: 'ERR_BACKPRESSURE', ...options });
  }
}

/**
 * Error produced when the socket tears down with a WA `<stream:error>`.
 * `output.statusCode` mirrors the Boom-style API used by older libraries,
 * so `error.output.statusCode === DisconnectReason.loggedOut` style checks
 * continue to work.
 */
export class StreamError extends BaileysError {
  readonly output: { statusCode: number; payload: Record<string, unknown> };

  constructor(reason: DisconnectReason | number, data: Record<string, unknown> = {}) {
    const label = disconnectReasonLabel(reason);
    super(`Stream error: ${label}`, { code: 'ERR_STREAM', data: { ...data, statusCode: reason } });
    this.output = { statusCode: reason, payload: data };
  }

  get statusCode(): number {
    return this.output.statusCode;
  }
}

/** Type guard that narrows unknown errors to {@link BaileysError} */
export function isBaileysError(err: unknown): err is BaileysError {
  return err instanceof BaileysError;
}

/** Extract a Boom-compatible status code from any thrown value */
export function getStatusCode(err: unknown): number | undefined {
  if (err instanceof StreamError) return err.statusCode;
  if (err instanceof ConnectionLostError) return err.statusCode;
  if (typeof err === 'object' && err !== null) {
    const output = (err as { output?: { statusCode?: unknown } }).output;
    if (output && typeof output.statusCode === 'number') return output.statusCode;
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return undefined;
}
