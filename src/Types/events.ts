import type { AuthenticationCreds } from '../Auth/types';
import type { DisconnectReason } from '../Defaults/disconnect-reason';
import type { BaileysError } from '../Defaults/errors';
import type { HealthReport } from '../Socket/health-monitor';
import type { WAMessage, WAMessageUpdate, MessageUpsertType } from './messages';

export type WAConnectionState = 'open' | 'connecting' | 'close';

export interface ConnectionUpdate {
  connection?: WAConnectionState;
  lastDisconnect?: {
    error: Error | undefined;
    date: Date;
  };
  /** New QR ref string to render (rotates ~20s) */
  qr?: string;
  /** Pair code when using pair-code flow */
  pairingCode?: string;
  /** Received pending notifications — history sync done */
  receivedPendingNotifications?: boolean;
  isOnline?: boolean;
  isNewLogin?: boolean;
}

export interface ContactProfile {
  id: string;
  lid?: string;
  name?: string;
  notify?: string;
  verifiedName?: string;
  imgUrl?: string | null;
  status?: string;
}

export interface Chat {
  id: string;
  name?: string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: number;
  muteEndTime?: number;
  conversationsTimestamp?: number;
  lastMessageRecvTimestamp?: number;
  ephemeralExpiration?: number;
  markedAsUnread?: boolean;
  [extra: string]: unknown;
}

export interface PresenceUpdate {
  id: string;
  presences: Record<string, { lastKnownPresence: string; lastSeen?: number }>;
}

export interface GroupMetadata {
  id: string;
  subject: string;
  owner?: string;
  creation?: number;
  participants?: { id: string; admin?: 'admin' | 'superadmin' | null }[];
  desc?: string;
  [extra: string]: unknown;
}

export interface CallEvent {
  chatId: string;
  from: string;
  id: string;
  date: Date;
  offline: boolean;
  status: 'offer' | 'ringing' | 'timeout' | 'reject' | 'accept' | 'terminate' | string;
  isVideo?: boolean;
  isGroup?: boolean;
}

export interface ReceiptUpdate {
  key: { remoteJid: string; id: string; fromMe?: boolean; participant?: string };
  receipt: { userJid?: string; status: string; t?: number };
}

export interface HistorySyncPayload {
  chats: Chat[];
  contacts: ContactProfile[];
  messages: WAMessage[];
  isLatest?: boolean;
  progress?: number;
  syncType?: string;
}

/**
 * The public event map. All events are emitted on the client instance
 * (`client.events.on('connection.update', ...)` or `client.on(...)`).
 */
export interface BaileysEventMap {
  'connection.update': ConnectionUpdate;
  'creds.update': Partial<AuthenticationCreds>;
  'messaging-history.set': HistorySyncPayload;
  'chats.upsert': Chat[];
  'chats.update': { id: string; [key: string]: unknown }[];
  'chats.delete': string[];
  'contacts.upsert': ContactProfile[];
  'contacts.update': { id: string; [key: string]: unknown }[];
  'messages.upsert': { messages: WAMessage[]; type: MessageUpsertType };
  'messages.update': WAMessageUpdate[];
  'messages.reaction': { key: WAMessage['key']; reaction: { text?: string; senderTimestampMs?: number } }[];
  'message-receipt.update': ReceiptUpdate[];
  'presence.update': PresenceUpdate;
  'groups.upsert': GroupMetadata[];
  'groups.update': Partial<GroupMetadata>[];
  'group-participants.update': {
    id: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote' | 'modify';
    author?: string;
  };
  'blocklist.set': { blocklist: string[] };
  'blocklist.update': { jid: string; type: 'add' | 'remove' };
  call: CallEvent[];
  'health.report': HealthReport;
  /** Internal error channel from non-fatal background paths */
  error: BaileysError;
  logout: { reason: DisconnectReason | number | 'manual' };
}
