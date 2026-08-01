/**
 * Basic usage — the full library lifecycle.
 *
 * Demonstrates (library features only — this package intentionally ships
 * no bot commands, menus, or plugins):
 *
 *   1. persistent auth via a storage adapter (FileStorageAdapter here,
 *      swap for Json/SQLite/Mongo/Redis without touching client code)
 *   2. QR login (refs rotate ~every 20s; every new ref is emitted)
 *   3. Advanced Pair Code API (set SASA_PAIR_PHONE=15551234567 to enable)
 *   4. typed lifecycle events + graceful reconnect handling
 *   5. sending a message through the pipeline (builder → interceptors →
 *      hooks → signal encryption when a session exists → wire)
 *   6. connection health + metrics snapshots
 *   7. graceful shutdown
 *
 * Run:  npm run example:basic
 */

import {
  createClient,
  FileStorageAdapter,
  createLogger,
  StreamError,
  type SasaClient,
  type WAMessage,
} from '../src/index';

type MessageSendHook = { jid: string; message: WAMessage; client: SasaClient };

const logger = createLogger({ level: 'info', name: 'example' });

async function main(): Promise<void> {
  // 1. auth persistence — any StorageAdapter works; creds are saved
  //    automatically on every `creds.update` (ordered, coalesced writes).
  const auth = new FileStorageAdapter('./auth_state_example');

  const client = createClient({
    auth,
    logger,
    version: 'auto', // fetch the current WA Web protocol version at connect time
    browser: ['sasa-dev', 'Chrome', '1.2.0'],
  });

  // ---- a plugin-style hook: observe every outgoing message ----------------
  client.hooks.get<MessageSendHook>('message.send').tap('example-plugin', ({ jid, message }) => {
    logger.info({ jid, id: message.key.id }, 'sending message');
  });

  // ---- lifecycle events ----------------------------------------------------
  client.events.on('connection.update', (update) => {
    if (update.qr) {
      // Render this string with any QR library (e.g. `qrcode-terminal`).
      console.log(`\n[QR] scan within ~20s:\n${update.qr}\n`);
    }
    if (update.pairingCode) console.log(`[PAIR] code: ${update.pairingCode}`);
    if (update.connection === 'open') {
      console.log('[OPEN] connected as', client.auth?.creds.me?.id ?? 'unknown');
      console.log('[HEALTH]', JSON.stringify(client.health()));
      console.log('[METRICS]', JSON.stringify(client.metrics.snapshot()?.counters ?? {}));
    }
    if (update.connection === 'close') {
      const err = update.lastDisconnect?.error;
      const code = err instanceof StreamError ? err.output.statusCode : undefined;
      console.log('[CLOSE]', err?.message ?? 'unknown reason', code !== undefined ? `(code ${code})` : '');
      // auto-recovery is built-in: ConnectionRecoveryManager already
      // scheduled a reconnect with backoff+jitter for retryable codes.
    }
  });

  client.events.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      console.log(`[MSG:${type}] from=${msg.key.remoteJid} id=${msg.key.id}`);
    }
  });

  client.events.on('error', (err) => {
    logger.error({ err: err.message, code: err.code }, 'client error');
  });

  // ---- connect -------------------------------------------------------------
  await client.connect();

  // ---- optional: pair-code login instead of QR -----------------------------
  const phone = process.env.SASA_PAIR_PHONE;
  if (phone) {
    try {
      const code = await client.requestPairingCode(phone); // 'XXXX-XXXX'
      console.log(`[PAIR] enter this code on ${phone}: ${code}`);
    } catch (err) {
      logger.warn({ err: String(err) }, 'pairing code unavailable (already registered?) — falling back to QR');
    }
  }

  // ---- graceful shutdown ----------------------------------------------------
  const shutdown = async (): Promise<void> => {
    console.log('\n[SHUTDOWN] closing session…');
    await client.dispose(); // flush creds, stop keepalive/monitors/recovery, close WS
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'example crashed');
  process.exit(1);
});
