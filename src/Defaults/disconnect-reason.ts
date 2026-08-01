/**
 * WhatsApp stream error / disconnect reason codes.
 *
 * These map the numeric codes sent by WhatsApp in `<stream:error>` nodes and
 * the WebSocket close codes used while tearing down a session.
 */
export enum DisconnectReason {
  /** The connection was intentionally closed by either side */
  connectionClosed = 428,
  /** The connection to the WS server was lost (network drop) */
  connectionLost = 408,
  /** The connection must be replaced (another host took over, etc.) */
  connectionReplaced = 440,
  /** The socket was idle for too long */
  timedOut = 408 + 0, // alias kept for backwards compat with WA semantics
  /** The session was logged out (credentials invalid / device removed) */
  loggedOut = 401,
  /** A stream error with an unknown code was received */
  unknownError = 500,
  /** The service requires the client to restart the session flow */
  restartRequired = 515,
  /** The client was asked to switch servers on the next connect */
  unavailableService = 503,
  /** Too many sessions were open */
  multideviceMismatch = 411,
  /** Client is too old / forbidden */
  forbidden = 403,
  /** Bad session data received */
  badSession = 500 + 1,
  /** Experimental: not fully paired */
  notPaired = 401 + 1,
}

/** Reason codes that mean "do not attempt implicit reconnect with old creds" */
const FATAL_CODES = new Set<number>([
  DisconnectReason.loggedOut,
  DisconnectReason.forbidden,
  DisconnectReason.connectionReplaced,
]);

/** Reason codes that indicate the socket died and a reconnect is required */
const RETRYABLE_CODES = new Set<number>([
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionLost,
  DisconnectReason.restartRequired,
  DisconnectReason.unavailableService,
  DisconnectReason.timedOut,
  DisconnectReason.unknownError,
]);

export function isFatalDisconnect(code: number | undefined): boolean {
  return code !== undefined && FATAL_CODES.has(code);
}

export function isRetryableDisconnect(code: number | undefined): boolean {
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/** Human readable label for a disconnect code */
export function disconnectReasonLabel(code: number | undefined): string {
  if (code === undefined) return 'unknown';
  const found = Object.entries(DisconnectReason).find(
    ([key, value]) => typeof value === 'number' && value === code && Number.isNaN(Number(key)),
  );
  return found ? found[0] : `code_${code}`;
}
