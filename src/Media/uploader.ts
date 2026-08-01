import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { MediaError } from '../Defaults/errors';
import type { Logger } from '../Defaults/logger';
import { NOOP_LOGGER } from '../Defaults/logger';
import { DEFAULT_HTTP_USER_AGENT, MEDIA_UPLOAD_URL } from '../Defaults/defaults';
import type { RetryPolicy } from '../Socket/retry-manager';
import { RetryManager } from '../Socket/retry-manager';
import { createMediaCipher, encryptMedia, generateMediaKey } from './crypto';
import { getUploadPath, type MediaType } from './media-type';

export interface MediaUploadOptions {
  /** Data source: buffer or file path (streaming when path) */
  data: Uint8Array | string;
  mediaType: MediaType;
  /** Upload auth token acquired out-of-band from the socket */
  uploadToken?: string;
  mediaKey?: Uint8Array;
  logger?: Logger;
  fetch?: typeof fetch;
  host?: string;
  userAgent?: string;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  onProgress?: (progress: MediaUploadProgress) => void;
}

export interface MediaUploadProgress {
  phase: 'encrypting' | 'uploading';
  bytesProcessed: number;
  totalBytes?: number;
}

export interface MediaUploadResult {
  url: string;
  directPath?: string;
  handle?: string;
  mediaKey: Uint8Array;
  fileSha256: Uint8Array;
  fileEncSha256: Uint8Array;
  fileLength: number;
}

/**
 * Streaming Media Upload — reads, encrypts (single pass), and uploads
 * bytes to the WhatsApp media host. File sources never materialize the
 * whole attachment in RAM.
 */
export class MediaUploader {
  readonly #logger: Logger;

  constructor(logger: Logger = NOOP_LOGGER) {
    this.#logger = logger;
  }

  async upload(options: MediaUploadOptions): Promise<MediaUploadResult> {
    const logger = options.logger ?? this.#logger;
    const doFetch = options.fetch ?? fetch;
    const host = options.host ?? MEDIA_UPLOAD_URL;
    const mediaKey = options.mediaKey ?? generateMediaKey();

    if (typeof options.data === 'string') {
      return this.#uploadFromFile(options, mediaKey, doFetch, host, logger);
    }
    return this.#uploadFromBuffer(options, mediaKey, doFetch, host, logger);
  }

  async #uploadFromBuffer(
    options: MediaUploadOptions & { data: Uint8Array | string },
    mediaKey: Uint8Array,
    doFetch: typeof fetch,
    host: string,
    logger: Logger,
  ): Promise<MediaUploadResult> {
    const plain = options.data as Uint8Array;
    options.onProgress?.({ phase: 'encrypting', bytesProcessed: 0, totalBytes: plain.byteLength });
    const enc = encryptMedia(plain, options.mediaType, mediaKey);
    options.onProgress?.({ phase: 'encrypting', bytesProcessed: plain.byteLength, totalBytes: plain.byteLength });
    const result = await this.#postEncrypted(enc.body, options, doFetch, host, logger);
    return { ...result, mediaKey, fileSha256: enc.fileSha256, fileEncSha256: enc.fileEncSha256, fileLength: enc.fileLength };
  }

  async #uploadFromFile(
    options: MediaUploadOptions & { data: Uint8Array | string },
    mediaKey: Uint8Array,
    doFetch: typeof fetch,
    host: string,
    logger: Logger,
  ): Promise<MediaUploadResult> {
    const path = options.data as string;
    const fileStat = await stat(path).catch((err: unknown) => {
      throw new MediaError(`media upload: cannot stat ${path}`, { cause: err });
    });

    options.onProgress?.({ phase: 'encrypting', bytesProcessed: 0, totalBytes: fileStat.size });
    const cipher = createMediaCipher(options.mediaType, mediaKey);
    const parts: Uint8Array[] = [];
    let processed = 0;
    let totalBytes = 0;
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      const out = cipher.update(chunk as Buffer);
      parts.push(out);
      processed += (chunk as Buffer).byteLength;
      totalBytes += out.byteLength;
      options.onProgress?.({ phase: 'encrypting', bytesProcessed: processed, totalBytes: fileStat.size });
    }
    const final = cipher.finalize();
    parts.push(final.body);
    totalBytes += final.body.byteLength;

    const retryAttempts = options.retry?.maxAttempts ?? 3;
    let result: Pick<MediaUploadResult, 'url' | 'directPath' | 'handle'>;
    if (retryAttempts <= 1 && supportsStreamingBody()) {
      // true zero-copy streaming upload (single attempt: streaming request
      // bodies cannot be replayed safely by HTTP clients)
      const stream = webStreamFromParts(parts);
      result = await this.#postEncrypted(stream, options, doFetch, host, logger, totalBytes);
    } else {
      const body = new Uint8Array(totalBytes);
      let offset = 0;
      for (const p of parts) {
        body.set(p, offset);
        offset += p.byteLength;
      }
      result = await this.#postEncrypted(body, options, doFetch, host, logger);
    }
    return {
      ...result,
      mediaKey,
      fileSha256: final.fileSha256,
      fileEncSha256: final.fileEncSha256,
      fileLength: final.fileLength,
    };
  }

  async #postEncrypted(
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: MediaUploadOptions,
    doFetch: typeof fetch,
    host: string,
    logger: Logger,
    contentLength?: number,
  ): Promise<Pick<MediaUploadResult, 'url' | 'directPath' | 'handle'>> {
    const path = getUploadPath(options.mediaType);
    const tokenParam = options.uploadToken ? `&token=${encodeURIComponent(options.uploadToken)}` : '';
    const url = `${host}/${path}?auth=${encodeURIComponent(options.uploadToken ?? '')}${tokenParam}`;

    const retry = new RetryManager(options.retry ?? { maxAttempts: 3, baseMs: 1_000, maxMs: 10_000, factor: 2, jitter: 0.5 }, logger);
    const timeoutMs = options.timeoutMs ?? 30_000;
    const isStream = typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
    const totalBytes = contentLength ?? (isStream ? undefined : (body as Uint8Array).byteLength);

    return retry.execute(async (attempt) => {
      if (attempt > 0) logger.warn({ attempt }, 'media upload retrying');
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'user-agent': options.userAgent ?? DEFAULT_HTTP_USER_AGENT,
          origin: 'https://web.whatsapp.com',
          ...(totalBytes !== undefined ? { 'content-length': String(totalBytes) } : {}),
        },
        body: isStream ? (body as ReadableStream<Uint8Array>) : Buffer.from(body as Uint8Array),
        duplex: 'half',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new MediaError(`media upload failed: HTTP ${response.status}`, {
          data: { statusCode: response.status, body: text.slice(0, 200) },
        });
      }
      if (totalBytes !== undefined) {
        options.onProgress?.({ phase: 'uploading', bytesProcessed: totalBytes, totalBytes });
      }
      const json = (await response.json().catch(() => ({}))) as { url?: string; direct_path?: string; handle?: string };
      if (!json.url && !json.direct_path) {
        throw new MediaError('media upload: server returned no url/direct_path', { data: { json } });
      }
      return { url: json.url ?? '', directPath: json.direct_path, handle: json.handle };
    });
  }
}

function supportsStreamingBody(): boolean {
  return typeof ReadableStream !== 'undefined';
}

function webStreamFromParts(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let idx = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[idx];
      if (part === undefined) {
        controller.close();
        return;
      }
      idx += 1;
      controller.enqueue(part);
    },
  });
}
