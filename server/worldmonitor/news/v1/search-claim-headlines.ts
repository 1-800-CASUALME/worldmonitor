import type {
  ClaimHeadline,
  SearchClaimHeadlinesRequest,
  SearchClaimHeadlinesResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import type { NewsItemCore } from '../../../../shared/news-clustering-core.js';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { readRevokedUrlSet } from '../../../_shared/digest-revocations';
import { markNoCacheResponse } from '../../../_shared/response-headers';
import { CLAIM_MAX_CHARS, claimCandidates } from '../../../_shared/claim-match';
import { INTEL_SOURCES, isServerFeedReachableForLanguage, VARIANT_FEEDS } from './_feeds';
import { FUTURE_DATE_TOLERANCE_MS, resolveMaxAgeMs, rssFeedCacheKey } from './_rss-cache';

/**
 * #9092 follow-up: /verify and verify_claim searched only the served digest,
 * which keeps five items per feed and twenty per category (about 280
 * headlines). This searches every fresh headline the full-variant RSS caches
 * hold, including the entries kept past the dashboard cap, and returns the
 * ones worth clustering for the claim. The card is still built by
 * buildClaimCard, in the browser and in the MCP tool alike.
 */

/** Headlines read from the feed caches, shared by every claim this isolate serves for a short while. */
type ClaimPool = {
  readonly items: NewsItemCore[];
  readonly feedTotal: number;
  readonly feedCached: number;
  readonly readable: boolean;
  readonly readAt: number;
};

const POOL_TTL_MS = 120_000;
let pool: { at: number; promise: Promise<ClaimPool> } | null = null;

function poolItem(value: unknown, source: string, now: number, cutoff: number, revoked: ReadonlySet<string>): NewsItemCore | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.source !== source || typeof row.title !== 'string') return null;
  const title = row.title.replace(/\s+/g, ' ').trim();
  if (!title || title.length > 1000) return null;
  if (typeof row.publishedAt !== 'number' || !Number.isFinite(row.publishedAt)
    || row.publishedAt < cutoff || row.publishedAt > now + FUTURE_DATE_TOLERANCE_MS) return null;
  // Links were gated at ingest (#8398); a blanked or non-http one stays empty.
  const link = typeof row.link === 'string' && /^https?:\/\//i.test(row.link) && row.link.length <= 2048 ? row.link : '';
  if (link && revoked.has(link)) return null;
  return { source, title, link, pubDate: new Date(row.publishedAt), isAlert: false };
}

async function readPool(): Promise<ClaimPool> {
  const feeds = [...Object.values(VARIANT_FEEDS.full ?? {}).flat(), ...INTEL_SOURCES]
    .filter(feed => isServerFeedReachableForLanguage(feed, 'en'));
  const unique = [...new Map(feeds.map(feed => [rssFeedCacheKey('full', feed.url), feed])).entries()];
  const now = Date.now();
  const [cached, revoked] = await Promise.all([getCachedJsonBatch(unique.map(([key]) => key)), readRevokedUrlSet()]);
  if (!revoked.readable) return { items: [], feedTotal: unique.length, feedCached: 0, readable: false, readAt: now };
  const cutoff = now - resolveMaxAgeMs();
  const items: NewsItemCore[] = [];
  const seen = new Set<string>();
  let feedCached = 0;
  for (const [key, feed] of unique) {
    const entry = cached.get(key);
    if (!entry || typeof entry !== 'object' || !('items' in entry) || !Array.isArray(entry.items)) continue;
    feedCached++;
    const rows = 'countryItems' in entry && Array.isArray(entry.countryItems)
      ? [...entry.items, ...entry.countryItems] : entry.items;
    for (const value of rows) {
      const item = poolItem(value, feed.name, now, cutoff, revoked.urls);
      if (!item) continue;
      const dedupe = item.link || `${item.source}|${item.title}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push(item);
    }
  }
  return { items, feedTotal: unique.length, feedCached, readable: true, readAt: now };
}

function loadPool(): Promise<ClaimPool> {
  const now = Date.now();
  if (pool && now - pool.at < POOL_TTL_MS) return pool.promise;
  const promise = readPool();
  pool = { at: now, promise };
  // A failed or empty read is not reused: the next claim reads again.
  void promise.then(
    (read) => { if ((!read.readable || read.items.length === 0) && pool?.promise === promise) pool = null; },
    () => { if (pool?.promise === promise) pool = null; },
  );
  return promise;
}

export type ClaimPoolSearch = {
  /** claimCandidates of the claim; empty for an empty claim or when nothing was searched. */
  readonly candidates: NewsItemCore[];
  readonly searchedHeadlines: number;
  readonly searchedFeeds: number;
  readonly feedTotal: number;
  readonly feedCached: number;
  /** complete | partial | unavailable. Unavailable searched nothing. */
  readonly state: 'complete' | 'partial' | 'unavailable';
  readonly readAt: string;
};

/** The search behind both the RPC and the verify_claim MCP tool, which runs it in-process. */
export async function searchClaimPool(claimText: string): Promise<ClaimPoolSearch> {
  const claim = claimText.trim().slice(0, CLAIM_MAX_CHARS);
  const read = await loadPool();
  const state = !read.readable || read.feedCached === 0 || read.items.length === 0
    ? 'unavailable'
    : read.feedCached === read.feedTotal ? 'complete' : 'partial';
  const searched = state === 'unavailable' ? [] : read.items;
  return {
    candidates: claim ? claimCandidates(claim, searched) : [],
    searchedHeadlines: searched.length,
    searchedFeeds: new Set(searched.map(item => item.source)).size,
    feedTotal: read.feedTotal,
    feedCached: read.feedCached,
    state,
    readAt: new Date(read.readAt).toISOString(),
  };
}

function toHeadline(item: NewsItemCore): ClaimHeadline {
  return { source: item.source, title: item.title, link: item.link, publishedAt: item.pubDate.getTime() };
}

export async function searchClaimHeadlines(
  ctx: ServerContext,
  req: SearchClaimHeadlinesRequest,
): Promise<SearchClaimHeadlinesResponse> {
  const { candidates, ...search } = await searchClaimPool(req.claim ?? '');
  if (search.state !== 'complete') markNoCacheResponse(ctx.request);
  return { headlines: candidates.map(toHeadline), ...search };
}

export const __testing__ = {
  resetPool(): void { pool = null; },
};
