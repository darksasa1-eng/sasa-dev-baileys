import { StorageError } from '../Defaults/errors';

/**
 * StorageAdapter — the contract behind every auth/session persistence
 * backend. Values are JSON-serializable (use the BufferJSON codec for
 * binary data); adapters never see class instances.
 *
 * Implementations must be safe for concurrent `set` calls on different keys;
 * the auth layer serializes writes per key via its own queue.
 */
export interface StorageAdapter {
  /** Adapter identifier, e.g. `json`, `redis` */
  readonly name: string;
  /** One-time initialization (create tables, open handles…) */
  connect?(): Promise<void>;
  /** Get an item or `undefined` when missing. Must not throw for miss. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Upsert an item */
  set<T = unknown>(key: string, value: T): Promise<void>;
  /** Delete an item (missing keys are not an error) */
  delete(key: string): Promise<void>;
  /** List keys, optionally filtered by prefix */
  keys(prefix?: string): Promise<string[]>;
  /** Remove all items (used for logout / wipe) */
  clear?(): Promise<void>;
  /** Release resources */
  close?(): Promise<void>;
}

/** Guard helper for adapters */
export function wrapStorageError(err: unknown, context: string): StorageError {
  if (err instanceof StorageError) return err;
  return new StorageError(`${context}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
}
