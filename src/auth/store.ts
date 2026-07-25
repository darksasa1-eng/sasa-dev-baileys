import { AuthState } from '../types/auth';

export interface IAuthStore {
  load(sessionId: string): Promise<AuthState | null>;
  save(sessionId: string, state: AuthState): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * Default in‑memory store. For production use a persistent store (JSON file, DB, etc.)
 */
export class AuthStore implements IAuthStore {
  private cache = new Map<string, AuthState>();

  async load(sessionId: string): Promise<AuthState | null> {
    return this.cache.get(sessionId) || null;
  }

  async save(sessionId: string, state: AuthState): Promise<void> {
    this.cache.set(sessionId, state);
  }

  async delete(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
  }
}
