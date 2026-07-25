export interface Credentials {
  clientId: string;
  serverToken: string;
  clientToken: string;
  encKey: Buffer;
  macKey: Buffer;
}

export interface AuthState {
  creds: Credentials;
  /** Multi‑device pre‑keys */
  keys: {
    registrationId: number;
    identityKey: Uint8Array;
    signedPreKey: {
      keyId: number;
      keyPair: KeyPair;
      signature: Uint8Array;
    };
    preKeys: Array<{
      keyId: number;
      keyPair: KeyPair;
    }>;
  };
}

export interface KeyPair {
  public: Uint8Array;
  private: Uint8Array;
}
