# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-08-01

A ground-up modernization of the library — real protocol core, production
connection layer, pluggable storage, full observability and a strict
toolchain. **Breaking**: the public API of `1.0.0-beta.1` is replaced; see
[MIGRATION.md](./MIGRATION.md).

### Highlights

- **Real WABinary codec** replacing the JSON placeholder: full single/double
  byte token dictionaries, packed nibble/hex values, AD/Fb/Interop/legacy JID
  forms, zero-copy chunked encoder, and a DoS-guarded decoder (caps on nesting
  depth 256, inflated size 64 MiB, string bytes 16 MiB, list size) with strict
  and lenient (sentinel) modes.
- **Bit-accurate Noise transport** — `XX_25519_AESGCM_SHA256` handshake with
  WA payload schedule, 3-byte length-prefixed frame codec, traffic ciphers
  with 64-bit nonces; malformed frames never crash the socket.
- **Signal layer on native `node:crypto`** — X25519 via DER key prefixes,
  Ed25519 signatures, HKDF-SHA256 (RFC 5869 vectors), AES-256-GCM/CBC; X3DH
  session building, double ratchet with forward secrecy + out-of-order keys,
  sender-key group encryption, serializable session/sender-key records,
  transaction-capable key store, pluggable `Curve.setCurveBackend` for
  full-VXEdDSA addons.
- **Storage & auth** — `StorageAdapter` contract with `Memory`, `JSON`,
  `File`, `SQLite`, `MongoDB`, `Redis` implementations (drivers injected by
  DI, zero new runtime deps); `useAuthState` with an ordered single-writer
  queue (older snapshots can never overwrite newer ones); credential
  validation; BufferJSON codec; session export/import envelopes with
  HMAC-SHA256 integrity.
- **Connection layer** — `WASocket` with full lifecycle (handshake → preauth →
  open), iq request/response correlation, rotating QR refs via
  `connection.update.qr`, signed pair-code requests (`XXXX-XXXX`), keep-alive,
  stream-error mapping to `DisconnectReason`, message-id dedupe, graceful
  close/destroy.
- **Resilience managers** — Connection Recovery Manager (fatal/retryable
  classification, backoff + jitter), Health Monitor (latency windows,
  reconnect accounting), Memory Monitor, Retry Manager, Token-Bucket Rate
  Limiter, priority Request Queue, Async Event Queue with backpressure caps,
  Mutex/KeyedMutex, Auto WA Version Fetch with TTL cache.
- **Messaging** — schema-driven Advanced Message Serializer (WA proto field
  numbers; text/extended-text/media/protocol/reaction/ephemeral/view-once,
  recursive context info), Advanced Message Builder (quotes, mentions,
  forwarding flags), Message Interceptor pipeline (transform/veto),
  bounded In-Memory Store (chats/contacts/messages).
- **Media** — spec encryption (HKDF 112-byte expansion, AES-256-CBC,
  truncated-10 HMAC-SHA256) with SHA256 file hashes; buffered upload with
  retries or true single-pass streaming from disk (constant RAM); streaming
  download with incremental MAC verification; LRU Media Cache with hit-rate
  stats; media-type utilities.
- **Plugin pipeline** — Hook System (named taps, plugin-scoped unregister,
  error isolation), onion-model Middleware Engine with double-next guard,
  WebSocket Middleware for raw-frame transforms, Message Interceptors.
- **Observability** — Connection Metrics (counters/gauges/latency ring
  buffers, Connection Statistics API), redacting Packet Logger, Packet
  Debugger for step-through inspection.
- **DX** — strict TypeScript 5.9 (zero errors), ESLint 9 flat config +
  Prettier (zero warnings), dual CJS/ESM bundles with rolled-up `.d.ts`,
  `exports` map with per-format types, `sideEffects: false`, single runtime
  dependency (`ws`).
- **Testing** — 114 tests / 10 suites: codec, crypto primitives, Signal
  sessions + sender keys, media crypto + stream parity, storage adapters,
  auth + QR/pair flows, every manager, plugin pipeline, and an end-to-end
  client↔mock-server Noise integration (QR, open, iq correlation, malformed
  frame resilience).

### Changed

- Node.js requirement raised to `>= 20`.
- Package exports now point at bundled `dist/index.{js,mjs}` with
  `dist/index.d.{ts,mts}`.
- `example:basic` / `example:toolkit` replace the old bot example.

### Removed

- Bot framework surface: `CommandFramework`, command/plugin base classes and
  the command-bot example. This package is a **library**; application logic
  belongs in your repo.
- Dependencies `protobufjs`, `pino`, `uuid` (replaced by an in-tree wire
  codec, a pino-compatible logger API, and `node:crypto` ids).
- Legacy stub modules (`src/auth`, `src/connection`, `src/message`,
  `src/plugins`, `src/types`, `src/utils`, `src/client.ts`, `src/config.ts`).

## [1.0.0-beta.1] - 2025

Initial public scaffold: placeholder auth/socket/transport/handshake/pairing
modules over a JSON transport, message handler stub and a command framework.

[1.2.0]: https://github.com/darksasa1-eng/sasa-dev-baileys/compare/v1.0.0-beta.1...v1.2.0
