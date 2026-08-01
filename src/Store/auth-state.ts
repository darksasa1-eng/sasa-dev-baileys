import { initAuthCreds } from '../Auth/init';
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '../Auth/types';
import { AsyncEventQueue } from '../Defaults/queue';
import { KeyedMutex } from '../Defaults/mutex';
import { createLogger, type Logger } from '../Defaults/logger';
import type { StorageAdapter } from './adapter';

export interface UseAuthStateResult {
  state: AuthenticationState;
  /** Persist `state.creds` now (must be called after every mutation) */
  saveCreds: () => Promise<void>;
  /** Wipe everything (logout) */
  clear: () => Promise<void>;
  /** Flush all pending writes and release the adapter */
  disconnect: () => Promise<void>;
}

export interface UseAuthStateOptions {
  /** Key namespace inside the adapter (multi-session isolation) */
  namespace?: string;
  logger?: Logger;
  credsKey?: string;
}

/**
 * Bind an {@link AuthenticationState} to any {@link StorageAdapter}.
 *
 * Guarantee: writes are serialized (single-writer queue) and ordered, so a
 * slower storage backend can never persist an OLDER creds snapshot over a
 * NEWER one — the classic auth corruption bug this design eliminates.
 */
export async function useAuthState(
  adapter: StorageAdapter,
  options: UseAuthStateOptions = {},
): Promise<UseAuthStateResult> {
  const logger = options.logger ?? createLogger({ level: 'warn' });
  const namespace = options.namespace ?? '';
  const credsKey = `${namespace}${options.credsKey ?? 'creds'}`;
  const keyPrefix = (category: string, id: string): string => `${namespace}${category}:${id}`;

  await adapter.connect?.();

  const writeQueue = new AsyncEventQueue({ maxPending: 100_000 });
  const mutex = new KeyedMutex();

  let creds: AuthenticationCreds;
  const existing = await adapter.get<AuthenticationCreds>(credsKey);
  if (existing) {
    creds = existing;
  } else {
    creds = initAuthCreds();
    await adapter.set(credsKey, creds);
    logger.info('initialized new device credentials');
  }

  const keys: AuthenticationState['keys'] = {
    async get<T extends keyof SignalDataTypeMap>(
      type: T,
      ids: string[],
    ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      await Promise.all(
        ids.map(async (id) => {
          const value = await adapter.get<SignalDataTypeMap[T]>(keyPrefix(type, id));
          if (value !== undefined && value !== null) out[id] = value;
        }),
      );
      return out;
    },

    async set(data: SignalDataSet): Promise<void> {
      // Coalesce a whole SignalDataSet into one queued storage sweep.
      await writeQueue.enqueue(async () => {
        const tasks: Promise<void>[] = [];
        for (const [category, entries] of Object.entries(data)) {
          if (!entries) continue;
          for (const [id, value] of Object.entries(entries)) {
            tasks.push(
              value === null ? adapter.delete(keyPrefix(category, id)) : adapter.set(keyPrefix(category, id), value),
            );
          }
        }
        await Promise.all(tasks);
      });
    },

    transaction<T>(exec: () => Promise<T>, key: string): Promise<T> {
      return mutex.exclusive(`keys:${key}`, exec);
    },
  };

  const saveCreds = (): Promise<void> => writeQueue.enqueue(() => adapter.set(credsKey, creds));

  const clear = async (): Promise<void> => {
    await writeQueue.enqueue(async () => {
      if (adapter.clear) {
        await adapter.clear();
      } else {
        const allKeys = await adapter.keys(namespace);
        await Promise.all(allKeys.map((k) => adapter.delete(k)));
      }
    });
  };

  const disconnect = async (): Promise<void> => {
    await writeQueue.drain();
    await adapter.close?.();
  };

  return { state: { creds, keys }, saveCreds, clear, disconnect };
}
