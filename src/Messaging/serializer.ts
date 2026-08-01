import { ProtocolError } from '../Defaults/errors';
import { ProtoWriter, readFields, getFieldBytes, getFieldVarint, WIRE_LENGTH_DELIMITED } from '../Signal/proto-wire';
import type { MessageContent, WAMessageKey, ContextInfo } from '../Types/messages';

/**
 * Advanced Message Serializer — schema-driven proto encoder/decoder for
 * whatsapp's `Message` structure. Field numbers follow the long-stable
 * WA proto numbering for the most common payload types; unknown or newer
 * payloads should be carried as raw bytes or routed through hooks.
 */

type ScalarType = 'string' | 'bytes' | 'varint' | 'bool';

interface FieldSchema {
  num: number;
  type: ScalarType | 'message' | 'repeated-string';
  schema?: MessageSchema;
}

interface MessageSchema {
  fields: Record<string, FieldSchema>;
}

const messageKeySchema: MessageSchema = {
  fields: {
    remoteJid: { num: 1, type: 'string' },
    fromMe: { num: 2, type: 'bool' },
    id: { num: 3, type: 'string' },
    participant: { num: 4, type: 'string' },
  },
};

const contextInfoSchema: MessageSchema = {
  fields: {
    stanzaId: { num: 1, type: 'string' },
    participant: { num: 2, type: 'string' },
    quotedMessage: { num: 3, type: 'message', schema: undefined as unknown as MessageSchema }, // recursive, patched below
    remoteJid: { num: 4, type: 'string' },
    forwardingScore: { num: 7, type: 'varint' },
    isForwarded: { num: 11, type: 'bool' },
    mentionedJid: { num: 15, type: 'repeated-string' },
    expiration: { num: 16, type: 'varint' },
    ephemeralSettingTimestamp: { num: 18, type: 'varint' },
  },
};

const extendedTextSchema: MessageSchema = {
  fields: {
    text: { num: 1, type: 'string' },
    matchedText: { num: 2, type: 'string' },
    canonicalUrl: { num: 4, type: 'string' },
    description: { num: 5, type: 'string' },
    title: { num: 6, type: 'string' },
    previewType: { num: 9, type: 'varint' },
    jpegThumbnail: { num: 16, type: 'bytes' },
    contextInfo: { num: 17, type: 'message', schema: contextInfoSchema },
  },
};

const mediaMessageSchema = (captionNum: number): MessageSchema => ({
  fields: {
    url: { num: 1, type: 'string' },
    mimetype: { num: 2, type: 'string' },
    caption: { num: captionNum, type: 'string' },
    fileSha256: { num: 4, type: 'bytes' },
    fileLength: { num: 5, type: 'varint' },
    height: { num: 6, type: 'varint' },
    width: { num: 7, type: 'varint' },
    mediaKey: { num: 8, type: 'bytes' },
    fileEncSha256: { num: 9, type: 'bytes' },
    directPath: { num: 11, type: 'string' },
    mediaKeyTimestamp: { num: 12, type: 'varint' },
    jpegThumbnail: { num: 16, type: 'bytes' },
    contextInfo: { num: 17, type: 'message', schema: contextInfoSchema },
  },
});

const reactionSchema: MessageSchema = {
  fields: {
    key: { num: 1, type: 'message', schema: messageKeySchema },
    text: { num: 2, type: 'string' },
    groupingKey: { num: 3, type: 'string' },
    senderTimestampMs: { num: 4, type: 'varint' },
  },
};

const protocolMessageSchema: MessageSchema = {
  fields: {
    key: { num: 1, type: 'message', schema: messageKeySchema },
    type: { num: 2, type: 'varint' },
    ephemeralExpiration: { num: 4, type: 'varint' },
    timestampMs: { num: 5, type: 'varint' },
    editedMessage: { num: 14, type: 'message', schema: undefined as unknown as MessageSchema },
  },
};

const messageSchema: MessageSchema = {
  fields: {
    conversation: { num: 1, type: 'string' },
    senderKeyDistributionMessage: { num: 2, type: 'bytes' },
    imageMessage: { num: 3, type: 'message', schema: mediaMessageSchema(3) },
    extendedTextMessage: { num: 6, type: 'message', schema: extendedTextSchema },
    documentMessage: { num: 7, type: 'message', schema: mediaMessageSchema(3) },
    audioMessage: { num: 8, type: 'message', schema: mediaMessageSchema(3) },
    videoMessage: { num: 9, type: 'message', schema: mediaMessageSchema(3) },
    protocolMessage: { num: 12, type: 'message', schema: protocolMessageSchema },
    reactionMessage: { num: 46, type: 'message', schema: reactionSchema },
    ephemeralMessage: { num: 56, type: 'message', schema: undefined as unknown as MessageSchema },
    viewOnceMessage: { num: 55, type: 'message', schema: undefined as unknown as MessageSchema },
  },
};

