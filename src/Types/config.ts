import type { AuthenticationState } from '../Auth/types';
import type { Logger } from '../Defaults/logger';
import type { StorageAdapter } from '../Store/adapter';
import type { WAVersion } from './versions';

/** Signature: (name, version, platform) — appears as the linked device label */
export type WABrowserDescription = readonly [string, string, string];

export interface RetryPolicyConfig {
  maxAttempts?: number;
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  jitter?: number;
}

export interface RateLimiterConfig {
  /** sustained tokens per second */
  ratePerSecond?: number;
  /** bucket capacity (burst) */
  burst?: number;
}

export interface FeatureFlags {
  /** Connection health monitor (heartbeats + latency windows) */
  healthMonitor?: boolean;
  /** Process memory monitor with threshold events */
  memoryMonitor?: boolean;
  /** Collect connection + performance metrics */
  metrics?: boolean;
  /** Automatic reconnect with exponential backoff */
  autoReconnect?: boolean;
  /** Automatic keep-alive pings */
  keepAlive?: boolean;
}

export interface SocketConfig {
  /** WhatsApp multi-device websocket endpoint */
  waWebSocketUrl: string;
  /** WhatsApp web client version; 'auto' fetches live */
  version: WAVersion | 'auto';
  /** Device identity shown in WhatsApp → Linked Devices */
  browser: WABrowserDescription;

  /** Auth state OR a storage adapter (adapter is wrapped into state) */
  auth: AuthenticationState | StorageAdapter;
  /** Namespace for adapter-backed auth (multi-session) */
  sessionNamespace?: string;

  logger: Logger;

  connectTimeoutMs: number;
  /** Timeout for individual iq/query round-trips */
  defaultQueryTimeoutMs: number;
  keepAliveIntervalMs: number;
  /** Expected interval of incoming traffic before a socket is judged stale */
  expectedTrafficIntervalMs: number;
  /** How long to wait for pairing/QR success */
  qrTimeoutMs: number;
  /** QR ref rotate pacing hints for UIs */
  qrRefreshMs: number;

  /** Reconnect policy */
  reconnect: Required<RetryPolicyConfig> & { maxAttempts: number };
  /** Outbound stanza rate limit */
  rateLimiter: RateLimiterConfig;
  /** Max concurrent in-flight requests */
  maxConcurrentRequests: number;

  /** Media upload host */
  mediaUploadUrl: string;
  /** User agent for HTTP requests (media + version fetch) */
  httpUserAgent: string;

  features: Required<FeatureFlags>;

  /** Query interval for the version auto-fetcher cache */
  versionCacheMs: number;
}

export type UserFacingSocketConfig = Partial<Omit<SocketConfig, 'auth' | 'logger' | 'reconnect' | 'features'>> & {
  auth: AuthenticationState | StorageAdapter;
  logger?: Logger | Parameters<typeof import('../Defaults/logger').createLogger>[0];
  reconnect?: RetryPolicyConfig & { maxAttempts?: number };
  features?: FeatureFlags;
};
