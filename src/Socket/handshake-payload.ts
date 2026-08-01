import { ProtoWriter, readFields, getFieldBytes, getFieldVarint } from '../Signal/proto-wire';
import type { WABrowserDescription } from '../Types/config';
import type { WAVersion } from '../Types/versions';

/**
 * Handshake payload (client hello / finish) construction.
 *
 * Field numbering for the inner ClientHello/UserAgent structs follows the
 * long-stable WA `HandshakeMessage` layout. Everything is built with the
 * in-house proto-wire codec — no protobuf runtime dependency.
 */

export interface UserAgentSpec {
  platform: number;
  appVersion: { primary: number; secondary: number; tertiary: number };
  mcc: string;
  mnc: string;
  osVersion: string;
  manufacturer: string;
  device: string;
  osBuildNumber: string;
  releaseChannel: number;
  localeLanguageIso6391: string;
  localeCountryIso31661Alpha2: string;
  deviceType?: string;
}

export interface ClientHelloSpec {
  userAgent: UserAgentSpec;
  webInfo?: { webSubPlatform: number };
}

export interface ClientFinishSpec {
  /** Account device signature material (opaque bytes, pairing scope) */
  static?: Uint8Array;
  payload?: Uint8Array;
}

function encodeUserAgent(spec: UserAgentSpec): Uint8Array {
  const appVersion = new ProtoWriter()
    .varint(1, spec.appVersion.primary)
    .varint(2, spec.appVersion.secondary)
    .varint(3, spec.appVersion.tertiary)
    .finish();
  return new ProtoWriter()
    .varint(1, spec.platform)
    .bytes(2, appVersion)
    .bytes(3, new TextEncoder().encode(spec.mcc))
    .bytes(4, new TextEncoder().encode(spec.mnc))
    .bytes(5, new TextEncoder().encode(spec.osVersion))
    .bytes(6, new TextEncoder().encode(spec.manufacturer))
    .bytes(7, new TextEncoder().encode(spec.device))
    .bytes(8, new TextEncoder().encode(spec.osBuildNumber))
    .varint(9, spec.releaseChannel)
    .bytes(10, new TextEncoder().encode(spec.localeLanguageIso6391))
    .bytes(11, new TextEncoder().encode(spec.localeCountryIso31661Alpha2))
    .finish();
}

function encodeWebInfo(subPlatform: number): Uint8Array {
  return new ProtoWriter().varint(1, subPlatform).finish();
}

function encodeClientHello(spec: ClientHelloSpec): Uint8Array {
  const w = new ProtoWriter().bytes(1, encodeUserAgent(spec.userAgent));
  if (spec.webInfo) w.bytes(2, encodeWebInfo(spec.webInfo.webSubPlatform));
  return w.finish();
}

function encodeClientFinish(spec: ClientFinishSpec): Uint8Array {
  const w = new ProtoWriter();
  if (spec.static) w.bytes(1, spec.static);
  if (spec.payload) w.bytes(2, spec.payload);
  return w.finish();
}

/** HandshakeMessage { clientHello: 1 | serverHello: 2 | clientFinish: 3 } */
export function encodeHandshakeClientHello(spec: ClientHelloSpec): Uint8Array {
  return new ProtoWriter().bytes(1, encodeClientHello(spec)).finish();
}

export function encodeHandshakeClientFinish(spec: ClientFinishSpec): Uint8Array {
  return new ProtoWriter().bytes(3, encodeClientFinish(spec)).finish();
}

export interface ParsedServerHello {
  ephemeral?: Uint8Array;
  static?: Uint8Array;
  payload?: Uint8Array;
}

export function parseHandshakePayload(data: Uint8Array): {
  clientHello?: unknown;
  serverHello?: ParsedServerHello;
  clientFinish?: unknown;
} {
  const fields = readFields(data);
  const helloBytes = getFieldBytes(fields, 2);
  if (!helloBytes) return {};
  const inner = readFields(helloBytes);
  return {
    serverHello: {
      ephemeral: getFieldBytes(inner, 1),
      static: getFieldBytes(inner, 2),
      payload: getFieldBytes(inner, 3),
    },
  };
}

/** Default user agent derived from browser identity + WA version */
export function makeUserAgent(browser: WABrowserDescription, version: WAVersion): UserAgentSpec {
  const [, clientName, clientVersion] = browser;
  const [primary = 0, secondary = 0, tertiary = 0] = clientVersion.split('.').map((s) => Number(s) || 0);
  return {
    // 12 = SMB_BUSINESS/CONSUMER Chrome aliases vary; 2 = DESKTOP
    platform: 2,
    appVersion: { primary: version[0], secondary: version[1], tertiary: version[2] },
    mcc: '000',
    mnc: '000',
    osVersion: `${primary}.${secondary}.${tertiary}`,
    manufacturer: 'Microsoft' === clientName ? 'Microsoft' : 'Google',
    device: 'Desktop',
    osBuildNumber: `${clientName} ${clientVersion}`,
    releaseChannel: 0,
    localeLanguageIso6391: 'en',
    localeCountryIso31661Alpha2: 'US',
  };
}

export function varintOrZero(
  values: { fieldNumber: number; wireType: number; varint?: number }[],
  num: number,
): number {
  return getFieldVarint(values, num) ?? 0;
}
