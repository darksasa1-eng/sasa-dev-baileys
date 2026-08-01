import { getBinaryNodeChild, getBinaryNodeChildString } from '../WABinary/generic-utils';
import { decodeBinaryNode } from '../WABinary/decode';
import { encodeBinaryNode } from '../WABinary/encode';
import type { BinaryNode } from '../WABinary/types';
import type { AuthenticationState } from '../Auth/types';
import { buildQrPayload } from '../Auth/qr';
import { normalizePhoneNumber } from '../Auth/pair-code';
import { DisconnectReason } from '../Defaults/disconnect-reason';
import {
  BaileysError,
  ConnectionClosedError,
  HandshakeError,
  ProtocolError,
  StreamError,
  TimedOutError,
} from '../Defaults/errors';
import { TypedEventEmitter } from '../Defaults/events';
import type { Logger } from '../Defaults/logger';
import { KeepAliveManager } from './keep-alive';
import type { WebSocketMiddleware } from '../Plugins/websocket-middleware';
import { FrameDecoder, encodeFrame } from './frame-codec';
import {
  encodeHandshakeClientFinish,
  encodeHandshakeClientHello,
  makeUserAgent,
  parseHandshakePayload,
} from './handshake-payload';
import { NoiseHandshake, type NoiseTrafficCipher, NOISE_WA_HEADER } from './noise';
import { WebSocketTransport } from './transport';
import type { ConnectionMetrics } from '../Observability/metrics';
import { type TokenBucketRateLimiter } from './rate-limiter';
import type { SocketConfig } from '../Types/config';
import type { WAConnectionState } from '../Types/events';
import type { WAVersion } from '../Types/versions';

export interface WASocketEvents {
  /** Inbound stanza after decryption + WS middleware */
  node: BinaryNode;
  /** Outbound stanza as actually sent (packet logger taps here too) */
  nodeOut: BinaryNode;
  'connection.update': {
    connection?: WAConnectionState;
    qr?: string;
    pairingCode?: string;
    lastDisconnectCode?: number;
  };
  'creds.update': Partial<AuthenticationState['creds']>;
  error: Error;
  /** Hex/other inventory about transport closes */
  transportClosed: { code: number; reason: string };
}

let tagCounter = 0;
function makeTag(): string {
  tagCounter = (tagCounter + 1) % 0xffffffff;
  const timePart = Date.now().toString(36);
  const countPart = tagCounter.toString(36).padStart(4, '0');
  return `${timePart}-${countPart}`;
}

interface PendingRequest {
  resolve: (node: BinaryNode) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  sentAt: number;
}

/**
 * WhatsApp multi-device socket.
 *
 * Lifecycle: transport open → WA magic header → Noise XX handshake →
 * encrypted frame mode → pre-auth `<iq pair>`/QR refs → `<success>` →
 * keep-alive + stanza routing.
 */
export class WASocket extends TypedEventEmitter<WASocketEvents> {
  readonly config: SocketConfig;
  readonly #logger: Logger;
  readonly #metrics: ConnectionMetrics | undefined;

  #transport: WebSocketTransport | undefined;
  #frameDecoder = new FrameDecoder();
  #noise: NoiseHandshake | undefined;
  #sendCipher: NoiseTrafficCipher | undefined;
  #recvCipher: NoiseTrafficCipher | undefined;
  #keepAlive: KeepAliveManager | undefined;

  #state: 'idle' | 'connecting' | 'handshake' | 'preauth' | 'open' | 'closed' = 'idle';
  #pending = new Map<string, PendingRequest>();
  #seenMessageIds = new Set<string>();
  #middleware: WebSocketMiddleware | undefined;
  #rateLimiter: TokenBucketRateLimiter | undefined;
  #keepAliveEnabled = true;

