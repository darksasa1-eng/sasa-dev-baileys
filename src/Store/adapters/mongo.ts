import type { StorageAdapter } from '../adapter';
import { wrapStorageError } from '../adapter';

/** Minimal structural interface over a MongoDB collection (dependency injection) */
export interface MongoLikeCollection {
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  replaceOne(
    filter: Record<string, unknown>,
    doc: Record<string, unknown>,
    opts?: { upsert?: boolean },
  ): Promise<unknown>;
  deleteOne(filter: Record<string, unknown>): Promise<unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
  find(filter: Record<string, unknown>): {
    project(spec: Record<string, 0 | 1>): { toArray(): Promise<Record<string, unknown>[]> };
  };
  createIndex?(keySpec: Record<string, 1 | -1>, opts?: { unique?: boolean }): Promise<unknown>;
}

export interface MongoStorageAdapterOptions {
  /** Field used as the key. Default `_id` */
  keyField?: string;
}

/**
 * MongoDB Storage Adapter (dependency-injected).
 *
 * ```ts
 * const adapter = new MongoStorageAdapter(db.collection('baileys_auth'));
 * ```
 */
export class MongoStorageAdapter implements StorageAdapter {
  readonly name = 'mongo';
  readonly #collection: MongoLikeCollection;
  readonly #keyField: string;
  #ready = false;

  constructor(collection: MongoLikeCollection, options: MongoStorageAdapterOptions = {}) {
    this.#collection = collection;
    this.#keyField = options.keyField ?? '_id';
  }

  async connect(): Promise<void> {
    if (this.#ready) return;
    if (this.#keyField !== '_id') {
      await this.#collection.createIndex?.({ [this.#keyField]: 1 }, { unique: true });
    }
    this.#ready = true;
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const doc = await this.#collection.findOne({ [this.#keyField]: key });
      if (!doc) return undefined;
      return doc.value as T;
    } catch (err) {
      throw wrapStorageError(err, `mongo adapter: get failed for key ${key}`);
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await this.#collection.replaceOne(
        { [this.#keyField]: key },
        { [this.#keyField]: key, value },
        { upsert: true },
      );
    } catch (err) {
      throw wrapStorageError(err, `mongo adapter: set failed for key ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.#collection.deleteOne({ [this.#keyField]: key });
  }

  async keys(prefix?: string): Promise<string[]> {
    const filter: Record<string, unknown> = prefix ? { [this.#keyField]: { $regex: `^${prefix}` } } : {};
    const docs = await this.#collection
      .find(filter)
      .project({ [this.#keyField]: 1, value: 0 })
      .toArray();
    return docs.map((d) => String(d[this.#keyField]));
  }

  async clear(): Promise<void> {
    await this.#collection.deleteMany({});
  }
}
