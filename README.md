# @sasadevofc/baileys

**A modern, production-ready WhatsApp Web protocol library for Node.js.**

Multi-device protocol support, fully typed, with a hardened binary codec, native
Signal-protocol crypto, pluggable storage, an observable connection layer, and a
plugin/middleware pipeline — in a single runtime dependency (`ws`).

```
npm install @sasadevofc/baileys
```

Node.js **≥ 20** · TypeScript **5.9 strict** · dual **CJS + ESM** builds · Apache-2.0

> **Scope note.** This package is a **library**, not a bot framework. It ships no
> commands, no menus and no bot plugins. You bring your application logic; the
> library provides the protocol, resilience and observability foundations.

---

## Table of contents

- [Why this library](#why-this-library)
- [Quick start (QR login)](#quick-start-qr-login)
- [Pair-code login](#pair-code-login)
- [Storage adapters](#storage-adapters)
- [Configuration](#configuration)
- [Events](#events)
- [Manager subsystems](#manager-subsystems)
- [Plugin pipeline: hooks, middleware, interceptors](#plugin-pipeline-hooks-middleware-interceptors)
- [Media: upload, download, cache](#media-upload-download-cache)
- [Multi-session](#multi-session)
- [Session export / import](#session-export--import)
- [Errors](#errors)
- [Observability & debugging](#observability--debugging)
- [Examples](#examples)
- [Testing](#testing)
- [Security & hardening notes](#security--hardening-notes)
- [Compatibility & honest limits](#compatibility--honest-limits)
- [License](#license)

---

## Why this library

| Area        | What you get                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Protocol    | Real WABinary codec (full token dictionaries, packed values, AD/Fb/Interop JIDs), WA Noise XX handshake (`XX_25519_AESGCM_SHA256`), framed, encrypted transport                                        |
| Crypto      | Signal layer in pure `node:crypto`: X25519, Ed25519, HKDF-SHA256, AES-256-GCM/CBC, X3DH session building, double ratchet with forward secrecy and out-of-order keys, sender-key group encryption       |
| Resilience  | Connection Recovery Manager (fatal vs. retryable classification, exponential backoff + jitter), keep-alive, request queue with priorities, token-bucket rate limiter, retry manager, message-id dedupe |
| Performance | Zero-copy chunked encoder, single-pass streaming media cipher/decipher, backpressure-capped queues, bounded stores/caches, write-coalesced auth persistence                                            |
| Security    | DoS-guarded decoder (depth/size/list caps, inflate limits), streaming MAC verification for media, integrity-checked session envelopes, no prototype-pollution paths, redacting packet logger           |
| DX          | Strict-typescript public API, complete IntelliSense docs, typed event map, honest typed errors with stable machine codes                                                                               |
| Storage     | `Memory`, `JSON`, `File`, `SQLite`, `MongoDB`, `Redis` adapters behind one `StorageAdapter` contract                                                                                                   |
| Testing     | 114 tests including an end-to-end client↔server Noise/integration harness                                                                                                                              |

## Quick start (QR login)

```ts
import { createClient, FileStorageAdapter } from '@sasadevofc/baileys';

const client = createClient({
  auth: new FileStorageAdapter('./auth_state'), // auto-persisted
  version: 'auto', // track the live WA Web protocol version
});

client.events.on('connection.update', ({ qr, connection }) => {
  if (qr) renderQrSomehow(qr); // refs rotate ~every 20s; every ref is re-emitted
  if (connection === 'open') console.log('connected as', client.auth?.creds.me?.id);
});

client.events.on('messages.upsert', ({ messages }) => {
  for (const msg of messages) console.log('incoming:', msg.key.remoteJid, msg.message);
});

await client.connect();

// later — send end-to-end encrypted when a session exists for the peer
await client.sendMessage('41789996011@s.whatsapp.net', 'hello from the library');
```

Auth persistence is automatic: pass any `StorageAdapter` as `auth` and credential
updates are written (ordered + coalesced) on every `creds.update`.

## Pair-code login

The Advanced Pair Code API links a phone by code instead of camera:

```ts
await client.connect();
const code = await client.requestPairingCode('15551234567'); // 'XXXX-XXXX'
console.log('enter this code on the phone:', code);
```

Phone numbers are validated/normalized (`normalizePhoneNumber`), codes come back
formatted (`XXXX-XXXX`); request signing uses the pairing ephemeral key. Low-level
helpers (`normalizePairCode`, `formatPairCode`, `isValidPairCode`,
`encodePairingRequest`, `decodePairingResponse`) are exported for custom flows.

## Storage adapters

One `StorageAdapter` contract — swap persistence without touching client code:

| Adapter                | Constructor                                  | Backend          | Notes                                             |
| ---------------------- | -------------------------------------------- | ---------------- | ------------------------------------------------- |
| `MemoryStorageAdapter` | `new MemoryStorageAdapter()`                 | —                | zero-dependency, ephemeral (tests/dev)            |
| `JsonStorageAdapter`   | `new JsonStorageAdapter('auth.json')`        | single JSON file | atomic rename writes, lazy flush (250 ms)         |
| `FileStorageAdapter`   | `new FileStorageAdapter('./dir')`            | one file per key | atomic writes, safe key encoding                  |
| `SqliteStorageAdapter` | `new SqliteStorageAdapter(db)`               | SQLite           | dependency-injected `better-sqlite3`-style handle |
| `MongoStorageAdapter`  | `new MongoStorageAdapter(collection)`        | MongoDB          | dependency-injected driver collection             |
| `RedisStorageAdapter`  | `new RedisStorageAdapter(redis, { prefix })` | Redis            | dependency-injected `ioredis`-style client        |

SQLite/Mongo/Redis take their driver instance by **dependency injection** — the
library keeps one runtime dependency and _your_ app pins the driver versions:

```ts
import Database from 'better-sqlite3';
import { SqliteStorageAdapter, useAuthState } from '@sasadevofc/baileys';

const db = new Database('auth.db');
const auth = new SqliteStorageAdapter(db);

// either hand the adapter straight to the client…
const client = createClient({ auth });

// …or drive persistence yourself
const { state, saveCreds, clear } = await useAuthState(auth, { namespace: 'acc-1:' });
```

`useAuthState` guarantees a **single ordered writer**: a slow backend can never
persist an older creds snapshot over a newer one.

## Configuration

`makeSocketConfig` applies defaults; everything is overridable:

```ts
createClient({
  auth, // AuthenticationState | StorageAdapter
  version: 'auto', // or [2, 3000, 1023401288]
  browser: ['sasa-dev', 'Chrome', '1.2.0'],
  logger, // pino-compatible; createLogger() built in
  waWebSocketUrl, // custom edge / proxy
  sessionNamespace: 'acc-1', // adapter key namespace (multi-session)
  connectTimeoutMs: 20_000,
  defaultQueryTimeoutMs: 60_000,
  keepAliveIntervalMs: 25_000,
  qrTimeoutMs: 60_000,

  reconnect: { maxAttempts: 8, baseMs: 250, factor: 2, maxMs: 30_000, jitter: 0.3 },
  rateLimiter: { ratePerSecond: 20, burst: 40 },
  maxConcurrentRequests: 8,
  features: {
    keepAlive: true,
    autoReconnect: true,
    healthMonitor: true,
    metrics: true,
    memoryMonitor: false,
  },

  // bounded in-memory store (default on; `store: false` to disable)
  storeOptions: { maxChats: 5_000, maxMessagesPerChat: 500 },
});
```

`version: 'auto'` uses the **Auto Version Fetch** subsystem
(`fetchLatestWaWebVersion`, cached via `fetchLatestWaWebVersionCached`,
`clearVersionCache`) with graceful fallback to `DEFAULT_WA_VERSION`.

## Events

Fully typed `BaileysEventMap` on `client.events` (a `TypedEventEmitter` with
`on/once/off/waitFor`):

| Event                                                           | Payload                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `connection.update`                                             | `{ connection?, qr?, pairingCode?, lastDisconnect?, isNewLogin?, … }` |
| `creds.update`                                                  | `Partial<AuthenticationCreds>`                                        |
| `messages.upsert`                                               | `{ messages: WAMessage[], type: 'notify' \| 'append' }`               |
| `messages.update` / `messages.reaction`                         | updates / reactions                                                   |
| `message-receipt.update`                                        | delivery/read receipts                                                |
| `chats.upsert` / `chats.update` / `chats.delete`                | chat models                                                           |
| `contacts.upsert` / `contacts.update`                           | contact profiles                                                      |
| `groups.upsert` / `groups.update` / `group-participants.update` | group metadata                                                        |
| `presence.update`                                               | presence by chat                                                      |
| `messaging-history.set`                                         | history-sync payload                                                  |
| `error`                                                         | `BaileysError`                                                        |

## Manager subsystems

Every resilience/ops concern is a standalone, separately testable manager —
all constructed and wired by `SasaClient`, all exported for direct use:

| Export                            | Role                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ConnectionRecoveryManager`       | classifies disconnects (fatal vs retryable), schedules reconnects with backoff + jitter, exposes `on('trigger')` |
| `ConnectionHealthMonitor`         | heartbeats, latency windows → `health()` report + `healthStatus()`                                               |
| `MemoryMonitor`                   | RSS/heap sampling with threshold events                                                                          |
| `ConnectionMetrics`               | counters, gauges, latency ring buffers → `metrics.snapshot()` (Connection Statistics API)                        |
| `RetryManager`                    | generic async retry with typed policies                                                                          |
| `TokenBucketRateLimiter`          | smooth send rate limiting                                                                                        |
| `RequestQueue`                    | priority queue over outgoing requests with bounded concurrency                                                   |
| `KeepAliveManager`                | protocol pings with stale-socket detection                                                                       |
| `PacketLogger` / `PacketDebugger` | redacting packet log + step-through inspector                                                                    |
| `AsyncEventQueue`                 | backpressure-capped sequential job runner                                                                        |
| `Mutex` / `KeyedMutex`            | correctness under concurrent key access                                                                          |

```ts
const report = client.health(); // { status, rttMs, reconnects, … }
const stats = client.metrics.snapshot(); // counters/gauges/latencies
```

## Plugin pipeline: hooks, middleware, interceptors

Extension points are library primitives (not a bot framework):

```ts
// Hook System — named tap points with plugin-scoped unregister
client.hooks.get('message.send').tap('my-plugin', ({ jid, message }) => {
  audit.log(jid, message.key.id);
});
client.hooks.unregisterPlugin('my-plugin');

// Middleware Engine — onion-model async compose with double-next guard
client.middleware.use(async ({ state }, next) => {
  console.time('pipeline');
  await next();
  console.timeEnd('pipeline');
});

// Message Interceptor — transform/veto incoming + outgoing messages
client.interceptors.addOutgoing((msg) => (shouldSend(msg) ? msg : null));

// WebSocket Middleware — transform raw frames in/out of the wire
client.wsMiddleware.use(async ({ state }, next) => next());
```

## Media: upload, download, cache

WA media crypto is implemented per spec: HKDF-expanded 112-byte key material,
AES-256-CBC body, truncated 10-byte HMAC-SHA256, verified streaming.

```ts
// upload — buffered (retryable) or true-streaming from disk (constant RAM)
const up = await client.media.uploader.upload({
  data: './video.mp4', // Uint8Array | file path (streams)
  mediaType: 'video',
  uploadToken: tokenFromSocket, // obtained via iq
});

// download — one-shot (integrity-checked, cached) or chunked streaming
const file = await client.media.downloader.download({
  directPath: msg.message.videoMessage.directPath,
  mediaKey: msg.message.videoMessage.mediaKey,
  mediaType: 'video',
  fileSha256: msg.message.videoMessage.fileSha256,
});
for await (const chunk of client.media.downloader.downloadStream({/* … */})) sink.write(chunk);

// LRU media cache
client.mediaCache.set(mediaKey, plaintext);
```

`encryptMedia` / `decryptMedia` / `getMediaKeys` and type detection
(`mediaTypeFromMime`, extension maps) are exported for custom pipelines.

## Multi-session

`SessionManager` runs many accounts in one process with isolated auth
namespaces, events fan-out and snapshots:

```ts
import { SessionManager, FileStorageAdapter } from '@sasadevofc/baileys';

const manager = new SessionManager({
  baseConfig: { version: 'auto' },
  adapterFactory: (name) => new FileStorageAdapter(`./auth/${name}`),
});

const sales = await manager.start('sales');
const support = await manager.start('support');
sales.events.on('messages.upsert', handler);
await manager.stop('support');
console.log(manager.names()); // live session names
```

## Session export / import

Move an account between processes/machines with an integrity-checked envelope:

```ts
const envelope = await client.exportSessionEnvelope(); // base64 JSON + HMAC checksum
// … later, elsewhere …
await manager.importSession('ops', envelope);
```

`exportSession` / `importSession` are also exported directly; tampering is
rejected with `ERR_SESSION_INTEGRITY`.

## Errors

One hierarchy, stable machine codes, Boom-compatible `output.statusCode` on
stream errors:

```
BaileysError (code, data, cause)
 ├─ ConnectionClosedError   ERR_CONNECTION_CLOSED
 ├─ ConnectionLostError     ERR_CONNECTION_LOST  (+statusCode)
 ├─ TimedOutError           ERR_TIMED_OUT
 ├─ HandshakeError          ERR_HANDSHAKE_FAILED
 ├─ DecryptionError         ERR_DECRYPTION_FAILED
 ├─ ProtocolError           ERR_PROTOCOL
 ├─ MediaError              ERR_MEDIA
 ├─ StorageError            ERR_STORAGE
 ├─ RateLimitedError        ERR_RATE_LIMITED
 ├─ BackpressureError       ERR_BACKPRESSURE
 └─ StreamError             ERR_STREAM  (output.statusCode = DisconnectReason)
```

`DisconnectReason` is exported with `isFatalDisconnect` /
`isRetryableDisconnect` helpers — the same classification the Recovery Manager
uses (e.g. `401 loggedOut` is fatal; `408/515` retry).

## Observability & debugging

```ts
// redacting packet logger (auth bytes never hit disk)
client.attachPacketLogger((line) => fs.appendFileSync('packets.log', line + '\n'), {
  redactAttrs: ['phash', 'enc'],
});

const snapshot = client.metrics.snapshot(); // Connection Statistics API
const mem = client.memoryMonitor?.sample(); // { rss, heapUsed, … }
```

Or inspect live traffic standalone: `new PacketDebugger(socket)` taps frames in
both directions with per-node summaries.

## Examples

- [`examples/basic-usage.ts`](examples/basic-usage.ts) — persistent auth, QR + pair code, hooks, health/metrics, graceful shutdown. `npm run example:basic`
- [`examples/protocol-toolkit.ts`](examples/protocol-toolkit.ts) — offline tour: codec, serializer, Signal session, storage, pipeline, queue, metrics. `npm run example:toolkit`

## Testing

```
npm test            # 114 tests, incl. a full client↔mock-server Noise integration
npm run coverage    # v8 coverage report
npm run typecheck   # strict TS, zero errors
npm run lint        # ESLint 9 flat config, zero warnings
npm run build       # dual CJS+ESM bundles + d.ts rolls via tsup
```

## Security & hardening notes

- **Malformed-packet resilience** — the decoder enforces caps on nesting depth
  (256), inflated size (64 MiB), string bytes (16 MiB) and list size; strict
  mode rejects unknown tokens, lenient mode substitutes diagnostic sentinels.
  Undecodable/corrupt frames are dropped with metrics, never crash the socket.
- **No listener/race leaks** — single-owner transports, `dispose()` paths on
  every manager, single-flight `connect()`, message-id dedupe, ordered writer
  queue for creds.
- **Memory safety** — bounded stores, LRU media cache, capped pending-request
  maps, streaming media paths with constant RAM.
- **Session integrity** — export envelopes carry an HMAC-SHA256 checksum keyed
  from the noise key; auth writes are serialized and ordered.

## Compatibility & honest limits

- Wire-compatible WABinary codec, Noise XX handshake, frame format, media
  encryption, QR/pair-code flows and Signal double ratchet.
- **Signature note**: `calculateSignature`/`verifySignature` use Ed25519
  (self-consistent with keys from `generateSigningKeyPair`). WhatsApp's
  libsignal uses VXEdDSA signatures over Curve25519 — for byte-level
  compatibility with server-side signature verification, inject a
  libsignal-compatible backend via `Curve.setCurveBackend`
  (`Curve.resetCurveBackend` restores the native one).
- The high-level "app state" history-sync engine is represented by types +
  event surface; decryption of history-sync blobs is not yet included.
- Group sender keys are implemented (`libsignal` sender-key flow); the
  automatic sender-key distribution exchange is not yet wired into
  `sendMessage` for groups.
- `.github/workflows` changes require repository permissions the automation
  token lacks — a ready CI workflow template lives at
  [`docs/ci.yml.example`](docs/ci.yml.example).

## License

Apache-2.0 © SASA DEV. Protocol token dictionaries are derived from the
MIT-licensed [Baileys](https://github.com/WhiskeySockets/Baileys) project —
see [`NOTICE`](NOTICE).