  constructor(config: SocketConfig, deps: { metrics?: ConnectionMetrics } = {}) {
    super();
    this.config = config;
    // Precondition: the client layer must resolve adapters into a full state.
    const auth = config.auth as AuthenticationState;
    if (!auth?.creds?.noiseKey || !auth?.keys) {
      throw new BaileysError('WASocket requires a resolved AuthenticationState (creds + keys)', {
        code: 'ERR_AUTH_STATE',
      });
    }
    this.#logger = config.logger.child({ module: 'wa-socket' });
    this.#metrics = deps.metrics;
  }

  get connectionState(): 'idle' | 'connecting' | 'handshake' | 'preauth' | 'open' | 'closed' {
    return this.#state;
  }

  get isOpen(): boolean {
    return this.#state === 'open';
  }

  /** Wire the client-level outgoing/incoming stanza middleware pipeline */
  setMiddleware(pipeline: WebSocketMiddleware): void {
    this.#middleware = pipeline;
  }

  setRateLimiter(limiter: TokenBucketRateLimiter): void {
    this.#rateLimiter = limiter;
  }

  setKeepAliveEnabled(enabled: boolean): void {
    this.#keepAliveEnabled = enabled;
  }

  // ------------------------------------------------------------------ connect

  async connect(version: WAVersion): Promise<void> {
    if (this.#state === 'connecting' || this.#state === 'handshake' || this.#state === 'open') {
      return;
    }
    this.#state = 'connecting';
    this.emit('connection.update', { connection: 'connecting' });
    this.#metrics?.increment('connection:attempts');
    this.#metrics?.gauge('socket:state', 1);

    const creds = this.config.auth as AuthenticationState;
    const haveNoise = creds.creds.noiseKey;

    const transport = new WebSocketTransport(this.#logger.child({ module: 'transport' }));
    this.#transport = transport;
    this.#frameDecoder.reset();
    this.#wireTransport(transport);

    try {
      await transport.connect(this.config.waWebSocketUrl, {
        origin: 'https://web.whatsapp.com',
        timeoutMs: this.config.connectTimeoutMs,
      });
    } catch (err) {
      this.#state = 'closed';
      transport.dispose();
      this.emit('connection.update', { connection: 'close' });
      throw err instanceof Error ? err : new ConnectionClosedError(String(err));
    }

    // 1) transport magic + handshake msg1
    this.#state = 'handshake';
    this.#noise = new NoiseHandshake({
      role: 'initiator',
      staticKeyPair: haveNoise,
      hooks: {
        verifyPeerStaticKey: () => {
          // TODO(wire-compat): verify WA edge cert chain against server static.
          return true;
        },
      },
    });
    const clientHello = encodeHandshakeClientHello({
      userAgent: makeUserAgent(this.config.browser, version),
      webInfo: { webSubPlatform: 0 },
    });
    const frame1 = this.#noise.generateHandshakeMessage(clientHello);
    this.#sendRaw(concatAll(NOISE_WA_HEADER, encodeFrame(frame1)));
    // → inbound messages continue in #onTransportMessage (msg2 → msg3 → done)
  }

  // --------------------------------------------- transport wiring & lifecycle

  #wireTransport(transport: WebSocketTransport): void {
    transport.on('message', (data) => this.#onTransportMessage(data));
    transport.on('close', (info) => this.#onTransportClosed(info.code, info.reason));
    transport.on('error', (err) => this.emit('error', err));
  }

  #sendRaw(bytes: Uint8Array): void {
    this.#metrics?.increment('bytes:sent', bytes.byteLength);
    this.#transport?.send(bytes);
  }

  async #onTransportMessage(data: Uint8Array): Promise<void> {
    this.#metrics?.increment('bytes:received', data.byteLength);
    this.#keepAlive?.noteExternalActivity();

    try {
      if (!this.#sendCipher) {
        await this.#handleHandshakeBytes(data);
        return;
      }
      const frames = this.#frameDecoder.feed(data);
      for (const frame of frames) {
        this.#onEncryptedFrame(frame);
      }
    } catch (err) {
      this.#handleFatalFrameError(err);
    }
  }

  async #handleHandshakeBytes(data: Uint8Array): Promise<void> {
    if (!this.#noise) throw new HandshakeError('handshake state lost');
    if (this.#state === 'handshake') {
      // first server message: NOISE_WA_ROUTE? — server sends its header too;
      // Baileys-style: skip 4-byte noise header if present
      let payload = data;
      if (data.byteLength > 4 && data[0] === 87 && data[1] === 65) {
        payload = data.subarray(4); // "WA" + 2 bytes (peer routes header first frame)
      }
      // noise msg2 may itself be frame-wrapped; strip a 3-byte length if it fits exactly
      if (payload.byteLength > 3) {
        const declared = ((payload[0] ?? 0) << 16) | ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
        if (declared === payload.byteLength - 3) payload = payload.subarray(3);
      }
      const serverHello = this.#noise.receiveHandshakeMessage(payload);
      const parsed = parseHandshakePayload(serverHello);
      this.#logger.debug({ hasPayload: Boolean(parsed.serverHello?.payload) }, 'handshake msg2 received');

      const clientFinish = encodeHandshakeClientFinish({ payload: new Uint8Array(0) });
      const msg3 = this.#noise.generateHandshakeMessage(clientFinish);
      this.#sendRaw(encodeFrame(msg3));

      const { send, receive } = this.#noise.split();
      this.#sendCipher = send;
      this.#recvCipher = receive;
      this.#noise = undefined;
      this.#state = 'preauth';
      this.#logger.info('noise handshake complete');
      this.#requestPreAuth();
      return;
    }
    throw new HandshakeError(`unexpected handshake bytes in state ${this.#state}`);
  }

  #onEncryptedFrame(frame: Uint8Array): void {
    if (!this.#recvCipher) return;
    const plaintext = this.#recvCipher.decrypt(frame);
    let node: BinaryNode;
    try {
      node = decodeBinaryNode(plaintext, { strict: false });
    } catch (err) {
      this.#logger.warn({ err: String(err) }, 'dropping undecodable stanza');
      this.#metrics?.increment('frames:decodeErrors');
      return;
    }
    void this.#routeStanza(node);
  }

  #handleFatalFrameError(err: unknown): void {
    const error = err instanceof Error ? err : new ProtocolError(String(err));
    this.#logger.error({ err: String(error) }, 'fatal frame error, closing');
    this.emit('error', error);
    this.close(new ProtocolError('frame processing failed', { cause: error }));
  }

  // --------------------------------------------------------------- stanza i/o

  async #routeStanza(node: BinaryNode): Promise<void> {
    this.#metrics?.increment('messages:received');

    // stream errors → typed teardown
    if (node.tag === 'stream:error') {
      const code = Number(node.attrs.code ?? 500);
      const err = new StreamError(Number.isFinite(code) ? code : 500, node.attrs as Record<string, string>);
      this.#metrics?.increment('connection:streamErrors');
      this.emit('error', err);
      this.close(err);
      return;
    }
    if (node.tag === 'failure') {
      const err = new StreamError(DisconnectReason.loggedOut, { reason: 'failure stanza received' });
      this.emit('error', err);
      this.close(err);
      return;
    }
    if (node.tag === 'success') {
      this.#onAuthSuccess(node);
      return;
    }

    // QR refs are pushed pre-success via <iq type="result"> with pair-device refs.
    // Must run before iq correlation: the ref stanza also resolves the pending
    // preauth query (which returns early), so extracting after would drop the QR.
    if (this.#state === 'preauth') {
      const maybeRef = this.#extractQrRef(node);
      if (maybeRef) this.emit('connection.update', { qr: maybeRef });
    }

    // request/response correlation
    const id = node.attrs.id;
    if (id && this.#pending.has(id)) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#metrics?.timing('socket:roundtrip', Date.now() - pending.sentAt);
        const errNode = getBinaryNodeChild(node, 'error');
        if (node.attrs.type === 'error' || errNode) {
          pending.reject(
            new BaileysError(`iq error [${errNode?.attrs.code ?? node.attrs.code ?? 'unknown'}]`, {
              code: 'ERR_IQ',
              data: { node },
            }),
          );
        } else {
          pending.resolve(node);
        }
        return;
      }
    }

    // dedupe retransmissions by message id
    if (node.tag === 'message' && id) {
      if (this.#seenMessageIds.has(id)) return;
      if (this.#seenMessageIds.size > 50_000) this.#seenMessageIds.clear();
      this.#seenMessageIds.add(id);
    }

    const processed = this.#middleware ? await this.#middleware.applyIncoming(node) : node;
    if (processed) this.emit('node', processed);
  }

  #extractQrRef(node: BinaryNode): string | undefined {
    // <iq><pair-device><ref>#</ref></pair-device></iq> — the QR lifecycle stanza.
    // Node *content* at a binary-tag position always decodes to Uint8Array,
    // so accept both string and binary (real servers send the ref as bytes).
    const pairDevice = getBinaryNodeChild(node, 'pair-device');
    const refText = getBinaryNodeChildString(pairDevice ?? node, 'ref');
    if (!refText) return undefined;
    const creds = (this.config.auth as AuthenticationState).creds;
    return buildQrPayload(
      refText,
      creds.pairingEphemeralKeyPair.publicKey,
      Buffer.from(creds.registrationId?.toString() ?? '0'),
    );
  }

  #requestPreAuth(): void {
    const creds = (this.config.auth as AuthenticationState).creds;
    if (creds.registered && creds.me) {
      // returning session: send passive login; success arrives next
      void this.sendNode({
        tag: 'iq',
        attrs: { type: 'get', xmlns: 'passive', to: 's.whatsapp.net' },
        content: [{ tag: 'passive', attrs: {} }],
      }).catch((err) => this.emit('error', err as Error));
      return;
    }
    // fresh login: request QR ref
    this.sendNode({
      tag: 'iq',
      attrs: { to: '@s.whatsapp.net'.replace('@', ''), type: 'get', xmlns: 'md', id: makeTag() },
      content: [{ tag: 'pair-device', attrs: {} }],
    }).catch((err) => this.emit('error', err as Error));
  }

  #onAuthSuccess(node: BinaryNode): void {
    this.#state = 'open';
    this.#metrics?.increment('connection:success');
    this.#metrics?.gauge('socket:state', 2);
    this.emit('connection.update', { connection: 'open' });
    this.#startKeepAlive();
    // surface useful creds deltas without assuming a fixed success schema
    const device = getBinaryNodeChild(node, 'device');
    if (device?.attrs.jid) {
      this.emit('creds.update', { me: { id: String(device.attrs.jid) } });
    }
    this.emit('node', node);
  }

  #startKeepAlive(): void {
    if (!this.#keepAliveEnabled) return;
    this.#keepAlive?.stop();
    this.#keepAlive = new KeepAliveManager(
      { intervalMs: this.config.keepAliveIntervalMs, maxMissedIntervals: 2 },
      {
        ping: async () => {
          const t0 = Date.now();
          await this.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'w:p', to: 's.whatsapp.net', id: makeTag() } });
          this.#metrics?.timing('socket:roundtrip', Date.now() - t0);
        },
        onStale: () => {
          this.#logger.warn('keep-alive stale — forcing close for recovery');
          this.close(new StreamError(DisconnectReason.connectionLost, { reason: 'keepalive stale' }));
        },
      },
    );
    this.#keepAlive.start();
  }

  // --------------------------------------------------------------- public API

  /**
   * Send a stanza with middleware applied (no response tracking).
   * Serialized through the rate limiter; metered in metrics.
   */
  async sendNode(node: BinaryNode): Promise<void> {
    if (!this.#sendCipher || !this.#transport || this.#state === 'closed') {
      throw new ConnectionClosedError('cannot send stanza: socket not ready');
    }
    if (this.#rateLimiter) await this.#rateLimiter.acquire(1, 10_000);
    const processed = this.#middleware ? await this.#middleware.applyOutgoing(node) : node;
    if (processed === null) return; // vetoed by middleware
    const encoded = encodeBinaryNode(processed);
    const frame = encodeFrame(this.#sendCipher.encrypt(encoded));
    this.#sendRaw(frame);
    this.#metrics?.increment('messages:sent');
    this.emit('nodeOut', processed);
  }

  /**
   * Request/response round trip: attaches a fresh id, waits for the
   * matching stanza (timeout: `defaultQueryTimeoutMs`).
   */
  async query(
    node: Omit<BinaryNode, 'attrs'> & { attrs?: Record<string, string> },
    timeoutMs?: number,
  ): Promise<BinaryNode> {
    const id = node.attrs?.id ?? makeTag();
    const withId: BinaryNode = { ...node, tag: node.tag, attrs: { id, ...node.attrs } };
    const timeout = timeoutMs ?? this.config.defaultQueryTimeoutMs;
    return new Promise<BinaryNode>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new TimedOutError(`query ${id} timed out after ${timeout}ms`, { timeoutMs: timeout }));
      }, timeout);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, sentAt: Date.now() });
      this.sendNode(withId).catch((err) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err);
      });
    });
  }

  /** Request a pairing code for the given phone number (pair-code flow) */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const phone = normalizePhoneNumber(phoneNumber);
    const response = await this.query({
      tag: 'iq',
      attrs: { type: 'get', xmlns: 'md', to: 's.whatsapp.net', id: makeTag() },
      content: [
        {
          tag: 'link_code_pairing',
          attrs: { phone_number: phone.digits, jid: phone.jid, stage: 'phone_1' },
        },
      ],
    });
    // <link_code_pairing><link_code>XXXX-XXXX</link_code></...>
    const pairingNode = getBinaryNodeChild(response, 'link_code_pairing');
    const codeNode = pairingNode
      ? getBinaryNodeChild(pairingNode, 'link_code')
      : getBinaryNodeChild(response, 'link_code');
    const code = typeof codeNode?.content === 'string' ? codeNode.content : undefined;
    if (!code) throw new BaileysError('pairing code not present in server response', { code: 'ERR_PAIR_CODE' });
    this.emit('connection.update', { pairingCode: code });
    return code;
  }

  /** Graceful close with normal shutdown code */
  close(err?: Error): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#keepAlive?.stop();
    // reject outstanding queries so callers never hang
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err ?? new ConnectionClosedError('socket closed'));
      this.#pending.delete(id);
    }
    this.#seenMessageIds.clear();
    this.#transport?.close(1000, 'client closing');
    // if the server doesn't echo close within 1.5s, hard-dispose (fast shutdown)
    const transport = this.#transport;
    const hardTimer = setTimeout(() => transport?.dispose(), 1_500);
    hardTimer.unref?.();
  }

  /** Immediate teardown (recovery path) */
  destroy(): void {
    this.#state = 'closed';
    this.#keepAlive?.stop();
    this.#transport?.dispose();
    this.removeAllListeners();
  }

  #onTransportClosed(code: number, reason: string): void {
    const wasOpen = this.#state === 'open' || this.#state === 'preauth';
    this.#state = 'closed';
    this.#keepAlive?.stop();
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectionClosedError(`transport closed (${code})`));
      this.#pending.delete(id);
    }
    this.#metrics?.increment('connection:disconnects');
    this.#metrics?.gauge('socket:state', 0);
    this.emit('transportClosed', { code, reason });
    if (wasOpen) this.emit('connection.update', { connection: 'close', lastDisconnectCode: code });
  }
}

function concatAll(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
