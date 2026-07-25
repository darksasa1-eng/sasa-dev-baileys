import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { BaileysClient } from '../client';
import { ConnectionUpdate } from '../types/events';
import { Transport } from './transport';
import { Handshake } from './handshake';

export class ConnectionManager extends EventEmitter {
  private client: BaileysClient;
  private ws: WebSocket | null = null;
  private transport: Transport;
  private handshake: Handshake;
  private reconnectAttempts = 0;
  private keepAliveTimer?: NodeJS.Timeout;

  constructor(client: BaileysClient) {
    super();
    this.client = client;
    this.transport = new Transport(client);
    this.handshake = new Handshake(client);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    const { wsUrl, autoReconnect, reconnectDelay } = this.client['config'];

    const doConnect = async () => {
      this.emit('update', { status: 'connecting' });
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      return new Promise<void>((resolve, reject) => {
        ws.on('open', async () => {
          this.emit('update', { status: 'open' });
          this.reconnectAttempts = 0;
          this.startKeepAlive();
          // Perform noise handshake (stub)
          await this.handshake.perform(ws);
          resolve();
        });

        ws.on('message', (data: ArrayBuffer) => {
          const decoded = this.transport.decode(data);
          // route to MessageHandler
          this.client.messages.processIncoming(decoded);
        });

        ws.on('close', (code) => {
          this.stopKeepAlive();
          this.emit('update', { status: 'close', error: new Error(`Closed with code ${code}`) });
          if (autoReconnect && (!this.client['config'].maxReconnectAttempts || this.reconnectAttempts < this.client['config'].maxReconnectAttempts)) {
            setTimeout(() => {
              this.reconnectAttempts++;
              this.connect().catch(() => {});
            }, reconnectDelay * Math.min(this.reconnectAttempts, 10));
          }
        });

        ws.on('error', (err) => {
          reject(err);
          this.emit('update', { status: 'error', error: err });
        });
      });
    };

    return doConnect();
  }

  async disconnect(): Promise<void> {
    this.stopKeepAlive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async requestQR(): Promise<string> {
    // Simulated QR generation (real implementation would ask WhatsApp servers)
    const qr = 'data:image/png;base64,iVBORw0KGgo...'; // placeholder
    this.emit('update', { status: 'qr', qr });
    return qr;
  }

  async requestPairingCode(phoneNumber: string): Promise<string> {
    const code = '12345'; // placeholder
    this.emit('update', { status: 'pairing', pairingCode: code });
    return code;
  }

  private startKeepAlive() {
    this.keepAliveTimer = setInterval(() => {
      this.ws?.ping();
    }, this.client['config'].keepAliveInterval);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
  }

  // Outgoing message send raw
  sendRaw(data: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      throw new Error('WebSocket not connected');
    }
  }
      }
