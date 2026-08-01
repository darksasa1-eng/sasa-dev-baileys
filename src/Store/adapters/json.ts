import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, type Logger } from '../../Defaults/logger';
import { BufferJSON } from '../../Utils/buffer-json';
import type { StorageAdapter } from '../adapter';
import { wrapStorageError } from '../adapter';

export interface JsonStorageAdapterOptions {
  /** Flush interval — writes are batched for this long (ms). Default 250 */
  flushIntervalMs?: number;
  logger?: Logger;
}

/**
 * JSON Storage Adapter: every session material lives in ONE JSON file.
 *
 * Characteristics:
 * - writes are debounced into a single atomic write (tmp file + rename) —
 *   no torn files on crash
 * - writes serialize through a module-local promise chain (single writer)
 * - the file is loaded eagerly once on first access
 *
 * Ideal for small deployments; prefer the file adapter for high key churn,
 * or SQLite/Redis for multi-process access.
 */
export class JsonStorageAdapter implements StorageAdapter {
  readonly name = 'json';
  #data = new Map<string, unknown>();
  #loaded = false;
  #dirty = false;
  #flushTimer: NodeJS.Timeout | undefined;
  #writeChain: Promise<void> = Promise.resolve();
  readonly #filePath: string;
  readonly #flushIntervalMs: number;
  readonly #logger: Logger;

  constructor(filePath: string, options: JsonStorageAdapterOptions = {}) {
    this.#filePath = filePath;
    this.#flushIntervalMs = options.flushIntervalMs ?? 250;
    this.#logger = options.logger ?? createLogger({ level: 'warn' });
  }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const text = readFileSync(this.#filePath, 'utf-8');
      const parsed = BufferJSON.parse<Record<string, unknown>>(text);
      for (const [k, v] of Object.entries(parsed)) this.#data.set(k, v);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#logger.warn({ file: this.#filePath, err: String(err) }, 'json adapter: failed to load, starting empty');
      }
    }
  }

  #scheduleFlush(): void {
    this.#dirty = true;
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.flush();
    }, this.#flushIntervalMs);
    this.#flushTimer.unref?.();
  }

  /** Write pending changes NOW (atomic: tmp + rename). Serialized across calls. */
  async flush(): Promise<void> {
    if (!this.#dirty) return;
    const snapshot = BufferJSON.stringify(Object.fromEntries(this.#data));
    this.#dirty = false;
    this.#writeChain = this.#writeChain.then(() => {
      try {
        mkdirSync(dirname(this.#filePath), { recursive: true });
        const tmp = `${this.#filePath}.tmp-${process.pid}`;
        writeFileSync(tmp, snapshot, 'utf-8');
        renameSync(tmp, this.#filePath);
      } catch (err) {
        this.#dirty = true; // retry on next flush
        throw wrapStorageError(err, `json adapter: failed to write ${this.#filePath}`);
      }
    });
    await this.#writeChain;
  }

  async get<T>(key: string): Promise<T | undefined> {
    this.#load();
    return this.#data.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#load();
    this.#data.set(key, value);
    this.#scheduleFlush();
  }

  async delete(key: string): Promise<void> {
    this.#load();
    this.#data.delete(key);
    this.#scheduleFlush();
  }

  async keys(prefix?: string): Promise<string[]> {
    this.#load();
    const all = [...this.#data.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }

  async clear(): Promise<void> {
    this.#data.clear();
    this.#dirty = true;
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    await this.flush();
  }
}
