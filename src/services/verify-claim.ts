/**
 * The /verify page's data path (#9092): one public digest read, then the same
 * evidence card the verify_claim MCP tool returns, built in the browser.
 * Nothing here grades a claim; see server/_shared/claim-match.ts.
 */
import type { NewsItem as ProtoNewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { NewsItemCore } from '../../shared/news-clustering-core.js';
import { CLAIM_MAX_CHARS, buildClaimCard, type ClaimCard, type ClaimCardHeadline } from '../../server/_shared/claim-match';
import { publicRpcFetch } from './public-rpc-fetch';
import { protoItemToNewsItem } from './news-digest-items';
import { toApiUrl } from './runtime';

export { CLAIM_MAX_CHARS, type ClaimCard, type ClaimCardHeadline };

/** The widest digest: every category the dashboard's full variant carries, in English. */
export const VERIFY_DIGEST_PATH = '/api/news/v1/list-feed-digest?variant=full&lang=en';

const VERIFY_DIGEST_TIMEOUT_MS = 15_000;

export type ClaimDigest = {
  readonly items: NewsItemCore[];
  readonly publishers: number;
  readonly generatedAt: string;
  readonly stale: boolean;
};

type DigestBody = {
  categories?: Record<string, { items?: ProtoNewsItem[] }>;
  generatedAt?: string;
  coverage?: { servedStale?: boolean };
};

/** Digest items, deduplicated by link (one story often sits in several categories). */
export function claimDigestFromBody(body: DigestBody): ClaimDigest {
  const seen = new Set<string>();
  const items: NewsItemCore[] = [];
  for (const group of Object.values(body.categories ?? {})) {
    for (const raw of group?.items ?? []) {
      if (!raw?.title || !raw.source) continue;
      const key = raw.link || `${raw.source}|${raw.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(protoItemToNewsItem(raw));
    }
  }
  return {
    items,
    publishers: new Set(items.map((item) => item.source)).size,
    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : '',
    stale: body.coverage?.servedStale === true,
  };
}

export async function fetchClaimDigest(signal?: AbortSignal): Promise<ClaimDigest> {
  const res = await publicRpcFetch(toApiUrl(VERIFY_DIGEST_PATH), {
    signal: signal ?? AbortSignal.timeout(VERIFY_DIGEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const digest = claimDigestFromBody(await res.json() as DigestBody);
  if (digest.items.length === 0) throw new Error('digest returned no headlines');
  return digest;
}

/** The claim as the card checks it: trimmed and capped, as the MCP tool does. */
export function normalizeClaim(text: string): string {
  return String(text || '').trim().slice(0, CLAIM_MAX_CHARS);
}

export function checkClaim(text: string, digest: ClaimDigest): ClaimCard {
  return buildClaimCard(normalizeClaim(text), digest.items);
}
