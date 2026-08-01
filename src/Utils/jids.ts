import { randomBytes } from 'node:crypto';

/**
 * JID (Jabber ID) helpers — WhatsApp addressing.
 */

export const S_WHATSAPP_NET = 's.whatsapp.net';
export const GROUP_JID_SERVER = 'g.us';
export const BROADCAST_SERVER = 'broadcast';
export const NEWSLETTER_SERVER = 'newsletter';
export const LID_SERVER = 'lid';
export const HOSTED_SERVER = 'hosted';
export const HOSTED_LID_SERVER = 'hosted.lid';
export const STATUS_JID = `status@${BROADCAST_SERVER}`;
export const OFFICIAL_BIZ_JID = '16505361212@c.us';

/** Domain types used by the `AD_JID` wire encoding */
export enum WAJIDDomains {
  WHATSAPP = 0,
  LID = 1,
  HOSTED = 128,
  HOSTED_LID = 129,
}

export interface FullJid {
  /** Phone number / user portion */
  user: string;
  /** JID server, e.g. `s.whatsapp.net`, `g.us`, `lid` */
  server: string;
  /** Companion device id (multi-device); 0/undefined = primary */
  device?: number;
  /** Agent id (rare; 0/undefined = none) */
  agent?: number;
  /** Presence domain for `@lid` / `@hosted` style jids */
  domainType?: number;
}

/** Resolve a wire `domainType` to its JID server name */
export function getServerFromDomainType(initialServer: string, domainType: number): string {
  switch (domainType) {
    case WAJIDDomains.LID:
      return LID_SERVER;
    case WAJIDDomains.HOSTED:
      return HOSTED_SERVER;
    case WAJIDDomains.HOSTED_LID:
      return HOSTED_LID_SERVER;
    default:
      return initialServer;
  }
}

/** Resolve a JID server to its wire `domainType` */
export function getDomainTypeFromServer(server: string): number {
  switch (server) {
    case LID_SERVER:
      return WAJIDDomains.LID;
    case HOSTED_SERVER:
      return WAJIDDomains.HOSTED;
    case HOSTED_LID_SERVER:
      return WAJIDDomains.HOSTED_LID;
    default:
      return WAJIDDomains.WHATSAPP;
  }
}

/**
 * Build a JID string. `user` should be the plain number; device/agent are
 * passed explicitly.
 */
export function jidEncode(
  user: string | number | undefined,
  server: string = S_WHATSAPP_NET,
  device?: number,
  agent?: number,
): string {
  const agentPart = agent ? `_${agent}` : '';
  const devicePart = device ? `:${device}` : '';
  return `${user ?? ''}${agentPart}${devicePart}@${server}`;
}

/**
 * Split a JID into its components. Returns `undefined` for malformed input —
 * never throws, because JIDs arrive from the network.
 */
export function jidDecode(jid: string | undefined | null): FullJid | undefined {
  if (!jid || typeof jid !== 'string') return undefined;
  const sepIdx = jid.indexOf('@');
  if (sepIdx < 0) return undefined;

  const server = jid.slice(sepIdx + 1);
  const userCombined = jid.slice(0, sepIdx);
  if (!server) return undefined;

  // Order matters: strip ":device" first, then "_agent".
  const [userAgent = '', deviceStr] = userCombined.split(':');
  const [user = '', agentStr] = userAgent.split('_');

  const device = deviceStr !== undefined && deviceStr !== '' ? Number(deviceStr) : undefined;
  const agent = agentStr !== undefined && agentStr !== '' ? Number(agentStr) : undefined;

  let domainType: number | undefined;
  if (server === LID_SERVER) domainType = WAJIDDomains.LID;
  else if (server === HOSTED_SERVER) domainType = WAJIDDomains.HOSTED;
  else if (server === HOSTED_LID_SERVER) domainType = WAJIDDomains.HOSTED_LID;
  else if (agent !== undefined && Number.isFinite(agent)) domainType = agent;

  return {
    user,
    server,
    device: device !== undefined && Number.isFinite(device) ? device : undefined,
    agent: agent !== undefined && Number.isFinite(agent) ? agent : undefined,
    domainType,
  };
}

/** True when two JIDs refer to the same account, ignoring device/agent */
export function areJidsSameUser(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const da = jidDecode(a);
  const db = jidDecode(b);
  if (!da || !db) return false;
  return da.user === db.user && da.server === db.server;
}

/** Strip device/agent info: `123:4@s.whatsapp.net` → `123@s.whatsapp.net` */
export function jidNormalizedUser(jid: string | undefined): string {
  const decoded = jidDecode(jid);
  if (!decoded) return '';
  return jidEncode(decoded.user, decoded.server);
}

export function isJidUser(jid: string | undefined): boolean {
  return jidDecode(jid)?.server === S_WHATSAPP_NET;
}

export function isLidUser(jid: string | undefined): boolean {
  return jidDecode(jid)?.server === LID_SERVER;
}

export function isJidGroup(jid: string | undefined): boolean {
  return jidDecode(jid)?.server === GROUP_JID_SERVER;
}

export function isJidBroadcast(jid: string | undefined): boolean {
  return jidDecode(jid)?.server === BROADCAST_SERVER && jid !== STATUS_JID;
}

export function isJidStatusBroadcast(jid: string | undefined): boolean {
  return jid === STATUS_JID;
}

export function isJidNewsletter(jid: string | undefined): boolean {
  return jidDecode(jid)?.server === NEWSLETTER_SERVER;
}

/** Extract international-format phone digits from a user JID */
export function jidToPhoneNumber(jid: string | undefined): string {
  const decoded = jidDecode(jid);
  return decoded ? decoded.user.replace(/\D/g, '') : '';
}

/**
 * Generate a WA-compatible group JID (timestamp + random hex suffix).
 */
export function generateGroupJid(): string {
  const rand = randomBytes(8).toString('hex');
  return `${Date.now()}${rand}@${GROUP_JID_SERVER}`;
}
