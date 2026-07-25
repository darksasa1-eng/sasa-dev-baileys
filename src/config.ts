import { SocketConfig } from './types/socket';

export const defaultConfig: SocketConfig = {
  wsUrl: 'wss://web.whatsapp.com/ws/md',
  autoReconnect: true,
  maxReconnectAttempts: -1,
  reconnectDelay: 3000,
  keepAliveInterval: 10000,
  loginMethod: 'qr',
};
