import { BufferJSON } from '../../Utils/buffer-json';
import type { StorageAdapter } from '../adapter';
import { wrapStorageError } from '../adapter';

/**
 * Minimal structural interface over `better-sqlite3`'s Database
 * (dependency injection — pass any compatible client).
 */
export interface SqliteLikeStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown;
}

export interface SqliteLikeDatabase {
  prepare(sql: string): SqliteLikeStatement;
  exec(sql: string): unknown;
  pragma?(pragma: string): unknown;
  close?(): void;
}

export interface SqliteStorageAdapterOptions {
  table?: string;
}

/**
 * SQLite Storage Adapter (dependency-injected).
 *
 * ```ts
 * import Database from 'better-sqlite3';
 * const adapter = new SqliteStorageAdapter(new Database('baileys.db'));
 * ```
 */
export class SqliteStorageAdapter implements StorageAdapter {
  readonly name = 'sqlite';
  readonly #db: SqliteLikeDatabase;
  readonly #table: string;
  #ready = false;

  constructor(db: SqliteLikeDatabase, options: SqliteStorageAdapterOptions = {}) {
    this.#db = db;
    this.#table = options.table ?? 'baileys_kv';
  }

  async connect(): Promise<void> {
    if (this.#ready) return;
    try {
      this.#db.pragma?.('journal_mode = WAL');
      this.#db.exec(`CREATE TABLE IF NOT EXISTS ${this.#table} (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
      this.#ready = true;
    } catch (err) {
      throw wrapStorageError(err, 'sqlite adapter: init failed');
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.connect();
    try {
      const row = this.#db.prepare(`SELECT value FROM ${this.#table} WHERE key = ?`).get(key) as
        { value: string } | undefined;
      if (!row) return undefined;
      return BufferJSON.parse<T>(row.value);
    } catch (err) {
      throw wrapStorageError(err, `sqlite adapter: get failed for key ${key}`);
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.connect();
    try {
      this.#db
        .prepare(
          `INSERT INTO ${this.#table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, BufferJSON.stringify(value));
    } catch (err) {
      throw wrapStorageError(err, `sqlite adapter: set failed for key ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    await this.connect();
    this.#db.prepare(`DELETE FROM ${this.#table} WHERE key = ?`).run(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    await this.connect();
    const rows = (
      prefix
        ? this.#db.prepare(`SELECT key FROM ${this.#table} WHERE key LIKE ?`).all(`${prefix}%`)
        : this.#db.prepare(`SELECT key FROM ${this.#table}`).all()
    ) as { key: string }[];
    return rows.map((r) => r.key);
  }

  async clear(): Promise<void> {
    await this.connect();
    this.#db.exec(`DELETE FROM ${this.#table}`);
  }

  async close(): Promise<void> {
    this.#db.close?.();
  }
}
