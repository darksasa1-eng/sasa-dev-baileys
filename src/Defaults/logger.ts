/**
 * Custom Logger API.
 *
 * The interface intentionally matches the subset of pino's API the library
 * uses, so a pino (or any pino-compatible) logger can be injected directly:
 *
 * ```ts
 * import pino from 'pino';
 * createClient({ logger: pino({ level: 'warn' }) as unknown as Logger });
 * ```
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
  level: string;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  /** Create a child logger that always merges `bindings` into every record */
  child(bindings: Record<string, unknown>): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 60,
};

function normalizeLevel(level: string): LogLevel {
  return (level.toLowerCase() as LogLevel) in LEVEL_ORDER ? (level.toLowerCase() as LogLevel) : 'info';
}

/** Zero-allocation logger that drops everything (useful in benchmarks/tests) */
export const NOOP_LOGGER: Logger = {
  level: 'silent',
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => NOOP_LOGGER,
};

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  /** Prefix written before every line */
  name?: string;
  /** Inject a clock (testing) */
  now?: () => Date;
  /** Extra structured bindings merged into every record */
  bindings?: Record<string, unknown>;
}

/**
 * Dependency-free structured logger. Writes single JSON records to stdout/stderr
 * below the `level` threshold. Cheap: disabled levels cost one numeric compare.
 */
export class ConsoleLogger implements Logger {
  level: string;
  readonly #opts: Required<Pick<ConsoleLoggerOptions, 'name' | 'now'>> & ConsoleLoggerOptions;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.level = normalizeLevel(options.level ?? 'info');
    this.#opts = { name: options.name ?? 'sasa-baileys', now: options.now ?? (() => new Date()), ...options };
  }

  #threshold(): number {
    return LEVEL_ORDER[normalizeLevel(this.level)];
  }

  #write(level: LogLevel, obj: unknown, msg?: string): void {
    if (LEVEL_ORDER[level] < this.#threshold()) return;
    const record: Record<string, unknown> = {
      time: this.#opts.now().toISOString(),
      level,
      name: this.#opts.name,
      ...this.#opts.bindings,
    };
    if (typeof obj === 'string' && msg === undefined) {
      record.msg = obj;
    } else {
      if (obj !== undefined) record.data = obj instanceof Error ? serializeError(obj) : obj;
      if (msg !== undefined) record.msg = msg;
    }
    const line = JSON.stringify(record);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.error) console.error(line);
    else if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) console.warn(line);
    else console.log(line);
  }

  trace(obj: unknown, msg?: string): void {
    this.#write('trace', obj, msg);
  }
  debug(obj: unknown, msg?: string): void {
    this.#write('debug', obj, msg);
  }
  info(obj: unknown, msg?: string): void {
    this.#write('info', obj, msg);
  }
  warn(obj: unknown, msg?: string): void {
    this.#write('warn', obj, msg);
  }
  error(obj: unknown, msg?: string): void {
    this.#write('error', obj, msg);
  }

  child(bindings: Record<string, unknown>): Logger {
    const child = new ConsoleLogger({
      level: normalizeLevel(this.level),
      name: this.#opts.name,
      now: this.#opts.now,
      bindings: { ...this.#opts.bindings, ...bindings },
    });
    return child;
  }
}

function serializeError(err: Error): Record<string, unknown> {
  return { name: err.name, message: err.message, stack: err.stack };
}

/** Create a logger from options or a partial custom implementation */
export function createLogger(options: ConsoleLoggerOptions | Logger): Logger {
  if (typeof (options as Logger).child === 'function' && typeof (options as Logger).info === 'function') {
    return options as Logger;
  }
  return new ConsoleLogger(options as ConsoleLoggerOptions);
}

/** Wrap a logger so `bindings` are attached to all records without copying */
export function bindLogger(logger: Logger, bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
