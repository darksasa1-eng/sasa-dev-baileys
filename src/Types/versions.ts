/** WhatsApp web protocol triple, e.g. [2, 3000, 1015901307] */
export type WAVersion = readonly [number, number, number];

export function formatWAVersion(version: WAVersion): string {
  return version.join('.');
}

export function parseWAVersion(text: string): WAVersion | undefined {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

export function compareWAVersion(a: WAVersion, b: WAVersion): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
