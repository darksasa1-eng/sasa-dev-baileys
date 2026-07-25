import { BaileysClient } from '../client';
import { AuthState, Credentials } from '../types/auth';
import { AuthStore } from './store';
import { v4 as uuidv4 } from 'uuid';
import { PairingHelper } from './pairing';

export class AuthManager {
  private client: BaileysClient;
  private store: AuthStore;
  private state: AuthState | null = null;

  constructor(client: BaileysClient) {
    this.client = client;
    this.store = new AuthStore(); // can be replaced with custom store
  }

  async loadSession(sessionId?: string): Promise<AuthState | null> {
    const id = sessionId || 'default';
    const data = await this.store.load(id);
    if (data) {
      this.state = data;
      return data;
    }
    return null;
  }

  async createSession(): Promise<AuthState> {
    // Generate new keys (simplified)
    const state: AuthState = {
      creds: {
        clientId: uuidv4(),
        serverToken: '',
        clientToken: '',
        encKey: Buffer.alloc(32),
        macKey: Buffer.alloc(32),
      },
      keys: {
        registrationId: Math.floor(Math.random() * 16384),
        identityKey: new Uint8Array(32),
        signedPreKey: {
          keyId: 1,
          keyPair: { public: new Uint8Array(32), private: new Uint8Array(32) },
          signature: new Uint8Array(64),
        },
        preKeys: [],
      },
    };
    this.state = state;
    await this.store.save('default', state);
    return state;
  }

  async saveSession(sessionId?: string) {
    if (!this.state) return;
    await this.store.save(sessionId || 'default', this.state);
  }

  getCredentials(): Credentials | undefined {
    return this.state?.creds;
  }

  // Pairing code helper
  async startPairing(phoneNumber: string): Promise<string> {
    return new PairingHelper(this.client).requestCode(phoneNumber);
  }
}
