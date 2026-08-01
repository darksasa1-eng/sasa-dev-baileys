import { BufferJSON } from '../../Utils/buffer-json';
import type { StorageAdapter } from '../adapter';
import { wrapStorageError } from '../adapter';

/** Minimal structural interface over node-redis / ioredis clients (dependency injection) */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  keys?(pattern: string): Promise<string[]>;
  scanIterator?(opts: { MATCH: string; COUNT?: number }): AsyncIterable<string> | Iterable<string>;
}

export interface RedisStorageAdapterOptions {
  /** Key namespace prefix. Default `baileys:` */
  prefix?: string;
}

/**
 * Redis Storage Adapter (dependency-injected). All keys are namespaced with
 * a prefix, values are BufferJSON strings.
 *
 * ```ts
 * const adapter = new RedisStorageAdapter(redisClient);
 * ```
 */
export class RedisStorageAdapter implements StorageAdapter {
  readonly name = 'redis';
  readonly #client: RedisLikeClient;
  readonly #prefix: string;

  constructor(client: RedisLikeClient, options: RedisStorageAdapterOptions = {}) {
    this.#client = client;
    this.#prefix = options.prefix ?? 'baileys:';
  }

  #k(key: string): string {
    return this.#prefix + key;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.#client.get(this.#k(key));
      if (raw === null || raw === undefined) return undefined;
      return BufferJSON.parse<T>(raw);
    } catch (err) {
      throw wrapStorageError(err, `redis adapter: get failed for key ${key}`);
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await this.#client.set(this.#k(key), BufferJSON.stringify(value));
    } catch (err) {
      throw wrapStorageError(err, `redis adapter: set failed for key ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(this.#k(key));
  }

  async keys(prefix?: string): Promise<string[]> {
    const pattern = this.#k(prefix ? `${prefix}*` : '*');
    let full: string[] = [];
    if (this.#client.scanIterator) {
      for await (const key of this.#client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        full.push(String(key));
      }
    } else if (this.#client.keys) {
      full = await this.#client.keys(pattern);
    } else {
      throw new Error('redis adapter: client supports neither scanIterator nor keys()');
    }
    return full.map((k) => (k.startsWith(this.#prefix) ? k.slice(this.#prefix.length) : k));
  }

  async clear(): Promise<void> {
    const keys = await this.keys();
    if (keys.length > 0) await this.#client.del(keys.map((k) => this.#k(k)));
  }
}
