import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, type Logger } from '../../Defaults/logger';
import { BufferJSON } from '../../Utils/buffer-json';
import type { StorageAdapter } from '../adapter';
import { wrapStorageError } from '../adapter';

export interface FileStorageAdapterOptions {
  logger?: Logger;
}

/**
 * Encode a logical key into a filename and back (lossless, path-safe).
 */
function keyToFileName(key: string): string {
  return Buffer.from(key, 'utf-8').toString('base64url') + '.json';
}

function fileNameToKey(name: string): string | undefined {
  if (!name.endsWith('.json')) return undefined;
  try {
    return Buffer.from(name.slice(0, -'.json'.length), 'base64url').toString('utf-8');
  } catch {
    return undefined;
  }
}

/**
 * File Storage Adapter: one file per key in a directory (the modernized
 * successor of `useMultiFileAuthState`).
 *
 * - atomic writes (tmp + rename) — a crash cannot leave half-written creds
 * - per-key write chains prevent concurrent writes to the same file
 * - filenames are base64url encodings of the logical key, so no traversal is
 *   possible and `keys()` recovers the exact original logical keys
 */
export class FileStorageAdapter implements StorageAdapter {
  readonly name = 'file';
  readonly #dir: string;
  readonly #logger: Logger;
  #writeChains = new Map<string, Promise<void>>();
  #connected = false;

  constructor(directory: string, options: FileStorageAdapterOptions = {}) {
    this.#dir = directory;
    this.#logger = options.logger ?? createLogger({ level: 'warn' });
  }

  #pathFor(key: string): string {
    return join(this.#dir, keyToFileName(key));
  }

  async connect(): Promise<void> {
    if (this.#connected) return;
    try {
      await mkdir(this.#dir, { recursive: true });
      this.#connected = true;
    } catch (err) {
      throw wrapStorageError(err, `file adapter: cannot create directory ${this.#dir}`);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const text = await readFile(this.#pathFor(key), 'utf-8');
      return BufferJSON.parse<{ value: T }>(text).value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw wrapStorageError(err, `file adapter: read failed for key ${key}`);
    }
  }

  set<T>(key: string, value: T): Promise<void> {
    const payload = BufferJSON.stringify({ value });
    const file = this.#pathFor(key);
    const prev = this.#writeChains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        await this.connect();
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, payload, 'utf-8');
        await rename(tmp, file);
      } catch (err) {
        throw wrapStorageError(err, `file adapter: write failed for key ${key}`);
      }
    });
    this.#writeChains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.#pathFor(key), { force: true });
    } catch (err) {
      throw wrapStorageError(err, `file adapter: delete failed for key ${key}`);
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    try {
      await this.connect();
      const entries = await readdir(this.#dir);
      const keys = entries.flatMap((f) => {
        const decoded = fileNameToKey(f);
        return decoded === undefined ? [] : [decoded];
      });
      return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
    } catch (err) {
      throw wrapStorageError(err, 'file adapter: cannot list keys');
    }
  }

  async clear(): Promise<void> {
    try {
      await this.connect();
      const entries = await readdir(this.#dir);
      await Promise.all(entries.filter((f) => f.endsWith('.json')).map((f) => rm(join(this.#dir, f), { force: true })));
    } catch (err) {
      this.#logger.warn({ err: String(err) }, 'file adapter: clear failed');
    }
  }
}
