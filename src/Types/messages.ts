/**
 * Message model types.
 *
 * Message *content* follows the WhatsApp Web protobuf `Message` shape; the
 * deep fields are typed loosely (`unknown`-friendly) because WhatsApp ships
 * hundreds of message types and evolves them monthly. Common shapes have
 * dedicated interfaces for IntelliSense.
 */

export interface WAMessageKey {
  /** chat the message belongs to */
  remoteJid?: string;
  /** sender JID for group/PM contexts */
  participant?: string;
  fromMe?: boolean;
  id?: string;
}

export interface ContextInfo {
  stanzaId?: string;
  participant?: string;
  quotedMessage?: MessageContent;
  mentionedJid?: string[];
  isForwarded?: boolean;
  forwardingScore?: number;
  expiration?: number;
  ephemeralSettingTimestamp?: number;
  [key: string]: unknown;
}

export interface TextMessageBody {
  text: string;
  contextInfo?: ContextInfo;
}

export interface ExtendedTextMessageBody extends TextMessageBody {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  matchedText?: string;
  jpegThumbnail?: Uint8Array;
  previewType?: number;
}

export interface MediaAttachment {
  url?: string;
  directPath?: string;
  mediaKey?: Uint8Array;
  mediaKeyTimestamp?: number;
  fileSha256?: Uint8Array;
  fileEncSha256?: Uint8Array;
  fileLength?: number | Long;
  mimetype?: string;
  height?: number;
  width?: number;
  seconds?: number;
  fileName?: string;
  caption?: string;
  jpegThumbnail?: Uint8Array;
  streamingSidecar?: Uint8Array;
}

/** 64-bit values widened for JS — matches protobufjs `Long` shape */
export interface Long {
  low: number;
  high: number;
  unsigned: boolean;
}

export interface ReactionMessageBody {
  key?: WAMessageKey;
  text?: string;
  groupingKey?: string;
  senderTimestampMs?: number | Long;
}

export interface ProtocolMessageBody {
  key?: WAMessageKey;
  type?: 'REVOKE' | 'EPHEMERAL_SETTING' | number;
  ephemeralExpiration?: number;
  editedMessage?: MessageContent;
  timestampMs?: number | Long;
}

/**
 * Message content map. Keys mirror WA proto field names; any field not
 * listed is still valid and carried opaquely.
 */
export interface MessageContent {
  conversation?: string;
  extendedTextMessage?: ExtendedTextMessageBody;
  imageMessage?: MediaAttachment;
  videoMessage?: MediaAttachment;
  audioMessage?: MediaAttachment & { ptt?: boolean };
  documentMessage?: MediaAttachment;
  stickerMessage?: MediaAttachment & { isAnimated?: boolean };
  reactionMessage?: ReactionMessageBody;
  protocolMessage?: ProtocolMessageBody;
  contactsArrayMessage?: { displayName?: string; contacts?: unknown[] };
  locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string };
  liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
  pollCreationMessage?: unknown;
  viewOnceMessage?: { message?: MessageContent };
  viewOnceMessageV2?: { message?: MessageContent };
  ephemeralMessage?: { message?: MessageContent };
  documentWithCaptionMessage?: { message?: MessageContent };
  editedMessage?: { message?: MessageContent };
  [protoField: string]: unknown;
}

export interface WAMessage {
  key: WAMessageKey;
  message?: MessageContent;
  /** unix seconds */
  messageTimestamp?: number | Long;
  status?: WAMessageStatus;
  broadcast?: boolean;
  pushName?: string;
  mediaCiphertextSha256?: Uint8Array;
  participant?: string;
  [extra: string]: unknown;
}

export type WAMessageStatus = 'ERROR' | 'PENDING' | 'SERVER_ACK' | 'DELIVERY_ACK' | 'READ' | 'PLAYED';

export interface WAMessageUpdate extends Partial<WAMessage> {
  key: WAMessageKey;
  update: Partial<WAMessage> & { status?: WAMessageStatus };
}

export interface WAPresence {
  lastKnownPresence?: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused';
  lastSeen?: number;
}

export type MessageUpsertType = 'notify' | 'append';

// ---- text extraction -------------------------------------------------------

/** Extract the plain text of the most common message payloads */
export function extractMessageText(message: MessageContent | undefined | null): string | undefined {
  if (!message) return undefined;
  if (typeof message.conversation === 'string') return message.conversation;
  const ext = message.extendedTextMessage;
  if (ext?.text) return ext.text;
  const anyMedia = message.imageMessage ?? message.videoMessage ?? message.documentMessage;
  if (anyMedia?.caption) return anyMedia.caption;
  const wrapped =
    message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message.viewOnceMessageV2?.message;
  if (wrapped) return extractMessageText(wrapped as MessageContent);
  return undefined;
}

/** Unwrap view-once/ephemeral/document-with-caption wrappers */
export function unwrapMessageContent(message: MessageContent | undefined): MessageContent | undefined {
  if (!message) return undefined;
  let current: MessageContent | undefined = message;

  while (current) {
    const next =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message;
    if (!next || next === current) return current;
    current = next as MessageContent;
  }
  return current;
}
