import type {
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStoreWithTransaction,
  TransactionCapableStore,
} from '../../Auth/types';
import { KeyedMutex } from '../../Defaults/mutex';

/**
 * Transaction-wrapped in-memory signal key store. Acts as both the default
 * store and the canonical implementation used to adapt persistent
 * {@link import('../../Store/storage').StorageAdapter}s into a
 * transaction-capable store.
 */
export class InMemorySignalKeyStore implements SignalKeyStoreWithTransaction {
  #data = new Map<string, unknown>();
  #mutex = new KeyedMutex();

  async get<T extends keyof SignalDataTypeMap>(
    type: T,
    ids: string[],
  ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
    const out: { [id: string]: SignalDataTypeMap[T] } = {};
    for (const id of ids) {
      const value = this.#data.get(`${type}:${id}`);
      if (value !== undefined && value !== null) out[id] = value as SignalDataTypeMap[T];
    }
    return out;
  }

  async set(data: SignalDataSet): Promise<void> {
    for (const [type, entries] of Object.entries(data)) {
      if (!entries) continue;
      for (const [id, value] of Object.entries(entries)) {
        const key = `${type}:${id}`;
        if (value === null) this.#data.delete(key);
        else this.#data.set(key, value);
      }
    }
  }

  transaction<T>(exec: () => Promise<T>, key: string): Promise<T> {
    return this.#mutex.exclusive(`tx:${key}`, exec);
  }

  get size(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }
}

/**
 * Wrap any plain {@link SignalKeyStoreWithTransaction | SignalKeyStore} so
 * that concurrent `transaction()` calls on the same key serialize, even if
 * the underlying store has no native transaction support.
 */
export function addTransactionCapability(store: {
  get: TransactionCapableStore['get'];
  set: TransactionCapableStore['set'];
  transaction?: TransactionCapableStore['transaction'];
}): TransactionCapableStore {
  if (typeof store.transaction === 'function') return store as TransactionCapableStore;
  const mutex = new KeyedMutex();
  return {
    get: store.get.bind(store),
    set: store.set.bind(store),
    transaction: <T>(exec: () => Promise<T>, key: string) => mutex.exclusive<T>(`tx:${key}`, exec),
  };
}
