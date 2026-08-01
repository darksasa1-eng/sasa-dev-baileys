import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { WASocket } from '../src/Socket/wa-socket';
import { NoiseHandshake } from '../src/Socket/noise';
import type { NoiseTrafficCipher } from '../src/Socket/noise';
import { FrameDecoder, encodeFrame } from '../src/Socket/frame-codec';
import { WebSocketTransport } from '../src/Socket/transport';
import { encodeBinaryNode } from '../src/WABinary/encode';
import { decodeBinaryNode } from '../src/WABinary/decode';
import { makeSocketConfig } from '../src/Defaults/defaults';
import { makeInMemoryAuthState } from '../src/Auth/init';
import { generateKeyPair } from '../src/Signal/curve';
import { NOOP_LOGGER } from '../src/Defaults/logger';
import type { BinaryNode } from '../src/WABinary/types';
import type { KeyPair } from '../src/Auth/types';
import { delay } from '../src/Utils/generics';

const PORT = 19955;

/**
 * Full client↔server integration harness: a WA-like mini server built with
 * the same NoiseHandshake (responder role) driving the real WASocket through
 * its entire lifecycle.
 */
class MockWaServer {
  wss: WebSocketServer;
  serverStatic: KeyPair;
  receivedNodes: BinaryNode[] = [];
  lastCipher: { send: NoiseTrafficCipher; receive: NoiseTrafficCipher } | undefined;
  wsForFrame: WebSocket | undefined;
  autoSuccessJid: string | undefined;

  constructor(port: number) {
    this.serverStatic = generateKeyPair();
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws) => {
      this.wsForFrame = ws as WebSocket;
      ws.binaryType = 'nodebuffer';
      const noise = new NoiseHandshake({ role: 'responder', staticKeyPair: this.serverStatic });
      const decoder = new FrameDecoder();
      let step = 0;
      ws.on('message', (data: Buffer) => {
        void (async () => {
          try {
            if (!this.lastCipher) {
              if (step === 0) {
                let payload = new Uint8Array(data);
                payload = payload.subarray(4); // WA magic header
                const declared = ((payload[0] ?? 0) << 16) | ((payload[1] ?? 0) << 8) | (payload[2] ?? 0);
                if (declared === payload.byteLength - 3) payload = payload.subarray(3);
                noise.receiveHandshakeMessage(payload);
                ws.send(Buffer.from(encodeFrame(noise.generateHandshakeMessage(new Uint8Array(0)))));
                step = 1;
              } else {
                const frames = decoder.feed(new Uint8Array(data));
                noise.receiveHandshakeMessage(frames[0] ?? new Uint8Array(0));
                this.lastCipher = noise.split();
              }
              return;
            }
            for (const frame of decoder.feed(new Uint8Array(data))) {
              const node = decodeBinaryNode(this.lastCipher.receive.decrypt(frame));
              this.receivedNodes.push(node);
              await this.handleNode(node, ws as WebSocket, this.lastCipher.send);
            }
          } catch {
            /* harness: ignore */
          }
        })();
      });
    });
  }

  async handleNode(node: BinaryNode, ws: WebSocket, send: NoiseTrafficCipher): Promise<void> {
    if (node.tag === 'iq' && node.attrs.xmlns === 'passive') {
      if (this.autoSuccessJid) {
        this.pushNode(ws, send, {
          tag: 'success',
          attrs: {},
          content: [{ tag: 'device', attrs: { jid: this.autoSuccessJid } }],
        });
      }
    }
    if (node.tag === 'iq' && node.attrs.xmlns === 'md') {
      this.pushNode(ws, send, {
        tag: 'iq',
        attrs: { type: 'result', id: node.attrs.id ?? '' },
        content: [{ tag: 'pair-device', attrs: {}, content: [{ tag: 'ref', attrs: {}, content: 'mock-ref-1' }] }],
      });
    }
  }

  pushNode(ws: WebSocket, send: NoiseTrafficCipher, node: BinaryNode): void {
    ws.send(Buffer.from(encodeFrame(send.encrypt(encodeBinaryNode(node)))));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => resolve());
    });
  }
}

