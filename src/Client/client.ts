import { makeSocketConfig } from '../Defaults/defaults';
import { DisconnectReason } from '../Defaults/disconnect-reason';
import { BaileysError, StreamError, isBaileysError } from '../Defaults/errors';
import { TypedEventEmitter } from '../Defaults/events';
import type { Logger } from '../Defaults/logger';
import { HookSystem } from '../Plugins/hooks';
import { MiddlewareEngine } from '../Plugins/middleware';
import { WebSocketMiddleware } from '../Plugins/websocket-middleware';
import { MessageInterceptor } from '../Messaging/interceptors';
import { MessageBuilder, type BuildOptions } from '../Messaging/builder';
import { serializeMessage } from '../Messaging/serializer';
import { InMemoryStore, type InMemoryStoreOptions } from '../Messaging/store';
import { MediaCache } from '../Media/cache';
import { MediaDownloader } from '../Media/downloader';
import { MediaUploader } from '../Media/uploader';
import { ConnectionMetrics, type MetricsSnapshot } from '../Observability/metrics';
import { MemoryMonitor } from '../Observability/memory-monitor';
import { PacketLogger, type PacketRecord } from '../Observability/packet-logger';
import { ConnectionHealthMonitor, type HealthReport, type HealthStatus } from '../Socket/health-monitor';
import { ConnectionRecoveryManager } from '../Socket/recovery-manager';
import { TokenBucketRateLimiter } from '../Socket/rate-limiter';
import { RequestQueue } from '../Socket/request-queue';
import { RetryManager } from '../Socket/retry-manager';
import { WASocket } from '../Socket/wa-socket';
import { fetchLatestWaWebVersionCached } from '../Socket/version-fetcher';
import type { AuthenticationState, SignalDataSet } from '../Auth/types';
import { collectSignalDataSet, exportSession } from '../Auth/session-codec';
import { validateCreds } from '../Auth/creds-utils';
import { useAuthState, type UseAuthStateResult } from '../Store/auth-state';
import type { StorageAdapter } from '../Store/adapter';
import { jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from '../Utils/jids';
import { generateMessageID } from '../Utils/generics';
import type { WAMessage, MessageContent } from '../Types/messages';
import type { SocketConfig, UserFacingSocketConfig } from '../Types/config';
import type { WAVersion } from '../Types/versions';
import type { BaileysEventMap, ConnectionUpdate } from '../Types/events';
import type { BinaryNode } from '../WABinary/types';
import { encryptWhisperMessage } from '../Signal/libsignal/session-cipher';
import { deserializeSession, serializeSession, type SessionRecord } from '../Signal/libsignal/record';

export interface SasaClientOptions extends UserFacingSocketConfig {
  /** Attach a bounded in-memory store for chats/contacts/messages (default on) */
  store?: InMemoryStore | false;
  storeOptions?: InMemoryStoreOptions;
}

function isStorageAdapter(value: unknown): value is StorageAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StorageAdapter).get === 'function' &&
    typeof (value as StorageAdapter).set === 'function' &&
    typeof (value as StorageAdapter).keys === 'function'
  );
}

/**
 * The public client — creates and orchestrates every subsystem:
 * socket, signal layer, recovery, health, metrics, monitors and pipelines.
 *
 * ```ts
 * const client = createClient({ auth: adapter });
 * client.events.on('connection.update', console.log);
 * await client.connect();
 * ```
 */
export class SasaClient {
  readonly config: SocketConfig;
  readonly logger: Logger;
  readonly events = new TypedEventEmitter<BaileysEventMap>();

  // --- plugin & pipeline surfaces -------------------------------------------
  readonly hooks = new HookSystem();
  readonly middleware = new MiddlewareEngine<{ client: SasaClient; node: BinaryNode; messages: WAMessage[] }>();
  readonly wsMiddleware = new WebSocketMiddleware();
  readonly interceptors = new MessageInterceptor();

  // --- subsystem managers ----------------------------------------------------
  readonly retryManager: RetryManager;
  readonly rateLimiter: TokenBucketRateLimiter;
  readonly requestQueue: RequestQueue;
  readonly recoveryManager: ConnectionRecoveryManager;
  readonly healthMonitor: ConnectionHealthMonitor;
  readonly memoryMonitor: MemoryMonitor | undefined;
  readonly mediaCache: MediaCache;
  readonly media: { uploader: MediaUploader; downloader: MediaDownloader };
  readonly store: InMemoryStore | undefined;

