import { BaileysError } from '../Defaults/errors';
import type { Logger } from '../Defaults/logger';
import { createLogger, NOOP_LOGGER } from '../Defaults/logger';
import { importSession } from '../Auth/session-codec';
import type { StorageAdapter } from '../Store/adapter';
import { SasaClient, createClient, type SasaClientOptions } from './client';

export interface SessionManagerOptions {
  /** Base config cloned per session */
  baseConfig: Omit<SasaClientOptions, 'auth' | 'sessionNamespace'>;
  /** Adapter factory: one adapter per session (or a shared one, namespaced) */
  adapterFactory: (sessionName: string) => StorageAdapter;
  logger?: Logger;
}

export interface SessionSnapshot {
  name: string;
  connected: boolean;
  registered?: boolean;
  me?: string;
  health: string;
}

/**
 * Multi Session Support — manage many isolated client instances over one or
 * many storage adapters. Sessions are namespaced inside shared adapters, so
 * ten accounts can live in one Redis/database instance safely.
 */
export class SessionManager {
  readonly #opts: SessionManagerOptions;
  readonly #logger: Logger;
  readonly #sessions = new Map<string, { client: SasaClient; adapter: StorageAdapter }>();

  constructor(options: SessionManagerOptions) {
    this.#opts = options;
    this.#logger = options.logger ?? NOOP_LOGGER;
  }

  get size(): number {
    return this.#sessions.size;
  }

  names(): string[] {
    return [...this.#sessions.keys()];
  }

  get(name: string): SasaClient | undefined {
    return this.#sessions.get(name)?.client;
  }

  /** Create (or return existing) named session */
  async create(name: string, overrides?: Partial<SasaClientOptions>): Promise<SasaClient> {
    const existing = this.#sessions.get(name);
    if (existing) return existing.client;
    if (this.#sessions.size >= 100) throw new BaileysError('session limit reached (100)', { code: 'ERR_SESSION_LIMIT' });

    const adapter = this.#opts.adapterFactory(name);
    const baseLogger = this.#opts.baseConfig.logger ? createLogger(this.#opts.baseConfig.logger as never) : this.#logger;
    const client = createClient({
      ...this.#opts.baseConfig,
      ...overrides,
      auth: adapter,
      sessionNamespace: name ? `${name}:` : undefined,
      logger: baseLogger.child({ session: name }),
    });
    this.#sessions.set(name, { client, adapter });
    return client;
  }

  /** Create + connect in one call */
  async start(name: string, overrides?: Partial<SasaClientOptions>): Promise<SasaClient> {
    const client = await this.create(name, overrides);
    await client.connect();
    return client;
  }

  /** Gracefully disconnect and drop a session (auth stays persisted) */
  async stop(name: string): Promise<boolean> {
    const entry = this.#sessions.get(name);
    if (!entry) return false;
    await entry.client.dispose().catch(() => undefined);
    this.#sessions.delete(name);
    return true;
  }

  /** Wipe a session's stored auth (fresh pairing on next start) */
  async remove(name: string): Promise<boolean> {
    const stopped = await this.stop(name);
    if (!stopped) return false;
    return true;
  }

  snapshots(): SessionSnapshot[] {
    return [...this.#sessions.entries()].map(([name, { client }]) => ({
      name,
      connected: client.isConnected,
      registered: client.auth?.creds.registered,
      me: client.auth?.creds.me?.id,
      health: client.healthStatus(),
    }));
  }

  /**
   * Session Import — restore a session from an exported envelope into a
   * NEW (not yet created) session namespace.
   */
  async importSession(name: string, serialized: string): Promise<void> {
    if (this.#sessions.has(name)) {
      throw new BaileysError(`session "${name}" already exists — stop it first`, { code: 'ERR_SESSION_EXISTS' });
    }
    const { creds, keys } = importSession(serialized);
    const adapter = this.#opts.adapterFactory(name);
    await adapter.connect?.();
    const ns = name ? `${name}:` : '';
    await adapter.set(`${ns}creds`, creds);
    const writes: Promise<void>[] = [];
    for (const [category, entries] of Object.entries(keys)) {
      if (!entries) continue;
      for (const [id, value] of Object.entries(entries)) {
        if (value !== null && value !== undefined) writes.push(adapter.set(`${ns}${category}:${id}`, value));
      }
    }
    await Promise.all(writes);
    this.#logger.info({ session: name }, 'session imported');
  }

  /** Session Export for a live session */
  async exportSession(name: string): Promise<string> {
    const client = this.#sessions.get(name)?.client;
    if (!client) throw new BaileysError(`unknown session "${name}"`, { code: 'ERR_NO_SESSION' });
    return client.exportSessionEnvelope();
  }

  /** Dispose every session (process shutdown) */
  async disposeAll(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(({ client }) => client.dispose().catch(() => undefined)),
    );
    this.#sessions.clear();
  }
}
