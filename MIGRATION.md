# Migration guide: 1.0.0-beta.1 → 1.2.0

Version 1.2.0 is a ground-up rebuild of the library: real protocol core, real
crypto, a production connection layer, pluggable storage and full
observability. The beta's public API is **replaced wholesale** — this guide
maps every old surface to its new equivalent.

## At a glance

| Concern      | 1.0.0-beta.1                               | 1.2.0                                                                            |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------------- |
| Client       | `new BaileysClient(config)`                | `createClient(options)` / `new SasaClient(options)`                              |
| Auth storage | `AuthStore` / `IAuthStore` (JSON deps dir) | `StorageAdapter`s + `createClient({ auth: adapter })` or `useAuthState(adapter)` |
| QR           | `client.requestQR()`                       | `connection.update` → `update.qr` (rotates), `client.waitForQR()`                |
| Pair code    | `client.requestPairingCode(phone)`         | `client.requestPairingCode(phone)` (validated, signed, formatted)                |
| Reconnect    | `utils/retry.ts` ad-hoc                    | `ConnectionRecoveryManager` + `reconnect` policy config                          |
| Plugins      | `CommandFramework` / bot commands          | **removed** — use hooks/middleware/interceptors (library primitives)             |
| Logging      | `pino` dependency                          | `createLogger()` / any pino-compatible `Logger`                                  |
| IDs          | `uuid` dependency                          | `generateMessageID()` (`node:crypto`)                                            |
| Protobufs    | `protobufjs` runtime                       | schema-driven in-tree wire codec (`serializeMessage`)                            |
| Node         | `>=18`                                     | `>=20`                                                                           |
| Build        | `tsc` single CJS                           | tsup dual **CJS + ESM** with rolled-up typings                                   |

## Step-by-step

### 1. Upgrade the runtime

1.2.0 requires **Node.js 20 or newer** (native fetch, WebStreams, modern
`node:crypto` X25519/Ed25519 support). Upgrade your deployment images and
`engines` fields accordingly.

### 2. Replace the client construction

**Before**

```ts
import { BaileysClient } from '@sasadevofc/baileys';
const client = new BaileysClient({ version: [2, 2413, 1], printQRInTerminal: true });
await client.connect();
```

**After**

```ts
import { createClient, FileStorageAdapter } from '@sasadevofc/baileys';
const client = createClient({
  auth: new FileStorageAdapter('./auth_state'), // persistence is built in
  version: 'auto',
});
client.events.on('connection.update', ({ qr }) => qr && renderQr(qr));
await client.connect();
```

Notable changes:

- `printQRInTerminal` is gone. QR payloads arrive on
  `events.on('connection.update')` as they rotate (~20 s TTL); render them
  with the terminal/image library of your choice, or use
  `await client.waitForQR()`.
- Auth persistence is no longer a separate manual step — pass a
  `StorageAdapter` as `auth` and creds are written automatically (ordered,
  coalesced, integrity-safe).

### 3. Migrate auth persistence

**Before**: `AuthStore` kept JSON files under a hard-coded folder and had to be
reconciled with `AuthManager` manually.

**After**:

```ts
import {
  FileStorageAdapter,
  JsonStorageAdapter,
  SqliteStorageAdapter,
  MongoStorageAdapter,
  RedisStorageAdapter,
} from '@sasadevofc/baileys';

createClient({ auth: new JsonStorageAdapter('auth.json') });
createClient({ auth: new FileStorageAdapter('./auth_state') });
createClient({ auth: new SqliteStorageAdapter(db) }); // better-sqlite3 handle (DI)
createClient({ auth: new MongoStorageAdapter(collection) }); // driver collection (DI)
createClient({ auth: new RedisStorageAdapter(redis, { prefix: 'wa:' }) });
```

Move existing sessions between machines with
`client.exportSessionEnvelope()` → `manager.importSession(name, envelope)`
(tamper-evident; wrong/injected data is rejected with
`ERR_SESSION_INTEGRITY`).

### 4. Rewire events

**Before**

