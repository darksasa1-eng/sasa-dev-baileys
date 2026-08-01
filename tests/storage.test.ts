import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonStorageAdapter } from '../src/Store/adapters/json';
import { FileStorageAdapter } from '../src/Store/adapters/file';
import { MemoryStorageAdapter } from '../src/Store/adapters/memory';
import { useAuthState } from '../src/Store/auth-state';
import { validateCreds } from '../src/Auth/creds-utils';
import { initAuthCreds } from '../src/Auth/init';
import { BaileysError } from '../src/Defaults/errors';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sasa-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('json storage adapter', () => {
  it('persists values atomically and reloads', async () => {
    const file = join(dir, 's.json');
    const a = new JsonStorageAdapter(file, { flushIntervalMs: 1 });
    await a.set('k1', { n: 1, buf: new Uint8Array([9, 8]) });
    await a.set('k2', 'plain');
    await a.flush();

    const b = new JsonStorageAdapter(file);
    expect(await b.get<{ n: number; buf: Uint8Array }>('k1')).toMatchObject({ n: 1 });
    const v = await b.get<{ buf: Uint8Array }>('k1');
    expect(v?.buf?.[0]).toBe(9);
    expect(await b.get('k2')).toBe('plain');
    expect(await b.keys('k')).toEqual(expect.arrayContaining(['k1', 'k2']));
    await b.delete('k2');
    await b.flush();
    await b.close();
    expect(await new JsonStorageAdapter(file).get('k2')).toBeUndefined();
  });

  it('starts empty when file missing or corrupt', async () => {
    const file = join(dir, 'missing', 's.json');
    const a = new JsonStorageAdapter(file);
    expect(await a.get('anything')).toBeUndefined();
    await a.close();
  });
});

describe('file storage adapter', () => {
  it('round trips and recovers logical keys exactly', async () => {
    const a = new FileStorageAdapter(join(dir, 'files'));
    await a.connect();
    await a.set('session:41789996011-5.0', { root: 1 });
    await a.set('session:41789996011:6.3', { root: 2 });
    const keys = await a.keys('session:');
    expect(keys.sort()).toEqual(['session:41789996011-5.0', 'session:41789996011:6.3'].sort());
    expect(await a.get<{ root: number }>('session:41789996011:6.3')).toEqual({ root: 2 });
    await a.clear();
    expect(await a.keys()).toEqual([]);
  });
});

describe('memory adapter', () => {
  it(' CRUD + prefixes', async () => {
    const a = new MemoryStorageAdapter();
    await a.set('a:1', 1);
    await a.set('b:1', 2);
    expect(await a.keys('a:')).toEqual(['a:1']);
    await a.clear();
    expect(await a.keys()).toEqual([]);
  });
});

describe('auth state over adapters', () => {
  it('initializes creds when empty, persists across instances', async () => {
    const file = join(dir, 'auth.json');
    const s1 = await useAuthState(new JsonStorageAdapter(file, { flushIntervalMs: 1 }));
    validateCreds(s1.state.creds);
    s1.state.creds.me = { id: '123:1@s.whatsapp.net' };
    await s1.saveCreds();
    await s1.disconnect();

    const s2 = await useAuthState(new JsonStorageAdapter(file));
    expect(s2.state.creds.me?.id).toBe('123:1@s.whatsapp.net');
    await s2.disconnect();
  });

  it('persists signal keys with binary intact', async () => {
    const file = join(dir, 'auth2.json');
    const s1 = await useAuthState(new JsonStorageAdapter(file, { flushIntervalMs: 1 }));
    await s1.state.keys.set({ session: { '123-0.0': new Uint8Array([1, 2, 3, 4]) } });
    await s1.disconnect();
    const s2 = await useAuthState(new JsonStorageAdapter(file));
    const got = await s2.state.keys.get('session', ['123-0.0']);
    expect([...(got['123-0.0'] ?? [])]).toEqual([1, 2, 3, 4]);
    await s2.disconnect();
  });

  it('clear() wipes the namespace', async () => {
    const file = join(dir, 'auth3.json');
    const s = await useAuthState(new JsonStorageAdapter(file, { flushIntervalMs: 1 }));
    await s.state.keys.set({ session: { x: new Uint8Array([1]) } });
    await s.clear();
    const s2 = await useAuthState(new JsonStorageAdapter(file));
    expect(Object.keys(await s2.state.keys.get('session', ['x']))).toEqual([]);
    await s2.disconnect();
  });
});

describe('credential validation', () => {
  it('accepts freshly initialized creds', () => {
    expect(() => validateCreds(initAuthCreds())).not.toThrow();
  });

  it('rejects garbage with a typed error enumerating problems', () => {
    expect(() => validateCreds({ noiseKey: {} })).toThrow(BaileysError);
    try {
      validateCreds({ noiseKey: {} });
    } catch (err) {
      expect((err as BaileysError).code).toBe('ERR_INVALID_CREDS');
      expect((err as BaileysError).data.problems).toBeInstanceOf(Array);
    }
  });
});
