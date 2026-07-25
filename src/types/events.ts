import { WAMessage, WAMessageUpdate } from './messages';

export interface ConnectionUpdate {
  /** 'connecting' | 'open' | 'close' | 'qr' | 'pairing' | 'logged_in' */
  status: string;
  /** QR code string (base64 image) */
  qr?: string;
  /** Pairing code */
  pairingCode?: string;
  /** Error information */
  error?: Error;
  /** Whether the session was restored */
  isNewSession?: boolean;
}

export interface BaileysEventMap {
  'connection.update': (update: ConnectionUpdate) => void;
  'message.new': (msg: WAMessage) => void;
  'message.update': (update: WAMessageUpdate) => void;
  'message.receipt': (receipt: MessageReceipt) => void;
  'group.participants.update': (update: GroupParticipantsUpdate) => void;
  'presence.update': (update: PresenceUpdate) => void;
  'contacts.update': (contacts: Contact[]) => void;
  'reaction': (reaction: MessageReaction) => void;
  'error': (error: Error) => void;
}

export interface MessageReceipt {
  jid: string;
  messageId: string;
  status: 'delivered' | 'read' | 'played';
  timestamp: number;
}

export interface GroupParticipantsUpdate {
  groupJid: string;
  action: 'add' | 'remove' | 'promote' | 'demote';
  participants: string[];
  actor?: string;
}

export interface PresenceUpdate {
  jid: string;
  status: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';
  timestamp: number;
}

export interface Contact {
  jid: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
}

export interface MessageReaction {
  messageId: string;
  senderJid: string;
  reaction: string; // emoji
  timestamp: number;
    }
