export type WAMessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'protocol';

export interface WAMessageBase {
  id: string;
  from: string;    // JID of sender
  to: string;      // JID of recipient (chat)
  timestamp: number;
  messageType: WAMessageType;
}

export interface TextMessage extends WAMessageBase {
  messageType: 'text';
  body: string;
  mentionedJids?: string[];
  quotedMessage?: Partial<WAMessage>;
}

export interface MediaMessage extends WAMessageBase {
  messageType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  mediaUrl?: string;
  mimeType: string;
  fileSize?: number;
  caption?: string;
  thumbnail?: Buffer;
}

export type WAMessage = TextMessage | MediaMessage;

export interface WAMessageUpdate {
  messageId: string;
  status: 'edited' | 'deleted' | 'starred';
  newBody?: string;
  timestamp: number;
}
