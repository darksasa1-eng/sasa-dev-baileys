# Contributing

Thanks for helping make `@sasadevofc/baileys` better. This document covers the
development workflow — please read it before opening a pull request.

## Scope

This repository is a **protocol library**. It deliberately does **not** ship
bot commands, menus, or chat-bot plugins. Contributions that add _library
capabilities_ (protocol coverage, resilience, performance, storage backends,
observability, DX) are welcome; contributions that add bot-framework features
are not.

## Development setup

```bash
git clone https://github.com/darksasa1-eng/sasa-dev-baileys.git
cd sasa-dev-baileys
npm ci
```

Requirements: Node.js **≥ 20** and npm ≥ 10. The full verification gate is:

```bash
npm run lint                 # ESLint 9 flat config — must be zero warnings
npm run format:check         # Prettier
npm run typecheck            # strict TS over src/
npm run typecheck:examples   # strict TS over examples/
npm test                     # vitest, 100% pass required
npm run build                # tsup dual CJS/ESM + d.ts rollups
```

All five must pass before a PR is considered. The same checks run in CI (see
`docs/ci.yml.example`).

## Project layout

```
src/
  Auth/         credentials, QR, pair codes, session envelopes
  Client/       SasaClient facade, SessionManager (multi-session)
  Defaults/     errors, DisconnectReason, logger, event emitter, queue, mutexes
  Media/        media crypto, streaming up/download, LRU cache, type utils
  Messaging/    advanced serializer + builder, interceptors, in-memory store
  Observability/ metrics, memory monitor, packet logger/debugger
  Plugins/      hook system, middleware engine, WS middleware
  Signal/       curve backend, crypto primitives, wire codec, libsignal/*
  Socket/       noise handshake, frame codec, transport, managers, WASocket
  Store/        StorageAdapter contract + memory/json/file/sqlite/mongo/redis
  Types/        config, events, messages, versions
  Utils/        buffers, generics, JID helpers, BufferJSON
  WABinary/     token dictionaries, hardened encoder/decoder, node utilities
tests/          vitest suites mirroring src/
examples/       runnable, linted and type-checked
```

## Coding standards

- **TypeScript strict mode** — `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`.
  No new `any` without a code comment justifying it (rule is `warn`; keep the
  warning count at zero by construction).
- **No non-null assertions** in new code — restructure with a guard so the
  invariant is _checked_, not assumed.
- **Errors are typed**: throw `BaileysError` subclasses with a stable
  machine-readable `code`, attach context in `data`, chain with `cause`.
- **Untrusted input is hostile**: anything decoded from the network or storage
  goes through the validating utilities — never index/parse raw buffers
  without bounds checks.
- **Resource ownership**: every timer/listener/handle must have a
  deterministic release path (`dispose()`/`close()`); no duplicate listeners
  on re-`connect()`.
- **Dependencies**: the runtime dependency budget is `ws` only. New runtime
  deps are almost always rejected — prefer `node:*` builtins or accept the
  functionality via dependency injection (see the SQLite/Mongo/Redis
  adapters).
- **Crypto**: use `node:crypto` through `src/Signal/*` primitives. Never roll
  ad-hoc crypto in feature code.

## Testing

- Every exported function and every user-visible flow needs a test
  (`tests/*.test.ts`).
- Prefer deterministic tests: inject clocks/loggers, use the in-memory
  adapters, or the mock-server harness in `tests/socket-integration.test.ts`
  for protocol flows (connect → QR/pair → open → iq correlation → teardown).
- No networked tests in CI; media up/downloader tests stub `fetch`.

## Commits & pull requests

- Small, focused commits; one completed task per commit.
- [Conventional Commits](https://www.conventionalcommits.org/) style:
  `feat(signal): …`, `fix(socket): …`, `test(media): …`, `docs: …`.
- Keep PRs reviewable: explain the _why_ in the description, link issues, and
  note protocol-fidelity risks explicitly (we optimize for correctness first,
  compatibility wherever practical).
- Never commit credentials, session envelopes, `auth_state` folders or other
  secrets — `.gitignore` covers the common ones; double-check with
  `git status` before committing.

## Reporting security issues

Do **not** open public issues for vulnerabilities. Contact the maintainers
privately via the email on the package metadata and include a minimal
reproduction. Fixes for protocol-fidelity/DoS/secret-handling bugs take
priority over all feature work.
