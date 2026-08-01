/**
 * Authentication & signal key-store types.
 */

export interface KeyPair {
  /** Public key bytes (32 bytes for Curve25519) */
  publicKey: Uint8Array;
  /** Private key bytes (32 bytes) */
  privateKey: Uint8Array;
}

export interface SignedKeyPair {
  keyId: number;
  keyPair: KeyPair;
  /** Signature of `keyPair.publicKey` produced with the identity key */
  signature: Uint8Array;
}

export interface PreKey {
  keyId: number;
  keyPair: KeyPair;
}

export interface SignedPreKey extends PreKey {
  signature: Uint8Array;
}

/** Ephemeral key material used by the MD noise handshake */
export interface NoiseKeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

/** LTPS keys used to validate companion pairing payloads */
export interface AdvKeyPair {
  private: Uint8Array;
  public: Uint8Array;
}

export interface AdvSignedIdentity {
  raw: Uint8Array;
  host: Uint8Array;
}

export interface AccountSignature {
  signature: Uint8Array;
  details: Uint8Array;
}

/**
 * Long-lived authentication credentials for one multi-device session.
 */
export interface AuthenticationCreds {
  /** Noise handshake static key pair */
  noiseKey: KeyPair;
  /** Curve key with which this device proves its identity during pairing */
  pairingEphemeralKeyPair: KeyPair;
  /** Long-term identity key */
  signedIdentityKey: KeyPair;
  /** Signed pre-key advertised to the server */
  signedPreKey: SignedKeyPair;
  /** 14-bit registration id */
  registrationId: number;
  /** Device advertisement identity key (ADV) */
  advSecretKey: string;

  processedHistoryItems: unknown[];
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;
  accountSyncCounter: number;
  accountSettings: { unarchiveChats: boolean };

  /** Set after successful pairing */
  registered?: boolean;
  /** "Companion device" id assigned at pairing */
  pairingCode?: string;
  /** Last known companion-public key */
  lastPropHash?: string;
  routingInfo?: Uint8Array;

  /** Account JID (`...:device@s.whatsapp.net`), assigned post-pair */
  me?: { id: string; lid?: string; name?: string };
  /** Companion account details */
  account?: {
    details?: string;
    accountSignatureKey?: string;
    accountSignature?: string;
    deviceSignature?: string;
  };
  signalIdentities?: { identifier: { name: string; deviceId: number }; identifierKey: { publicKey: string } }[];
  platform?: string;
  /** Server-assigned id used to request QR refs pre-login */
  registration?: {
    phoneNumber?: string;
    phoneNumberCountryCode?: string;
    phoneNumberNationalNumber?: string;
    phoneNumberMobileCountryCode?: string;
    phoneNumberMobileNetworkCode?: string;
    method?: 'sms' | 'voice' | 'captcha';
  };
}

/**
 * Complete auth state consumed by the socket: long-lived creds + the
 * libsignal key store.
 */
export interface AuthenticationState {
  creds: AuthenticationCreds;
  keys: SignalKeyStoreWithTransaction;
}

/** Categories of signal data addressed by `${type}:${id}` keys */
export interface SignalDataTypeMap {
  'pre-key': KeyPair;
  session: Uint8Array;
  'sender-key': Uint8Array;
  'sender-key-memory': { [jid: string]: boolean };
  'app-state-sync-key': LTHashState;
  'app-state-sync-version': Uint8Array;
}

export interface LTHashState {
  version: number;
  hash: Uint8Array;
  indexValueMap: { [indexMacBase64: string]: { valueMac: Uint8Array } };
}

export type SignalDataSet = {
  [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null };
};

/**
 * Transaction-capable signal key store.
 *
 * `transaction` implementations must ensure concurrent transactions on the
 * same store instance cannot interleave (a keyed mutex is the classic way).
 */
export interface SignalKeyStore {
  get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]): Promise<{ [id: string]: SignalDataTypeMap[T] }>;
  set(data: SignalDataSet): Promise<void>;
}

export type TransactionCapableStore = SignalKeyStore & {
  transaction<T>(exec: () => Promise<T>, key: string): Promise<T>;
};

export interface SignalKeyStoreWithTransaction extends SignalKeyStore {
  transaction<T>(exec: () => Promise<T>, key: string): Promise<T>;
}
