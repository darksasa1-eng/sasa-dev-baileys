import { MediaError } from '../Defaults/errors';
import type { Logger } from '../Defaults/logger';
import { NOOP_LOGGER } from '../Defaults/logger';
import { DEFAULT_HTTP_USER_AGENT } from '../Defaults/defaults';
import type { RetryPolicy } from '../Socket/retry-manager';
import { RetryManager } from '../Socket/retry-manager';
import type { MediaCache } from './cache';
import { createMediaDecipher } from './crypto';
import type { MediaType } from './media-type';

export interface MediaDownloadSource {
  /** Full URL or `directPath` (appended to the media host) */
  url?: string;
  directPath?: string;
  mediaKey: Uint8Array;
  mediaType: MediaType;
  fileEncSha256?: Uint8Array;
  fileSha256?: Uint8Array;
  fileLength?: number;
}

export interface MediaDownloadOptions {
  logger?: Logger;
  fetch?: typeof fetch;
  userAgent?: string;
  host?: string;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  cache?: MediaCache;
  onProgress?: (progress: { bytesReceived: number; totalBytes?: number }) => void;
}

export interface MediaDownloadResult {
  data: Uint8Array;
  fileSha256: Uint8Array;
  fromCache: boolean;
  bytesDownloaded: number;
}

const MEDIA_CDN_HOST = 'https://mmg.whatsapp.net';

/**
 * Streaming Media Download — fetches an encrypted attachment, verifies MAC,
 * decrypts and caches it. `downloadStream` yields plaintext chunks and
 * verifies the MAC at the end of stream.
 */
export class MediaDownloader {
  readonly #logger: Logger;

  constructor(logger: Logger = NOOP_LOGGER) {
    this.#logger = logger;
  }

  /** Download and decrypt the whole attachment (RAM-bound to file size) */
  async download(source: MediaDownloadSource, options: MediaDownloadOptions = {}): Promise<MediaDownloadResult> {
    const cacheKey = options.cache
      ? source.fileEncSha256
        ? Buffer.from(source.fileEncSha256).toString('base64')
        : undefined
      : undefined;
    if (options.cache && cacheKey) {
      const hit = options.cache.get(cacheKey);
      if (hit) {
        return {
          data: hit.data,
          fileSha256: source.fileSha256 ?? new Uint8Array(0),
          fromCache: true,
          bytesDownloaded: 0,
        };
      }
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.downloadStream(source, options)) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.byteLength;
    }
    // the streaming path already verified MAC + fileSha256
    if (options.cache && cacheKey) options.cache.set(cacheKey, data);
    return {
      data,
      fileSha256: source.fileSha256 ?? new Uint8Array(0),
      fromCache: false,
      bytesDownloaded: data.byteLength,
    };
  }

  /**
   * Stream-decrypt an attachment chunk-by-chunk. Chunks before the final
   * one are emitted once their CBC blocks are validated state; the MAC is
   * verified when the source closes — on failure the final `next()` throws.
   */
  async *downloadStream(source: MediaDownloadSource, options: MediaDownloadOptions = {}): AsyncIterable<Uint8Array> {
    const logger = options.logger ?? this.#logger;
    const doFetch = options.fetch ?? fetch;
    const url = source.url ?? `${options.host ?? MEDIA_CDN_HOST}${source.directPath ?? ''}`;
    if (!source.directPath && !source.url) throw new MediaError('media download: no url/directPath provided');

    const retry = new RetryManager(
      options.retry ?? { maxAttempts: 3, baseMs: 500, maxMs: 8_000, factor: 2, jitter: 0.5 },
      logger,
    );
    const timeoutMs = options.timeoutMs ?? 60_000;

    const response = await retry.execute(async () => {
      const res = await doFetch(url, {
        headers: { 'user-agent': options.userAgent ?? DEFAULT_HTTP_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok)
        throw new MediaError(`media download failed: HTTP ${res.status}`, { data: { statusCode: res.status } });
      return res;
    });

    if (!response.body) throw new MediaError('media download: empty body');
    const totalBytes = Number(response.headers.get('content-length') ?? 0) || undefined;

    const decipher = createMediaDecipher(source.mediaKey, source.mediaType);
    let received = 0;
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        received += value.byteLength;
        const plain = decipher.update(value);
        options.onProgress?.({ bytesReceived: received, totalBytes });
        if (plain.byteLength > 0) yield plain;
      }
      const { tail } = decipher.finalize({ fileSha256: source.fileSha256 });
      if (tail.byteLength > 0) yield tail;
    } finally {
      reader.releaseLock();
    }
  }
}

/** Convenience functional API mirroring the class */
export async function downloadEncryptedMedia(
  source: MediaDownloadSource,
  options: MediaDownloadOptions = {},
): Promise<MediaDownloadResult> {
  return new MediaDownloader(options.logger).download(source, options);
}