  #authState: AuthenticationState | undefined;
  #authPersistence: UseAuthStateResult | undefined;
  #socket: WASocket | undefined;
  #version: WAVersion | undefined;
  #packetLogger: PacketLogger | undefined;
  #metricsInstance: ConnectionMetrics | undefined;
  #lastUpdate: ConnectionUpdate = {};
  #manualClose = false;
  #connectPromise: Promise<void> | undefined;
  #disposed = false;

  constructor(options: SasaClientOptions) {
    this.config = makeSocketConfig(options);
    this.logger = this.config.logger;
    this.retryManager = new RetryManager(this.config.reconnect, this.logger);
    this.rateLimiter = new TokenBucketRateLimiter({
      ratePerSecond: this.config.rateLimiter.ratePerSecond ?? 20,
      burst: this.config.rateLimiter.burst,
    });
    this.requestQueue = new RequestQueue({
      concurrency: this.config.maxConcurrentRequests,
      rateLimiter: this.rateLimiter,
    });
    this.recoveryManager = new ConnectionRecoveryManager(this.config.reconnect);
    this.healthMonitor = new ConnectionHealthMonitor();
    if (this.config.features.memoryMonitor) this.memoryMonitor = new MemoryMonitor();
    this.mediaCache = new MediaCache();
    this.media = {
      uploader: new MediaUploader(this.logger),
      downloader: new MediaDownloader(this.logger),
    };
    this.store = options.store === false ? undefined : (options.store ?? new InMemoryStore(options.storeOptions));

    // recovery → reconnect trigger
    this.recoveryManager.on('trigger', () => {
      if (this.#disposed) return;
      this.healthMonitor.noteReconnect();
      this.#metrics()?.increment('connection:reconnects');
      void this.connect().catch((err: unknown) => {
        this.logger.warn({ err: String(err) }, 'reconnect attempt failed');
      });
    });
    this.recoveryManager.on('exhausted', ({ reason }) => {
      this.events.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: new BaileysError(`recovery exhausted: ${reason}`, { code: 'ERR_RECOVERY' }),
          date: new Date(),
        },
      });
    });
    this.recoveryManager.on('scheduled', ({ attempt, delayMs }) => {
      this.logger.info({ attempt, delayMs }, 'reconnect scheduled');
    });

    this.healthMonitor.on('report', (report) => this.events.emit('health.report', report));
    this.healthMonitor.on('statusChange', ({ from, to }) => {
      this.logger.info({ from, to }, 'connection health changed');
      if (to === 'down' && this.#socket?.isOpen && this.config.features.autoReconnect) {
        this.#socket.close(new StreamError(DisconnectReason.connectionLost, { reason: 'health monitor: down' }));
      }
    });

    this.#metrics()?.increment('client:created');
  }

  // ---------------------------------------------------------------- internals

  #metrics(): ConnectionMetrics | undefined {
    if (!this.config.features.metrics) return undefined;
    if (!this.#metricsInstance) this.#metricsInstance = new ConnectionMetrics();
    return this.#metricsInstance;
  }

  /** Connection + performance metrics API */
  get metrics(): {
    enabled: boolean;
    snapshot: () => MetricsSnapshot | undefined;
    raw: () => ConnectionMetrics | undefined;
  } {
    return {
      enabled: this.config.features.metrics,
      snapshot: () => this.#metrics()?.snapshot(),
      raw: () => this.#metricsInstance,
    };
  }

  /** Attach a packet logger sink (see {@link PacketLogger}) */
  attachPacketLogger(sink: (line: string, record: PacketRecord) => void, options?: { redactAttrs?: string[] }): void {
    this.#packetLogger = new PacketLogger({ sink, redactAttrs: options?.redactAttrs });
  }

  detachPacketLogger(): void {
    this.#packetLogger = undefined;
  }

  // -------------------------------------------------------------------- auth

  async #resolveAuth(): Promise<AuthenticationState> {
    if (this.#authState) return this.#authState;
    const auth = this.config.auth;
    if (isStorageAdapter(auth)) {
      this.#authPersistence = await useAuthState(auth, {
        namespace: this.config.sessionNamespace,
        logger: this.logger,
      });
      this.#authState = this.#authPersistence.state;
    } else {
      this.#authState = auth;
    }
    validateCreds(this.#authState.creds);
    return this.#authState;
  }

  // ------------------------------------------------------------------ socket

  async #spawnSocket(): Promise<WASocket> {
    const auth = await this.#resolveAuth();
    this.#version =
      this.config.version === 'auto'
        ? await fetchLatestWaWebVersionCached({ cacheMs: this.config.versionCacheMs, logger: this.logger })
        : this.config.version;

    const cfg: SocketConfig = { ...this.config, auth };
    const socket = new WASocket(cfg, { metrics: this.#metrics() });
    socket.setMiddleware(this.wsMiddleware);
    socket.setRateLimiter(this.rateLimiter);
    socket.setKeepAliveEnabled(this.config.features.keepAlive);
    this.#wireSocket(socket, auth);
    return socket;
  }

  #wireSocket(socket: WASocket, auth: AuthenticationState): void {
    socket.on('connection.update', (update) => {
      if (update.connection === 'open') {
        this.healthMonitor.noteConnected();
        this.recoveryManager.reset();
        this.#lastUpdate = { connection: 'open' };
      } else if (update.connection) {
        this.#lastUpdate = { ...this.#lastUpdate, connection: update.connection };
      }
      if (update.qr) this.#lastUpdate = { ...this.#lastUpdate, qr: update.qr };
      if (update.pairingCode) this.#lastUpdate = { ...this.#lastUpdate, pairingCode: update.pairingCode };
      this.events.emit('connection.update', { ...this.#lastUpdate });
    });

    socket.on('transportClosed', ({ code, reason }) => {
      this.healthMonitor.noteDisconnected();
      const err = new StreamError(code, { reason });
      const isManual = this.#manualClose || code === 1000;
      this.#lastUpdate = { connection: 'close', lastDisconnect: { error: err, date: new Date() } };
      this.events.emit('connection.update', this.#lastUpdate);
      if (!isManual && this.config.features.autoReconnect && !this.#disposed) {
        this.recoveryManager.handleDisconnect(err);
      }
    });

    socket.on('error', (err) => {
      if (isBaileysError(err)) this.events.emit('error', err);
      else this.events.emit('error', new BaileysError(String(err), { code: 'ERR_INTERNAL', cause: err }));
    });

    socket.on('creds.update', (patch) => {
      Object.assign(auth.creds, patch);
      void this.#authPersistence?.saveCreds();
      this.events.emit('creds.update', patch);
    });

    socket.on('node', (node) => void this.#routeNode(node));
    socket.on('nodeOut', (node) => this.#packetLogger?.log('out', node));
  }

  // -------------------------------------------------------------- node router

  async #routeNode(node: BinaryNode): Promise<void> {
    this.#packetLogger?.log('in', node);
    await this.hooks.get('node.in').run(node);

    switch (node.tag) {
      case 'message':
        await this.#handleMessageNode(node);
        break;
      case 'receipt':
        this.#handleReceiptNode(node);
        break;
      case 'notification':
        this.#handleNotificationNode(node);
        break;
      case 'call':
        this.#handleCallNode(node);
        break;
      case 'presence':
        this.events.emit('presence.update', {
          id: String(node.attrs.from ?? ''),
          presences: {
            [String(node.attrs.from ?? '')]: { lastKnownPresence: String(node.attrs.type ?? 'available') },
          },
        });
        break;
      default:
        break;
    }
    await this.hooks.get('node.out').run(node);
  }

  async #handleMessageNode(node: BinaryNode): Promise<void> {
    const from = String(node.attrs.from ?? '');
    const id = String(node.attrs.id ?? '');
    const participant = node.attrs.participant ? String(node.attrs.participant) : undefined;
    const timestamp = Number(node.attrs.t ?? 0) || undefined;

    let content: MessageContent | undefined;
    let encryptedTypes: string[] | undefined;
    const encNodes = Array.isArray(node.content) ? node.content.filter((c) => c.tag === 'enc') : [];
    if (encNodes.length === 0 && typeof node.content === 'string') {
      content = { conversation: node.content };
    } else if (encNodes.length > 0) {
      encryptedTypes = encNodes.map((e) => e.attrs.type ?? 'unknown');
    }

    const message: WAMessage = {
      key: { remoteJid: from, id, fromMe: false, participant },
      message: content,
      messageTimestamp: timestamp,
      ...(node.content instanceof Uint8Array ? { rawContent: node.content } : {}),
      ...(encryptedTypes ? { encryptedTypes } : {}),
    };

    const ctx = await this.interceptors.applyIncoming({ messages: [message], upsertType: 'notify' });
    if (ctx && ctx.messages.length > 0) {
      this.store?.addMessages(from, ctx.messages);
      await this.middleware.run({ client: this, node, messages: ctx.messages });
      this.events.emit('messages.upsert', { messages: ctx.messages, type: 'notify' });
    }
  }

  #handleReceiptNode(node: BinaryNode): void {
    const users = (Array.isArray(node.content) ? node.content : []).filter((c) => c.tag === 'user');
    const list =
      users.length > 0
        ? users.map((child) => ({
            key: { remoteJid: String(node.attrs.from ?? ''), id: String(child.attrs.id ?? node.attrs.id ?? '') },
            receipt: {
              userJid: child.attrs.jid ? String(child.attrs.jid) : undefined,
              status: String(node.attrs.type ?? 'delivered'),
              t: Number(node.attrs.t ?? 0),
            },
          }))
        : [
            {
              key: { remoteJid: String(node.attrs.from ?? ''), id: String(node.attrs.id ?? '') },
              receipt: { status: String(node.attrs.type ?? 'delivered'), t: Number(node.attrs.t ?? 0) },
            },
          ];
    this.events.emit('message-receipt.update', list);
  }

  #handleNotificationNode(node: BinaryNode): void {
    const type = String(node.attrs.type ?? '');
    const from = String(node.attrs.from ?? '');
    if (!type.startsWith('w:gp2') && type !== 'participant') return;
    const actionMap: Record<string, 'add' | 'remove' | 'promote' | 'demote' | 'modify'> = {
      'w:gp2:participants': 'modify',
      add: 'add',
      remove: 'remove',
      promote: 'promote',
      demote: 'demote',
    };
    for (const child of Array.isArray(node.content) ? node.content : []) {
      const actions = Array.isArray(child.content) ? child.content : [child];
      for (const participantNode of actions) {
        if (participantNode.tag !== 'participant') continue;
        this.events.emit('group-participants.update', {
          id: from,
          participants: participantNode.attrs.jid ? [String(participantNode.attrs.jid)] : [],
          action:
            actionMap[child.tag] ??
            actionMap[participantNode.attrs.type ?? ''] ??
            (type === 'participant' ? 'modify' : 'add'),
          author: node.attrs.participant ? String(node.attrs.participant) : undefined,
        });
      }
    }
  }

  #handleCallNode(node: BinaryNode): void {
    const events = (Array.isArray(node.content) ? node.content : []).map((child) => ({
      chatId: String(node.attrs.from ?? ''),
      from: String(node.attrs.from ?? ''),
      id: String(node.attrs.id ?? ''),
      date: new Date(Number(node.attrs.t ?? Date.now() / 1000) * 1000),
      offline: node.attrs.offline === '1',
      status: String(child.tag),
      isVideo: child.attrs.media === 'video',
      isGroup: child.attrs.group === '1',
    }));
    if (events.length > 0) this.events.emit('call', events);
  }

  // -------------------------------------------------------------- public API

  /** Connect the socket. Concurrent calls share a single attempt. */
  connect(): Promise<void> {
    if (this.#connectPromise) return this.#connectPromise;
    this.#manualClose = false;
    const boot = async (): Promise<void> => {
      try {
        if (this.config.features.healthMonitor) this.healthMonitor.start();
        this.memoryMonitor?.start();
        const socket = await this.#spawnSocket();
        this.#socket?.destroy();
        this.#socket = socket;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        await socket.connect(this.#version!);
      } finally {
        this.#connectPromise = undefined;
      }
    };
    this.#connectPromise = boot();
    return this.#connectPromise;
  }

  /** Disconnect gracefully (no auto-reconnect) */
  async disconnect(): Promise<void> {
    this.#manualClose = true;
    this.recoveryManager.cancel();
    this.#socket?.close();
    await this.#authPersistence?.saveCreds().catch(() => undefined);
  }

  /** Full shutdown — stop timers, drain queues, persist creds, free listeners */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#manualClose = true;
    this.recoveryManager.dispose();
    this.healthMonitor.dispose();
    this.memoryMonitor?.dispose();
    this.rateLimiter.dispose();
    this.requestQueue.dispose();
    this.#socket?.destroy();
    if (this.#authPersistence) await this.#authPersistence.disconnect().catch(() => undefined);
    this.wsMiddleware.clear();
    this.middleware.clear();
    this.hooks.clear();
    this.events.removeAllListeners();
  }

  get isConnected(): boolean {
    return this.#socket?.isOpen ?? false;
  }

  /** Escape hatch for advanced flows — prefer the client API */
  get socket(): WASocket | undefined {
    return this.#socket;
  }

  /** Current WA web protocol version in use */
  get version(): WAVersion | undefined {
    return this.#version;
  }

  get auth(): AuthenticationState | undefined {
    return this.#authState;
  }

  /** Current connection health report */
  health(): HealthReport {
    return this.healthMonitor.report();
  }

  healthStatus(): HealthStatus {
    return this.healthMonitor.status;
  }

  /** Wait for the next QR ref (refs rotate ~every 20s until scanned) */
  async waitForQR(timeoutMs = 60_000): Promise<string> {
    const update = await this.events.waitFor('connection.update', {
      filter: (u) => typeof u.qr === 'string',
      timeoutMs,
    });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return update.qr!;
  }

  /** Advanced Pair Code API — request a `XXXX-XXXX` code for phone linking */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const socket = this.#requireSocket();
    return socket.requestPairingCode(phoneNumber);
  }

  #requireSocket(): WASocket {
    if (!this.#socket) {
      throw new BaileysError('socket not connected — call connect() first', { code: 'ERR_NOT_CONNECTED' });
    }
    return this.#socket;
  }

  /**
   * Send a message through the full pipeline:
   * builder → interceptors → hooks → (signal encryption when a session
   * exists) → WS middleware → noise channel → wire.
   */
  async sendMessage(
    jid: string,
    content: string | MessageContent,
    opts: BuildOptions & { encrypt?: boolean } = {},
  ): Promise<WAMessage> {
    const socket = this.#requireSocket();
    const to = jid.includes('@') ? jid : `${jid}@${S_WHATSAPP_NET}`;
    const builder = new MessageBuilder(to);

    let message: WAMessage;
    if (typeof content === 'string') {
      message = builder.text(content, opts);
    } else {
      message = {
        key: { remoteJid: to, id: opts.id ?? generateMessageID(), fromMe: true },
        message: content,
        messageTimestamp: Math.floor(Date.now() / 1000),
      };
    }

    const processed = await this.interceptors.applyOutgoing(message);
    if (!processed) return message; // vetoed by interceptor
    await this.hooks.get('message.send').run({ jid: to, message: processed, client: this });

    // signal layer: encrypt when a session with the peer exists
    let children: BinaryNode[] | undefined;
    if (opts.encrypt !== false && processed.message) {
      const payload = serializeMessage(processed.message);
      const { encrypted } = await this.#encryptForJid(to, payload);
      if (encrypted) {
        children = [{ tag: 'enc', attrs: { v: '2', type: encrypted.type }, content: encrypted.serialized }];
      }
    }

    const node: BinaryNode = {
      tag: 'message',
      attrs: { to, id: processed.key.id ?? '', type: typeof content === 'string' ? 'text' : 'media' },
      content: children ?? (processed.message?.conversation !== undefined ? processed.message.conversation : undefined),
    };
    await socket.sendNode(node);
    return processed;
  }

  /** Encrypt a payload for a JID if a signal session exists */
  async #encryptForJid(
    jid: string,
    plaintext: Uint8Array,
  ): Promise<{ sessionId: string; encrypted: { type: 'msg' | 'pkmsg'; serialized: Uint8Array } | null }> {
    const auth = await this.#resolveAuth();
    const sessionId = sessionIdFor(jid);
    return auth.keys.transaction(async () => {
      const map = await auth.keys.get('session', [sessionId]);
      const recordBytes = map[sessionId];
      if (!recordBytes) return { sessionId, encrypted: null };
      const record: SessionRecord = deserializeSession(recordBytes);
      const encrypted = encryptWhisperMessage(record.state, plaintext);
      await auth.keys.set({ session: { [sessionId]: serializeSession(record) } });
      return { sessionId, encrypted };
    }, sessionId);
  }

  /** Low-level: install/replace the signal session for a peer JID */
  async installSignalSession(jid: string, record: SessionRecord): Promise<void> {
    const auth = await this.#resolveAuth();
    await auth.keys.set({ session: { [sessionIdFor(jid)]: serializeSession(record) } });
  }

  /**
   * Session Export — snapshot creds + signal keys into a portable,
   * checksum-protected string (needs a StorageAdapter-backed client).
   */
  async exportSessionEnvelope(): Promise<string> {
    const auth = await this.#resolveAuth();
    const adapter = isStorageAdapter(this.config.auth) ? this.config.auth : undefined;
    if (!adapter) {
      throw new BaileysError('session export requires a StorageAdapter-backed client', { code: 'ERR_UNSUPPORTED' });
    }
    const namespace = this.config.sessionNamespace ?? '';
    const keys = await collectSignalDataSet(
      (p) => adapter.keys(p),
      (k) => adapter.get(k),
      namespace,
    );
    return exportSession(auth.creds, keys as SignalDataSet);
  }
}

/** Stable signal session identifier for a peer JID */
export function sessionIdFor(jid: string): string {
  const decoded = jidDecode(jidNormalizedUser(jid));
  const user = decoded?.user ?? jid;
  const device = decoded?.device ?? 0;
  return `${user}-${device}.0`;
}

/** The library entry point: create a client instance */
export function createClient(options: SasaClientOptions): SasaClient {
  return new SasaClient(options);
}