// wire up recursive schemas
(contextInfoSchema.fields.quotedMessage as FieldSchema).schema = messageSchema;
(protocolMessageSchema.fields.editedMessage as FieldSchema).schema = messageSchema;
(messageSchema.fields.ephemeralMessage as FieldSchema).schema = {
  fields: { message: { num: 1, type: 'message', schema: messageSchema } },
};
(messageSchema.fields.viewOnceMessage as FieldSchema).schema = {
  fields: { message: { num: 1, type: 'message', schema: messageSchema } },
};

function encodeBySchema(schema: MessageSchema, value: Record<string, unknown>): Uint8Array {
  const w = new ProtoWriter();
  for (const [name, field] of Object.entries(schema.fields)) {
    const v = value[name];
    if (v === undefined || v === null) continue;
    switch (field.type) {
      case 'string':
        w.bytes(field.num, new TextEncoder().encode(String(v)));
        break;
      case 'repeated-string':
        for (const item of v as string[]) w.bytes(field.num, new TextEncoder().encode(String(item)));
        break;
      case 'bytes': {
        const b = v instanceof Uint8Array ? v : Buffer.from(String(v), 'base64');
        w.bytes(field.num, b);
        break;
      }
      case 'bool':
        w.varint(field.num, v ? 1 : 0);
        break;
      case 'varint':
        w.varint(field.num, typeof v === 'number' ? v : Number(v));
        break;
      case 'message': {
        if (!field.schema) throw new ProtocolError(`serializer: nested schema missing for field "${name}"`);
        w.bytes(field.num, encodeBySchema(field.schema, v as Record<string, unknown>));
        break;
      }
    }
  }
  return w.finish();
}

function decodeBySchema(schema: MessageSchema, data: Uint8Array): Record<string, unknown> {
  const fields = readFields(data);
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    switch (field.type) {
      case 'string': {
        const b = getFieldBytes(fields, field.num);
        if (b) out[name] = Buffer.from(b).toString('utf-8');
        break;
      }
      case 'repeated-string': {
        const items: string[] = [];
        for (const f of fields) {
          if (f.fieldNumber === field.num && f.wireType === WIRE_LENGTH_DELIMITED && f.bytes) {
            items.push(Buffer.from(f.bytes).toString('utf-8'));
          }
        }
        if (items.length) out[name] = items;
        break;
      }
      case 'bytes': {
        const b = getFieldBytes(fields, field.num);
        if (b) out[name] = b;
        break;
      }
      case 'bool': {
        const v = getFieldVarint(fields, field.num);
        if (v !== undefined) out[name] = v !== 0;
        break;
      }
      case 'varint': {
        const v = getFieldVarint(fields, field.num);
        if (v !== undefined) out[name] = v;
        break;
      }
      case 'message': {
        if (!field.schema) throw new ProtocolError(`serializer: nested schema missing for field "${name}"`);
        const b = getFieldBytes(fields, field.num);
        if (b) out[name] = decodeBySchema(field.schema, b);
        break;
      }
    }
  }
  return out;
}

// ---- public serializer API --------------------------------------------------

export function serializeMessage(message: MessageContent): Uint8Array {
  if (!message || typeof message !== 'object') throw new ProtocolError('serializeMessage: invalid content');
  return encodeBySchema(messageSchema, message as Record<string, unknown>);
}

export function deserializeMessage(data: Uint8Array): MessageContent {
  return decodeBySchema(messageSchema, data) as MessageContent;
}

export function serializeMessageKey(key: WAMessageKey): Uint8Array {
  return encodeBySchema(messageKeySchema, key as Record<string, unknown>);
}

export function deserializeMessageKey(data: Uint8Array): WAMessageKey {
  return decodeBySchema(messageKeySchema, data) as WAMessageKey;
}

export function serializeContextInfo(info: ContextInfo): Uint8Array {
  return encodeBySchema(contextInfoSchema, info as Record<string, unknown>);
}

// ---- sender key distribution ------------------------------------------------

export function serializeSenderKeyDistributionMessageWrapper(payload: Uint8Array): MessageContent {
  return { senderKeyDistributionMessage: payload };
}
