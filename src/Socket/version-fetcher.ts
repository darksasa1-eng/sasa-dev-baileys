import { get as httpsGet } from 'node:https';
import { DEFAULT_HTTP_USER_AGENT, DEFAULT_WA_VERSION, WA_URL_BASE } from '../Defaults/defaults';
import type { WAVersion } from '../Types/versions';
import { compareWAVersion, parseWAVersion } from '../Types/versions';
import type { Logger } from '../Defaults/logger';
import { NOOP_LOGGER } from '../Defaults/logger';

interface VersionCacheEntry {
  version: WAVersion;
  fetchedAt: number;
}

let cache: VersionCacheEntry | undefined;

/**
 * Auto WhatsApp Version Detection.
 *
 * Fetches the current WA web client version from the public web bundle
 * (`sw.js` carries the version in `2.xxxx.y`), caches the result, and falls
 * back to {@link DEFAULT_WA_VERSION} on any failure with an older-version
 * sanity floor (never returns something older than the bundled constant).
 */
export async function fetchLatestWaWebVersion(options: { fetch?: typeof fetch } = {}): Promise<WAVersion> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${WA_URL_BASE}/sw.js`, {
      headers: { 'user-agent': DEFAULT_HTTP_USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    const found = parseWAVersion(body);
    if (found) {
      // sanity floor: never accept an obviously stale parse
      return compareWAVersion(found, DEFAULT_WA_VERSION) >= 0 ? found : DEFAULT_WA_VERSION;
    }
  } catch {
    // fall through to https fallback
  }

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsGet(`${WA_URL_BASE}/sw.js`, { headers: { 'user-agent': DEFAULT_HTTP_USER_AGENT } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    });
    const found = parseWAVersion(body);
    if (found) return compareWAVersion(found, DEFAULT_WA_VERSION) >= 0 ? found : DEFAULT_WA_VERSION;
  } catch {
    // ignore
  }

  return DEFAULT_WA_VERSION;
}

/** Cached fetch (defaults to 6h), preferring {@link fetchLatestWaWebVersion} */
export async function fetchLatestWaWebVersionCached(
  options: { fetch?: typeof fetch; cacheMs?: number; logger?: Logger } = {},
): Promise<WAVersion> {
  const logger = options.logger ?? NOOP_LOGGER;
  const cacheMs = options.cacheMs ?? 6 * 60 * 60 * 1000;
  const now = Date.now();
  if (cache && now - cache.fetchedAt < cacheMs) return cache.version;
  const version = await fetchLatestWaWebVersion({ fetch: options.fetch });
  cache = { version, fetchedAt: now };
  logger.debug({ version: version.join('.') }, 'resolved WA web version');
  return version;
}

export function clearVersionCache(): void {
  cache = undefined;
}
