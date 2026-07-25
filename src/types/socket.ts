export type WALoginMethod = 'qr' | 'pairing_code';

export interface SocketConfig {
  /** WhatsApp multi‑device WebSocket endpoint */
  wsUrl: string;
  /** Auto‑reconnect on unexpected close */
  autoReconnect: boolean;
  /** Max reconnect attempts, -1 for infinite */
  maxReconnectAttempts: number;
  /** Delay between reconnections (ms) */
  reconnectDelay: number;
  /** Keep‑alive interval (ms) */
  keepAliveInterval: number;
  /** Login method */
  loginMethod: WALoginMethod;
}
