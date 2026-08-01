import type { ContextInfo, MessageContent, WAMessage, WAMessageKey } from '../Types/messages';
import { generateMessageID } from '../Utils/generics';
import type { MediaUploadResult } from '../Media/uploader';

/**
 * Advanced Message Builder — fluent construction of message payloads with
 * full typing. The builder never performs I/O except the injected media
 * uploader, making it fully unit-testable.
 */

export interface QuotedMessage {
  key: WAMessageKey;
  message?: MessageContent;
}

export interface BuildOptions {
  /** Message id override (default: generated) */
  id?: string;
  quoted?: QuotedMessage;
  mentions?: string[];
  /** Mark the message as forwarded */
  forwarded?: boolean;
}

function makeKey(jid: string, id: string): WAMessageKey {
  return { remoteJid: jid, id, fromMe: true };
}

function buildContextInfo(opts: BuildOptions): ContextInfo | undefined {
  const info: ContextInfo = {};
  if (opts.quoted?.key?.id) {
    info.stanzaId = opts.quoted.key.id;
    info.participant = opts.quoted.key.participant ?? opts.quoted.key.remoteJid;
    if (opts.quoted.message) info.quotedMessage = opts.quoted.message;
  }
  if (opts.mentions?.length) info.mentionedJid = opts.mentions;
  if (opts.forwarded) {
    info.isForwarded = true;
    info.forwardingScore = 1;
  }
  return Object.keys(info).length > 0 ? info : undefined;
}

export class MessageBuilder {
  #jid: string;

  constructor(jid: string) {
    this.#jid = jid;
  }

  #wrap(content: MessageContent, opts: BuildOptions): WAMessage {
    const id = opts.id ?? generateMessageID();
    return { key: makeKey(this.#jid, id), message: content, messageTimestamp: Math.floor(Date.now() / 1000) };
  }

  /** Plain text (uses conversation or extendedText when it carries context) */
  text(body: string, opts: BuildOptions = {}): WAMessage {
    const context = buildContextInfo(opts);
    const content: MessageContent = context
      ? { extendedTextMessage: { text: body, contextInfo: context } }
      : { conversation: body };
    return this.#wrap(content, opts);
  }

  #mediaMessage(
    kind: 'imageMessage' | 'videoMessage' | 'audioMessage' | 'documentMessage' | 'stickerMessage',
    upload: MediaUploadResult,
    extras: { mimetype?: string; caption?: string; fileName?: string; seconds?: number; height?: number; width?: number; ptt?: boolean },
    opts: BuildOptions,
  ): WAMessage {
    const content: MessageContent = {
      [kind]: {
        url: upload.url,
        directPath: upload.directPath,
        mediaKey: upload.mediaKey,
        fileSha256: upload.fileSha256,
        fileEncSha256: upload.fileEncSha256,
        fileLength: upload.fileLength,
        mimetype: extras.mimetype,
        caption: extras.caption,
        fileName: extras.fileName,
        seconds: extras.seconds,
        height: extras.height,
        width: extras.width,
        ptt: extras.ptt,
        contextInfo: buildContextInfo(opts),
      },
    };
    return this.#wrap(content, opts);
  }

  image(upload: MediaUploadResult, opts: BuildOptions & { mimetype?: string; caption?: string } = {}): WAMessage {
    return this.#mediaMessage('imageMessage', upload, opts, opts);
  }

  video(
    upload: MediaUploadResult,
    opts: BuildOptions & { mimetype?: string; caption?: string; seconds?: number; height?: number; width?: number } = {},
  ): WAMessage {
    return this.#mediaMessage('videoMessage', upload, opts, opts);
  }

  audio(upload: MediaUploadResult, opts: BuildOptions & { mimetype?: string; seconds?: number; ptt?: boolean } = {}): WAMessage {
    return this.#mediaMessage('audioMessage', upload, opts, opts);
  }

  document(
    upload: MediaUploadResult,
    opts: BuildOptions & { mimetype?: string; caption?: string; fileName?: string } = {},
  ): WAMessage {
    return this.#mediaMessage('documentMessage', upload, opts, opts);
  }

  sticker(upload: MediaUploadResult, opts: BuildOptions & { mimetype?: string } = {}): WAMessage {
    return this.#mediaMessage('stickerMessage', upload, { ...opts, mimetype: 'image/webp' }, opts);
  }

  /** Emoji reaction to another message; pass '' to remove */
  reaction(target: WAMessageKey, emoji: string, opts: BuildOptions = {}): WAMessage {
    return this.#wrap(
      { reactionMessage: { key: target, text: emoji, senderTimestampMs: Date.now() } },
      { id: opts.id },
    );
  }

  /** Edit one of your earlier messages */
  edit(target: WAMessageKey, newBody: string, opts: BuildOptions = {}): WAMessage {
    return this.#wrap(
      {
        protocolMessage: {
          key: target,
          // 14 = MESSAGE_EDIT
          type: 14,
          editedMessage: { conversation: newBody },
          timestampMs: Date.now(),
        },
      },
      { id: opts.id },
    );
  }

  /** Delete a message for everyone */
  delete(target: WAMessageKey, opts: BuildOptions = {}): WAMessage {
    return this.#wrap({ protocolMessage: { key: target, type: 0 } }, { id: opts.id });
  }

  /** Wrap any content as view-once */
  viewOnce(message: MessageContent): MessageContent {
    return { viewOnceMessage: { message } };
  }

  /** Wrap any content as ephemeral */
  ephemeral(message: MessageContent, expiration = 604800): MessageContent {
    void expiration; // carried via contextInfo at send time
    return { ephemeralMessage: { message } };
  }
}

/** Sender-key distribution payload helper (group encryption setup) */
export function buildSenderKeyDistributionMessage(payload: Uint8Array): MessageContent {
  return { senderKeyDistributionMessage: payload };
}
