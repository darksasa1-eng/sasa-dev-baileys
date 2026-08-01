/**
 * Media Cache — size-capped LRU keyed by content hash.
 *
 * Entries are inserted at-most-once by callers (downloader): repeated
 * downloads of the same attachment are served from memory without touching
 * the network. Bounds RAM: evicts least-recently-used entries past
 * `maxBytes`.
 */
export class MediaCache {
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  #entries = new Map<string, { data: Uint8Array; bytes: number; mime?: string; hits: number }>();
  #currentBytes = 0;
  #hits = 0;
  #misses = 0;

  constructor(options: { maxBytes?: number; maxEntries?: number } = {}) {
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.#maxEntries = options.maxEntries ?? 512;
  }

  get stats(): { entries: number; bytes: number; hits: number; misses: number; hitRate: number } {
    const total = this.#hits + this.#misses;
    return {
      entries: this.#entries.size,
      bytes: this.#currentBytes,
      hits: this.#hits,
      misses: this.#misses,
      hitRate: total === 0 ? 0 : this.#hits / total,
    };
  }

  static keyFor(fileEncSha256: Uint8Array | string | undefined): string | undefined {
    if (!fileEncSha256) return undefined;
    if (typeof fileEncSha256 === 'string') return fileEncSha256;
    return Buffer.from(fileEncSha256).toString('base64');
  }

  get(key: string): { data: Uint8Array; mime?: string } | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    entry.hits += 1;
    // LRU touch
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return { data: entry.data, mime: entry.mime };
  }

  set(key: string, data: Uint8Array, mime?: string): void {
    if (data.byteLength > this.#maxBytes) return; // too large to cache
    const existing = this.#entries.get(key);
    if (existing) {
      this.#currentBytes -= existing.bytes;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { data, bytes: data.byteLength, mime, hits: 0 });
    this.#currentBytes += data.byteLength;
    this.#evictIfNeeded();
  }

  delete(key: string): boolean {
    const existing = this.#entries.get(key);
    if (!existing) return false;
    this.#currentBytes -= existing.bytes;
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
    this.#currentBytes = 0;
  }

  #evictIfNeeded(): void {
    while (this.#currentBytes > this.#maxBytes || this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
