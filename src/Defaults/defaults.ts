import { createLogger } from './logger';
import type { SocketConfig, UserFacingSocketConfig } from '../Types/config';
import type { WAVersion } from '../Types/versions';

export const WA_WEBSOCKET_URL = 'wss://web.whatsapp.com/ws/chat';
export const WA_ORIGIN = 'https://web.whatsapp.com';
export const WA_URL_BASE = 'https://web.whatsapp.com';
export const MEDIA_UPLOAD_URL = 'https://mmg.whatsapp.net';
export const MEDIA_DOWNLOAD_HOST_PATTERN = /^\w+\.cdn\.whatsapp\.net$/;

/** Last known-good WA web version (auto-fetch overrides at runtime) */
export const DEFAULT_WA_VERSION: WAVersion = [2, 3000, 1023401288] as const;

export const DEFAULT_BROWSER = ['SASA DEV', 'Chrome', '126.0.0.0'] as const;

export const DEFAULT_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Merge a partial user config over the defaults (deep for known sub-objects) */
export function makeSocketConfig(config: UserFacingSocketConfig): SocketConfig {
  const logger = config.logger ? createLogger(config.logger as never) : createLogger({ level: 'info' });
  return {
    waWebSocketUrl: config.waWebSocketUrl ?? WA_WEBSOCKET_URL,
    version: config.version ?? 'auto',
    browser: config.browser ?? DEFAULT_BROWSER,
    auth: config.auth,
    sessionNamespace: config.sessionNamespace,
    logger,
    connectTimeoutMs: config.connectTimeoutMs ?? 20_000,
    defaultQueryTimeoutMs: config.defaultQueryTimeoutMs ?? 60_000,
    keepAliveIntervalMs: config.keepAliveIntervalMs ?? 25_000,
    expectedTrafficIntervalMs: config.expectedTrafficIntervalMs ?? 180_000,
    qrTimeoutMs: config.qrTimeoutMs ?? 60_000,
    qrRefreshMs: config.qrRefreshMs ?? 20_000,
    reconnect: {
      maxAttempts: config.reconnect?.maxAttempts ?? 0, // 0 = unlimited
      baseMs: config.reconnect?.baseMs ?? 1_000,
      factor: config.reconnect?.factor ?? 2,
      maxMs: config.reconnect?.maxMs ?? 120_000,
      jitter: config.reconnect?.jitter ?? 1,
    },
    rateLimiter: {
      ratePerSecond: config.rateLimiter?.ratePerSecond ?? 20,
      burst: config.rateLimiter?.burst ?? 20,
    },
    maxConcurrentRequests: config.maxConcurrentRequests ?? 30,
    mediaUploadUrl: config.mediaUploadUrl ?? MEDIA_UPLOAD_URL,
    httpUserAgent: config.httpUserAgent ?? DEFAULT_HTTP_USER_AGENT,
    features: {
      healthMonitor: config.features?.healthMonitor ?? true,
      memoryMonitor: config.features?.memoryMonitor ?? false,
      metrics: config.features?.metrics ?? true,
      autoReconnect: config.features?.autoReconnect ?? true,
      keepAlive: config.features?.keepAlive ?? true,
    },
    versionCacheMs: config.versionCacheMs ?? 6 * 60 * 60 * 1000,
  };
}
