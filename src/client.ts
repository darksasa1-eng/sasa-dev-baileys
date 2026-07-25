import { EventEmitter } from 'events';
import { BaileysEventMap, ConnectionUpdate } from './types/events';
import { AuthState } from './types/auth';
import { SocketConfig, WALoginMethod } from './types/socket';
import { AuthManager } from './auth/state';
import { ConnectionManager } from './connection/socket';
import { MessageHandler } from './message/handler';
import { PluginManager } from './plugins/plugin-base';
import { Logger } from './utils/logger';
import { retry } from './utils/retry';
import { throttle } from './utils/throttle';
import { defaultConfig } from './config';

export class BaileysClient extends EventEmitter {
  public auth: AuthManager;
  public connection: ConnectionManager;
  public messages: MessageHandler;
  public plugins: PluginManager;
  public logger: Logger;
  private config: SocketConfig;

  constructor(config: Partial<SocketConfig> = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
    this.logger = new Logger({ level: 'info' });
    this.auth = new AuthManager(this);
    this.connection = new ConnectionManager(this);
    this.messages = new MessageHandler(this);
    this.plugins = new PluginManager(this);

    // Wire up internal events
    this.connection.on('update', (update: ConnectionUpdate) => {
      this.emit('connection.update', update);
    });

    this.messages.on('message', (msg) => {
      // Run middleware pipeline then emit
      this.plugins.runMiddleware(msg, () => {
        this.emit('message.new', msg);
      });
    });

    this.messages.on('update', (update) => this.emit('message.update', update));
    this.messages.on('receipt', (receipt) => this.emit('message.receipt', receipt));
    this.messages.on('group.participants.update', (upd) => this.emit('group.participants.update', upd));
    this.messages.on('presence', (upd) => this.emit('presence.update', upd));
    this.messages.on('contacts', (contacts) => this.emit('contacts.update', contacts));
    this.messages.on('reaction', (reaction) => this.emit('reaction', reaction));
  }

  /** Start the connection process */
  async connect(): Promise<void> {
    try {
      await this.connection.connect();
    } catch (err) {
      this.logger.error('Failed to connect:', err);
      this.emit('error', err as Error);
    }
  }

  /** Disconnect gracefully */
  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }

  /** Request QR code for login (if loginMethod = 'qr') */
  async requestQR(): Promise<string> {
    return this.connection.requestQR();
  }

  /** Request pairing code (if loginMethod = 'pairing_code') */
  async requestPairingCode(phoneNumber: string): Promise<string> {
    return this.connection.requestPairingCode(phoneNumber);
  }

  /** Send a text message */
  async sendMessage(jid: string, content: string, options?: { mentions?: string[]; quotedId?: string }) {
    const msg = await this.messages.sendText(jid, content, options);
    return msg;
  }

  /** Send media (buffer or URL) */
  async sendMedia(jid: string, type: 'image'|'video'|'audio'|'document', media: Buffer | string, options?: any) {
    return this.messages.sendMedia(jid, type, media, options);
  }

  /** ... other convenient methods delegate to feature modules */
  async deleteMessage(jid: string, messageId: string) {
    return this.messages.deleteMessage(jid, messageId);
  }

  async editMessage(jid: string, messageId: string, newContent: string) {
    return this.messages.editMessage(jid, messageId, newContent);
  }

  async reactToMessage(jid: string, messageId: string, reaction: string) {
    return this.messages.react(jid, messageId, reaction);
  }

  async downloadMedia(message: any): Promise<Buffer> {
    return this.messages.downloadMedia(message);
  }

  // Event emitter overrides with typed signatures
  on<K extends keyof BaileysEventMap>(event: K, listener: BaileysEventMap[K]): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit<K extends keyof BaileysEventMap>(event: K, ...args: Parameters<BaileysEventMap[K]>): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  once<K extends keyof BaileysEventMap>(event: K, listener: BaileysEventMap[K]): this;
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
}
