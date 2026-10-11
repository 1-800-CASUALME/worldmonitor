import type {
  SearchFactChecksRequest,
  SearchFactChecksResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { sha256Hex } from '../../../_shared/hash';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { CLAIM_MAX_CHARS, claimTokens } from '../../../_shared/claim-match';
import {
  FACT_CHECK_API_KEY_ENV,
  FACT_CHECK_CAVEAT,
  claimCanMatchFactChecks,
  compactApiClaims,
  factCheckSearchUrl,
  selectFactChecks,
  type FactCheckApiClaim,
} from '../../../_shared/fact-checks';

const SEARCH_TIMEOUT_MS = 5_000;
/** Published fact-checks rarely change; a day keeps the free API quota for new claims. */
const SEARCH_CACHE_TTL_S = 24 * 60 * 60;
const USER_AGENT = 'worldmonitor-server/1.0 (fact-checks; +https://www.worldmonitor.app/verify)';

type CachedSearch = { claims: FactCheckApiClaim[] };

/**
 * #9094: ratings IFCN-verified fact-checkers published about claims similar
 * to this one, cited with attribution. The upstream answer is cached by the
 * claim's content words, so "Kyiv struck" and "kyiv struck!" share one entry;
 * matching and the allowlist run on every read, so changing them needs no
 * cache bump. A failed search is `unavailable` and never cached as "none".
 */
export async function searchFactChecks(
  ctx: ServerContext,
  req: SearchFactChecksRequest,
): Promise<SearchFactChecksResponse> {
  const claim = String(req.claim ?? '').trim().slice(0, CLAIM_MAX_CHARS);
  const response: SearchFactChecksResponse = { factChecks: [], state: 'ok', caveat: FACT_CHECK_CAVEAT };
  // Too few content words to match anything strongly: nothing to look up.
  if (!claimCanMatchFactChecks(claim)) return response;

  const apiKey = process.env[FACT_CHECK_API_KEY_ENV];
  if (!apiKey) {
    markNoCacheResponse(ctx.request);
    response.state = 'not-configured';
    return response;
  }

  const cacheKey = `factcheck:search:v1:${await sha256Hex(claimTokens(claim).join(' '))}`;
  let cached: CachedSearch | null;
  try {
    cached = await cachedFetchJson<CachedSearch>(cacheKey, SEARCH_CACHE_TTL_S, async () => {
      const res = await globalThis.fetch(factCheckSearchUrl(claim, apiKey), {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`fact-check search HTTP ${res.status}`);
      return { claims: compactApiClaims(await res.json()) };
    });
  } catch (err) {
    console.warn('[fact-checks] search failed:', err instanceof Error ? err.message : String(err));
    cached = null;
  }
  if (!cached) {
    markNoCacheResponse(ctx.request);
    response.state = 'unavailable';
    return response;
  }
  response.factChecks = selectFactChecks(claim, cached.claims);
  return response;
}
