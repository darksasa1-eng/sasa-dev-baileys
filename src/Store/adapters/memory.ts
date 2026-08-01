import type { StorageAdapter } from '../adapter';

/** Volatile in-memory adapter — the default; data dies with the process */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly name = 'memory';
  #map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.#map.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const all = [...this.#map.keys()];
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
  }

  async clear(): Promise<void> {
    this.#map.clear();
  }

  get size(): number {
    return this.#map.size;
  }
}
