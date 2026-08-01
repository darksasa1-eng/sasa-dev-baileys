import { BaileysError } from '../Defaults/errors';
import { sha256 } from '../Signal/crypto';
import { BufferJSON } from '../Utils/buffer-json';
import type { AuthenticationCreds, SignalDataSet } from './types';

/**
 * Session export / import — move a registered session between processes or
 * machines without re-pairing.
 *
 * Format (v2): base64url( BufferJSON({ v, kind, creds, keys }) ) + '.' +
 * first 16 chars of the hex SHA-256 of the payload (corruption guard).
 */

const SESSION_KIND = 'sasa-baileys-session';
const SESSION_VERSION = 2;

export interface ExportedSession {
  v: number;
  kind: string;
  exportedAt: number;
  creds: AuthenticationCreds;
  keys: SignalDataSet;
}

export function exportSession(creds: AuthenticationCreds, keys: SignalDataSet): string {
  const payload: ExportedSession = {
    v: SESSION_VERSION,
    kind: SESSION_KIND,
    exportedAt: Date.now(),
    creds,
    keys,
  };
  const body = Buffer.from(BufferJSON.stringify(payload), 'utf-8').toString('base64url');
  const checksum = Buffer.from(sha256(Buffer.from(body, 'utf-8'))).toString('hex').slice(0, 16);
  return `${body}.${checksum}`;
}

export function importSession(serialized: string): { creds: AuthenticationCreds; keys: SignalDataSet } {
  const [body, checksum] = serialized.split('.');
  if (!body || !checksum) {
    throw new BaileysError('invalid session format (expected payload.checksum)', { code: 'ERR_SESSION_FORMAT' });
  }
  const actual = Buffer.from(sha256(Buffer.from(body, 'utf-8'))).toString('hex').slice(0, 16);
  if (actual !== checksum) {
    throw new BaileysError('session checksum mismatch — data is corrupt or tampered', {
      code: 'ERR_SESSION_CHECKSUM',
    });
  }
  let payload: ExportedSession;
  try {
    payload = BufferJSON.parse<ExportedSession>(Buffer.from(body, 'base64url').toString('utf-8'));
  } catch (err) {
    throw new BaileysError('session payload is not valid BufferJSON', { code: 'ERR_SESSION_JSON', cause: err });
  }
  if (payload.kind !== SESSION_KIND || payload.v !== SESSION_VERSION) {
    throw new BaileysError(`unsupported session (kind=${payload.kind}, v=${payload.v})`, {
      code: 'ERR_SESSION_VERSION',
    });
  }
  if (!payload.creds?.noiseKey || !payload.creds?.signedIdentityKey) {
    throw new BaileysError('session payload is missing credential material', { code: 'ERR_SESSION_CREDS' });
  }
  return { creds: payload.creds, keys: payload.keys ?? {} };
}

/**
 * Collect every key of a store into a {@link SignalDataSet}
 * (used by session export; store must expose key listings).
 */
const CATEGORIES = ['pre-key', 'session', 'sender-key', 'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version'] as const;

export async function collectSignalDataSet(
  listKeys: (prefix?: string) => Promise<string[]>,
  getKey: (key: string) => Promise<unknown>,
  namespace = '',
): Promise<SignalDataSet> {
  const out: SignalDataSet = {};
  await adapterNamespaceScan(namespace, listKeys, getKey, out);
  return out;
}

async function adapterNamespaceScan(
  namespace: string,
  listKeys: (prefix?: string) => Promise<string[]>,
  getKey: (key: string) => Promise<unknown>,
  out: SignalDataSet,
): Promise<void> {
  for (const category of CATEGORIES) {
    const prefix = `${namespace}${category}:`;
    const keys = await listKeys(prefix);
    if (keys.length === 0) continue;
    const entries: Record<string, unknown> = {};
    for (const fullKey of keys) {
      const id = fullKey.slice(prefix.length);
      entries[id] = await getKey(fullKey);
    }
    (out as Record<string, Record<string, unknown>>)[category] = entries;
  }
}
