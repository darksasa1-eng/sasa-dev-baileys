/**
 * @sasadevofc/baileys — modern WhatsApp Web protocol library.
 *
 * Main entry points: {@link createClient} / {@link SasaClient},
 * {@link useAuthState} + storage adapters for persistence, and the
 * `SessionManager` for multi-account deployments.
 */

// ---- client ----
export { createClient, SasaClient, sessionIdFor, type SasaClientOptions } from './Client/client';
export { SessionManager, type SessionManagerOptions, type SessionSnapshot } from './Client/multi-session';

// ---- config & constants ----
export * from './Defaults/defaults';
export { makeSocketConfig } from './Defaults/defaults';
export type { SocketConfig, UserFacingSocketConfig, WABrowserDescription } from './Types/config';

// ---- auth & storage ----
export * from './Auth/index';
export * from './Store/index';
export { MemoryStorageAdapter } from './Store/adapters/memory';
export { JsonStorageAdapter } from './Store/adapters/json';
export { FileStorageAdapter, type FileStorageAdapterOptions } from './Store/adapters/file';
export { SqliteStorageAdapter, type SqliteLikeDatabase } from './Store/adapters/sqlite';
export { MongoStorageAdapter, type MongoLikeCollection } from './Store/adapters/mongo';
export { RedisStorageAdapter, type RedisLikeClient } from './Store/adapters/redis';

// ---- protocol primitives ----
export * as WABinary from './WABinary/index';
export { encodeBinaryNode } from './WABinary/encode';
export { decodeBinaryNode, decompressingIfRequired } from './WABinary/decode';
export { getBinaryNodeChild, getBinaryNodeChildren, binaryNodeToString } from './WABinary/generic-utils';
export type { BinaryNode } from './WABinary/types';
export * as Signal from './Signal/index';
export * as Curve from './Signal/curve';

// ---- types ----
export * from './Types/events';
export * from './Types/messages';
export type { WAVersion } from './Types/versions';
export { parseWAVersion, formatWAVersion, compareWAVersion } from './Types/versions';

// ---- errors ----
export * from './Defaults/errors';
export { DisconnectReason, isFatalDisconnect, isRetryableDisconnect } from './Defaults/disconnect-reason';

// ---- infra ----
export { createLogger, ConsoleLogger, NOOP_LOGGER, type Logger, type LogLevel } from './Defaults/logger';
export { TypedEventEmitter } from './Defaults/events';
export { AsyncEventQueue } from './Defaults/queue';
export { Mutex, KeyedMutex } from './Defaults/mutex';
export * as Utils from './Utils/generics';
export { BufferJSON } from './Utils/buffer-json';
export * as Jids from './Utils/jids';

// ---- messaging ----
export { MessageBuilder } from './Messaging/builder';
export {
  serializeMessage,
  deserializeMessage,
  serializeMessageKey,
  deserializeMessageKey,
} from './Messaging/serializer';
export { MessageInterceptor } from './Messaging/interceptors';
export { InMemoryStore, type InMemoryStoreOptions, type StoreSnapshot } from './Messaging/store';

// ---- media ----
export * from './Media/index';

// ---- plugins & hooks ----
export { HookSystem, Hook } from './Plugins/hooks';
export { MiddlewareEngine, type MiddlewareFn } from './Plugins/middleware';
export { WebSocketMiddleware } from './Plugins/websocket-middleware';

// ---- socket subsystems ----
export { WASocket, type WASocketEvents } from './Socket/wa-socket';
export { WebSocketTransport } from './Socket/transport';
export { NoiseHandshake, NoiseTrafficCipher, NOISE_WA_HEADER, NOISE_PROTOCOL_NAME } from './Socket/noise';
export { FrameDecoder, encodeFrame, WS_FRAME_MAX_SIZE } from './Socket/frame-codec';
export { KeepAliveManager } from './Socket/keep-alive';
export { ConnectionHealthMonitor, type HealthReport, type HealthStatus } from './Socket/health-monitor';
export { ConnectionRecoveryManager } from './Socket/recovery-manager';
export { RetryManager, type RetryPolicy } from './Socket/retry-manager';
export { TokenBucketRateLimiter } from './Socket/rate-limiter';
export { RequestQueue } from './Socket/request-queue';
export { fetchLatestWaWebVersion, fetchLatestWaWebVersionCached, clearVersionCache } from './Socket/version-fetcher';

// ---- observability ----
export { ConnectionMetrics, type MetricsSnapshot, type ConnectionStatistics } from './Observability/metrics';
export { MemoryMonitor, type MemorySample } from './Observability/memory-monitor';
export { PacketLogger, type PacketRecord } from './Observability/packet-logger';
export { PacketDebugger } from './Observability/packet-debugger';