describe('socket integration', () => {
  let server: MockWaServer;
  beforeEach(() => {
    server = new MockWaServer(PORT);
  });
  afterEach(async () => {
    await server.close();
    await delay(20);
  });

  it('completes handshake → preauth → open with iq correlation', async () => {
    server.autoSuccessJid = '41789996011:5@s.whatsapp.net';
    const auth = makeInMemoryAuthState();
    auth.creds.registered = true;
    auth.creds.me = { id: '41789996011:5@s.whatsapp.net' };
    const config = makeSocketConfig({
      auth,
      logger: NOOP_LOGGER,
      waWebSocketUrl: `ws://127.0.0.1:${PORT}/ws/chat`,
      version: [2, 3000, 1],
      features: { keepAlive: false },
    });
    const socket = new WASocket(config);
    const updates: { connection?: string }[] = [];
    const credsUpdates: unknown[] = [];
    socket.on('connection.update', (u) => updates.push(u as { connection?: string }));
    socket.on('creds.update', (c) => credsUpdates.push(c));

    await socket.connect([2, 3000, 1]);
    await delay(200);

    expect(updates.map((u) => u.connection)).toContain('connecting');
    expect(updates.map((u) => u.connection)).toContain('open');
    expect(credsUpdates.length).toBeGreaterThan(0);
    expect(socket.isOpen).toBe(true);

    const echo = await socket.query({ tag: 'iq', attrs: { type: 'get', xmlns: 'md', to: 's.whatsapp.net' } }, 1000);
    expect(echo.attrs.type).toBe('result');

    socket.destroy();
  });

  it('exposes QR ref for unregistered sessions', async () => {
    const auth = makeInMemoryAuthState();
    const config = makeSocketConfig({
      auth,
      logger: NOOP_LOGGER,
      waWebSocketUrl: `ws://127.0.0.1:${PORT}/ws/chat`,
      version: [2, 3000, 1],
      features: { keepAlive: false },
    });
    const socket = new WASocket(config);
    const qrValues: string[] = [];
    socket.on('connection.update', (u) => {
      if (u.qr) qrValues.push(u.qr);
    });
    await socket.connect([2, 3000, 1]);
    await delay(200);
    expect(qrValues.length).toBeGreaterThan(0);
    expect(qrValues[0]).toContain('mock-ref-1');
    socket.destroy();
  });

  it('malformed frame does not crash the socket', async () => {
    server.autoSuccessJid = '1:1@s.whatsapp.net';
    const auth = makeInMemoryAuthState();
    auth.creds.registered = true;
    auth.creds.me = { id: '1:1@s.whatsapp.net' };
    const config = makeSocketConfig({
      auth,
      logger: NOOP_LOGGER,
      waWebSocketUrl: `ws://127.0.0.1:${PORT}`,
      version: [2, 3000, 1],
      features: { keepAlive: false },
    });
    const socket = new WASocket(config);
    await socket.connect([2, 3000, 1]);
    await delay(150);
    // push random garbage that will fail the traffic-cipher auth — must close cleanly with error, not crash
    server.wsForFrame?.send(Buffer.from(encodeFrame(new Uint8Array(48).fill(7))));
    await delay(60);
    expect((socket as unknown as { connectionState: string }).connectionState).not.toBe('handshake');
    socket.destroy();
  });
});

describe('transport lifecycle', () => {
  it('connect, echo, close cleanly', async () => {
    const wss = new WebSocketServer({ port: PORT + 1 });
    wss.on('connection', (ws) => ws.on('message', (d) => ws.send(d)));
    const t = new WebSocketTransport();
    await t.connect(`ws://127.0.0.1:${PORT + 1}`);
    const received: Uint8Array[] = [];
    t.on('message', (m) => received.push(m));
    t.send(new Uint8Array([1, 2, 3]));
    await delay(50);
    expect(received).toHaveLength(1);
    t.close();
    await delay(50);
    t.dispose();
    t.dispose(); // idempotent
    wss.close();
  });

  it('send on closed socket throws typed error', async () => {
    const t = new WebSocketTransport();
    expect(() => t.send(new Uint8Array([1]))).toThrowError(/closed/);
  });

  it('rejects connect to dead endpoint with error', async () => {
    const t = new WebSocketTransport();
    await expect(t.connect('ws://127.0.0.1:1/dead', { timeoutMs: 300 })).rejects.toThrow();
  });
});
