import { EventEmitter } from 'events';
import { BaileysClient } from '../client';
import { TextMessage, MediaMessage, WAMessage, WAMessageUpdate } from '../types/messages';
import { Encoder } from './encoder';
import { Decoder } from './decoder';

export class MessageHandler extends EventEmitter {
  private client: BaileysClient;
  private encoder: Encoder;
  private decoder: Decoder;

  constructor(client: BaileysClient) {
    super();
    this.client = client;
    this.encoder = new Encoder(client);
    this.decoder = new Decoder(client);
  }

  processIncoming(raw: any) {
    const msg = this.decoder.decode(raw);
    // Emit appropriate events based on msg type
    if (msg.type === 'message') {
      this.emit('message', msg.content);
    } else if (msg.type === 'receipt') {
      this.emit('receipt', msg.content);
    } else if (msg.type === 'presence') {
      this.emit('presence', msg.content);
    } else if (msg.type === 'groupParticipants') {
      this.emit('group.participants.update', msg.content);
    } else if (msg.type === 'contacts') {
      this.emit('contacts', msg.content);
    } else if (msg.type === 'reaction') {
      this.emit('reaction', msg.content);
    } else if (msg.type === 'messageUpdate') {
      this.emit('update', msg.content);
    }
  }

  async sendText(jid: string, body: string, opts?: any): Promise<TextMessage> {
    const msg: TextMessage = {
      id: this.generateId(),
      from: this.client.auth.getCredentials()?.clientId || 'me',
      to: jid,
      timestamp: Date.now(),
      messageType: 'text',
      body,
      mentionedJids: opts?.mentions,
      quotedMessage: opts?.quotedId ? { id: opts.quotedId } : undefined,
    };
    const encoded = this.encoder.encode(msg);
    this.client.connection.sendRaw(encoded);
    return msg;
  }

  async sendMedia(jid: string, type: string, media: Buffer | string, opts?: any): Promise<MediaMessage> {
    // similar but with media upload
    const msg: MediaMessage = {
      id: this.generateId(),
      from: 'me',
      to: jid,
      timestamp: Date.now(),
      messageType: type as any,
      mimeType: opts?.mimeType || 'application/octet-stream',
      mediaUrl: typeof media === 'string' ? media : undefined,
    };
    const encoded = this.encoder.encode(msg);
    this.client.connection.sendRaw(encoded);
    return msg;
  }

  async deleteMessage(jid: string, messageId: string): Promise<void> {
    // ... encode delete
  }

  async editMessage(jid: string, messageId: string, newBody: string): Promise<void> {
    // ... encode edit
  }

  async react(jid: string, messageId: string, reaction: string): Promise<void> {
    // ...
  }

  async downloadMedia(message: WAMessage): Promise<Buffer> {
    // ...
    return Buffer.alloc(0);
  }

  private generateId(): string {
    return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
      }
