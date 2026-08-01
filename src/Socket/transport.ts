import WebSocket, { type ClientOptions } from 'ws';
import { TypedEventEmitter } from '../Defaults/events';
import { ConnectionClosedError, ConnectionLostError, HandshakeError, TimedOutError } from '../Defaults/errors';
import type { Logger } from '../Defaults/logger';
import { NOOP_LOGGER } from '../Defaults/logger';

export interface TransportEvents {
  open: void;
  /** Raw binary message from the WS layer (already concatenated) */
  message: Uint8Array;
  close: { code: number; reason: string; wasClean: boolean };
  error: Error;
}

export interface TransportConnectOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  origin?: string;
}

/**
 * Leak-proof WebSocket transport wrapper.
 *
 * Design rules that keep it leak-free:
 * - all listeners are registered once, removed exactly once in `dispose`
 * - `dispose` is idempotent and always detaches the underlying socket
 * - timers (connect timeout) are cleared on every settle path
 */
export class WebSocketTransport extends TypedEventEmitter<TransportEvents> {
  readonly #logger: Logger;
  #ws: WebSocket | undefined;
  #disposed = false;

  constructor(logger: Logger = NOOP_LOGGER) {
    super();
    this.#logger = logger;
  }

  get isOpen(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  get readyState(): number | undefined {
    return this.#ws?.readyState;
  }

  connect(url: string, options: TransportConnectOptions = {}): Promise<void> {
    if (this.#ws) this.dispose();
    this.#disposed = false;

    const wsOptions: ClientOptions = {
      headers: options.headers,
      origin: options.origin,
      handshakeTimeout: options.timeoutMs ?? 20_000,
      // WA servers do not need permessage-deflate; disabling saves ~70% CPU
      // on the frame path.
      perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024,
    };

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, wsOptions);
      this.#ws = ws;
      ws.binaryType = 'nodebuffer';

      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      ws.on('open', () => {
        this.#logger.debug('transport open');
        settle();
        this.emit('open', undefined);
      });
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          this.#logger.warn('transport: ignoring non-binary WS message');
          return;
        }
        this.emit('message', new Uint8Array(data));
      });
      ws.on('close', (code: number, reason: Buffer) => {
        const info = { code, reason: reason.toString('utf-8'), wasClean: code === 1000 };
        this.#logger.debug(info, 'transport closed');
        if (!settled) {
          settle(new ConnectionLostError(`closed during connect (${code})`, { statusCode: code }));
        }
        this.emit('close', info);
        this.dispose();
      });
      ws.on('error', (err: Error) => {
        if (!settled) {
          settle(err instanceof Error ? err : new ConnectionLostError(String(err)));
        }
        this.emit('error', err);
      });
      ws.on('unexpected-response', (_req, res) => {
        settle(
          new HandshakeError(`unexpected HTTP ${res.statusCode} from WS endpoint`, {
            data: { statusCode: res.statusCode },
          }),
        );
      });
      ws.on('ping', () => ws.pong());
    });
  }

  /**
   * Send raw bytes. Throws when the socket is not open — callers use
   * `isOpen` guards, so a throw here always indicates a real lifecycle bug.
   */
  send(data: Uint8Array): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new ConnectionClosedError('transport: send on closed socket');
    }
    ws.send(data, { binary: true });
  }

  ping(): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.ping();
  }

  /** Graceful close; marks normal shutdown via code 1000 by default */
  close(code = 1000, reason = 'client closing'): void {
    if (this.#ws) {
      try {
        if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
          this.#ws.close(code, Buffer.from(reason, 'utf-8'));
        }
      } catch {
        /* already gone */
      }
    }
  }

  /** Detach + terminate without emitting more events (idempotent) */
  override dispose(): void {
    const ws = this.#ws;
    this.#ws = undefined;
    this.#disposed = true;
    if (ws) {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    this.removeAllListeners();
  }

  get disposed(): boolean {
    return this.#disposed;
  }
}

export { TimedOutError };
