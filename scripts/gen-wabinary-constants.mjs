import { TAGS, SINGLE_BYTE_TOKENS, DOUBLE_BYTE_TOKENS } from '/tmp/ref/package/lib/WABinary/constants.js';
import fs from 'node:fs';

const header = `/**
 * WhatsApp Web binary-protocol wire constants (token dictionaries + tags).
 *
 * Token dictionary data is adapted from the MIT-licensed Baileys project
 * (https://github.com/WhiskeySockets/Baileys), Copyright (c) WhiskeySockets
 * contributors. Used under the MIT license; see NOTICE.
 *
 * Generated — do not hand edit. Regenerate with scripts/gen-wabinary-constants.mjs
 */
`;

const ts = `${header}
export const TAGS = ${JSON.stringify(TAGS, null, 2).replace(/"([A-Z_0-9]+)":/g, '$1:')} as const;

export type TagName = keyof typeof TAGS;

export const SINGLE_BYTE_TOKENS: readonly string[] = ${JSON.stringify(SINGLE_BYTE_TOKENS)};

export const DOUBLE_BYTE_TOKENS: readonly (readonly string[])[] = ${JSON.stringify(DOUBLE_BYTE_TOKENS)};

/** Reverse lookup: token string → single-byte index or (dict, index) pair */
export const TOKEN_MAP: Readonly<Record<string, { index: number } | { dict: number; index: number }>> = (() => {
  const map: Record<string, { index: number } | { dict: number; index: number }> = {};
  SINGLE_BYTE_TOKENS.forEach((token, index) => {
    map[token] = { index };
  });
  DOUBLE_BYTE_TOKENS.forEach((dictTokens, dict) => {
    dictTokens.forEach((token, index) => {
      map[token] = { dict, index };
    });
  });
  return map;
})();
`;
fs.writeFileSync('/home/user/sasa-dev-baileys/src/WABinary/constants.ts', ts);
console.log('written', SINGLE_BYTE_TOKENS.length, 'single tokens,', DOUBLE_BYTE_TOKENS.flat().length, 'double tokens');