```ts
client.on('connection.update', cb); // loose strings, untyped payloads
client.on('qr', cb);
client.on('message', cb);
```

**After** — one typed emitter with the full `BaileysEventMap`:

```ts
client.events.on('connection.update', (u) => {
  /* u.qr / u.connection / u.lastDisconnect */
});
client.events.on('creds.update', (patch) => {
  /* already persisted when using an adapter */
});
client.events.on('messages.upsert', ({ messages, type }) => {
  /* … */
});
client.events.on('message-receipt.update', (receipts) => {
  /* … */
});
```

The `'qr'` and `'message'` shorthand events were removed — `connection.update`
and `messages.upsert` carry that data with types.

### 5. Sending and media

**Before**

```ts
await client.sendMessage(jid, 'hi');
await client.sendMedia(jid, 'image', buffer);
const buf = await client.downloadMedia(message);
```

**After**

```ts
await client.sendMessage(jid, 'hi');                       // text
await client.sendMessage(jid, { imageMessage: {…} });      // rich content
const up = await client.media.uploader.upload({ data: buf, mediaType: 'image', uploadToken });
const dl = await client.media.downloader.download({ directPath, mediaKey, mediaType: 'image' });
```

Media now uses the real WA media encryption (HKDF + AES-CBC + truncated HMAC)
with streaming paths that keep RAM flat for large files, plus an LRU
`client.mediaCache`.

### 6. Replace bot commands with library extension points

`CommandFramework`, the command example and the bot plugin classes were
**removed by design** — this package does not ship bot features. The
capabilities you hooked them into remain as library primitives:

| Old                        | New                                                    |
| -------------------------- | ------------------------------------------------------ |
| `client.plugins.use(fn)`   | `client.middleware.use(fn)` (onion-model, typed state) |
| message handler intercept  | `client.interceptors.addIncoming/addOutgoing(fn)`      |
| ad-hoc lifecycle listeners | `client.hooks.get('message.send').tap(plugin, fn)`     |
| raw socket hooks           | `client.wsMiddleware.use(fn)`                          |

### 7. Reliability configuration

Ad-hoc `utils/retry.ts` logic is superseded by policy-driven managers:

```ts
createClient({
  reconnect: { maxAttempts: 8, baseMs: 250, factor: 2, maxMs: 30_000, jitter: 0.3 },
  rateLimiter: { ratePerSecond: 20, burst: 40 },
  features: { autoReconnect: true, keepAlive: true, healthMonitor: true, metrics: true },
});
```

Disconnect causes are classified with the exported `DisconnectReason` enum and
`isFatalDisconnect` / `isRetryableDisconnect`, surfaced through
`StreamError.output.statusCode` (Boom-compatible), so existing
`statusCode === DisconnectReason.loggedOut` checks keep working.

### 8. Logging, errors, utilities

- `pino` is no longer a dependency. `createLogger({ level })` covers the built
  in structured logger; a real pino instance can be injected directly (the
  `Logger` interface is pino-compatible).
- Errors are typed under `BaileysError` with stable `code`s
  (`ERR_CONNECTION_LOST`, `ERR_STREAM`, `ERR_PROTOCOL`, …) — switch string
  matching to `instanceof` / `err.code` checks.
- `uuid` → `generateMessageID()` / `node:crypto.randomUUID()`.

## Removal checklist

- [ ] `CommandFramework` usage → hooks/middleware/interceptors
- [ ] `client.on('qr'|'message')` → `client.events.on('connection.update'|'messages.upsert')`
- [ ] `AuthStore`/`AuthManager` → `StorageAdapter` + `createClient({ auth })`
- [ ] `printQRInTerminal` → render `connection.update.qr`
- [ ] `utils/retry` → `reconnect` policy + managers
- [ ] direct `pino` import → `createLogger` (or inject pino as `Logger`)
- [ ] Node 18 images → Node 20+

## Getting help

Open a [GitHub issue](https://github.com/darksasa1-eng/sasa-dev-baileys/issues)
with the `migration` label — include your old and new call sites and we will
help map them.
