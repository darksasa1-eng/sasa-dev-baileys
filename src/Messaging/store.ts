import type { Chat, ContactProfile } from '../Types/events';
import type { WAMessage } from '../Types/messages';

export interface InMemoryStoreOptions {
  /** Max chats retained */
  maxChats?: number;
  /** Max contacts retained */
  maxContacts?: number;
  /** Max messages retained per chat */
  maxMessagesPerChat?: number;
  /** Max chats having message history at once */
  maxChatsWithMessages?: number;
}

export interface StoreSnapshot {
  chats: number;
  contacts: number;
  messages: number;
}

/**
 * Store implementation — bounded in-memory cache of chats, contacts and
 * messages, fed by `messaging-history.set` and `messages.upsert` events.
 * Fully capped: impossible to grow RAM unboundedly even on huge accounts.
 */
export class InMemoryStore {
  readonly #opts: Required<InMemoryStoreOptions>;
  #chats = new Map<string, Chat>();
  #contacts = new Map<string, ContactProfile>();
  #messages = new Map<string, Map<string, WAMessage>>();

  constructor(options: InMemoryStoreOptions = {}) {
    this.#opts = {
      maxChats: options.maxChats ?? 3_000,
      maxContacts: options.maxContacts ?? 10_000,
      maxMessagesPerChat: options.maxMessagesPerChat ?? 1_000,
      maxChatsWithMessages: options.maxChatsWithMessages ?? 1_000,
    };
  }

  // ---- chats ----

  upsertChats(chats: Chat[]): void {
    for (const chat of chats) {
      this.#chats.set(chat.id, { ...this.#chats.get(chat.id), ...chat });
    }
    this.#evictOldest(this.#chats, this.#opts.maxChats);
  }

  updateChat(id: string, patch: Partial<Chat>): void {
    const chat = this.#chats.get(id);
    if (chat) this.#chats.set(id, { ...chat, ...patch });
  }

  deleteChats(ids: string[]): void {
    for (const id of ids) {
      this.#chats.delete(id);
      this.#messages.delete(id);
    }
  }

  getChat(id: string): Chat | undefined {
    return this.#chats.get(id);
  }

  get chats(): Chat[] {
    return [...this.#chats.values()];
  }

  // ---- contacts ----

  upsertContacts(contacts: ContactProfile[]): void {
    for (const contact of contacts) {
      this.#contacts.set(contact.id, { ...this.#contacts.get(contact.id), ...contact });
    }
    this.#evictOldest(this.#contacts, this.#opts.maxContacts);
  }

  getContact(id: string): ContactProfile | undefined {
    return this.#contacts.get(id);
  }

  get contacts(): ContactProfile[] {
    return [...this.#contacts.values()];
  }

  // ---- messages ----

  addMessages(chatId: string, messages: WAMessage[]): void {
    let bucket = this.#messages.get(chatId);
    if (!bucket) {
      if (this.#messages.size >= this.#opts.maxChatsWithMessages) {
        // evict least-recently-touched chat bucket
        const oldest = this.#messages.keys().next().value;
        if (oldest !== undefined) this.#messages.delete(oldest);
      }
      bucket = new Map();
      this.#messages.set(chatId, bucket);
    }
    // touch chat bucket (LRU ordering)
    this.#messages.delete(chatId);
    this.#messages.set(chatId, bucket);
    for (const message of messages) {
      if (!message.key?.id) continue;
      bucket.set(message.key.id, message);
    }
    while (bucket.size > this.#opts.maxMessagesPerChat) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  getMessage(chatId: string, messageId: string): WAMessage | undefined {
    return this.#messages.get(chatId)?.get(messageId);
  }

  getMessages(chatId: string): WAMessage[] {
    return [...(this.#messages.get(chatId)?.values() ?? [])];
  }

  updateMessage(chatId: string, messageId: string, patch: Partial<WAMessage>): void {
    const chat = this.#messages.get(chatId);
    const message = chat?.get(messageId);
    if (chat && message) chat.set(messageId, { ...message, ...patch });
  }

  removeMessage(chatId: string, messageId: string): boolean {
    return this.#messages.get(chatId)?.delete(messageId) ?? false;
  }

  // ---- lifecycle ----

  snapshot(): StoreSnapshot {
    let messages = 0;
    for (const bucket of this.#messages.values()) messages += bucket.size;
    return { chats: this.#chats.size, contacts: this.#contacts.size, messages };
  }

  clear(): void {
    this.#chats.clear();
    this.#contacts.clear();
    this.#messages.clear();
  }

  #evictOldest<T>(map: Map<string, T>, max: number): void {
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
