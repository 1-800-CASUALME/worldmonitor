import type {
  LookupSanctionEntityRequest,
  LookupSanctionEntityResponse,
  SanctionEntityMatch,
  SanctionsServiceHandler,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/sanctions/v1/service_server';

import { cachedFetchJson, getCachedJson } from '../../../_shared/redis';
import { sha256Hex } from '../../../_shared/hash';

const ENTITY_INDEX_KEY = 'sanctions:entities:v1';
const DEFAULT_MAX = 10;
const MAX_RESULTS_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
const MIN_QUERY_LENGTH = 2;
const OPENSANCTIONS_BASE = 'https://api.opensanctions.org';
const OPENSANCTIONS_TIMEOUT_MS = 8_000;
const OPENSANCTIONS_CACHE_TTL_SECONDS = 3_600;
const SOURCE_LABELS = [
  ['SDN:', 'OFAC SDN'],
  ['CONSOLIDATED:', 'OFAC Consolidated'],
  ['sema-ca:', 'Canada SEMA'],
] as const;

interface EntityIndexRecord {
  id: string;
  name: string;
  et: string;
  cc: string[];
  pr: string[];
}

interface OpenSanctionsHit {
  id?: string;
  schema?: string;
  caption?: string;
  properties?: {
    name?: string[];
    country?: string[];
    nationality?: string[];
    program?: string[];
    sanctions?: string[];
  };
}

interface OpenSanctionsSearchResponse {
  results?: OpenSanctionsHit[];
  total?: { value?: number };
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function clampMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RESULTS_LIMIT);
}

function entityTypeFromSchema(schema: string): string {
  if (schema === 'Vessel') return 'vessel';
  if (schema === 'Aircraft') return 'aircraft';
  if (schema === 'Person') return 'individual';
  return 'entity';
}

function normalizeOpenSanctionsHit(hit: OpenSanctionsHit): SanctionEntityMatch | null {
  const props = hit.properties ?? {};
  const name = (props.name ?? [hit.caption ?? '']).filter(Boolean)[0] ?? '';
  if (!name || !hit.id) return null;
  const countries = (props.country ?? props.nationality ?? []).slice(0, 3);
  const programs = (props.program ?? props.sanctions ?? []).slice(0, 3);
  return {
    id: `opensanctions:${hit.id}`,
    name,
    entityType: entityTypeFromSchema(hit.schema ?? ''),
    countryCodes: countries,
    programs,
  };
}

async function lookupCacheKey(q: string, maxResults: number): Promise<string> {
  const canonical = q.toLowerCase().replace(/\s+/g, ' ').trim();
  return `sanctions:lookup:v2:${await sha256Hex(canonical)}:${maxResults}`;
}

async function searchOpenSanctions(q: string, limit: number, apiKey: string): Promise<{ results: SanctionEntityMatch[]; total: number }> {
  const url = new URL(`${OPENSANCTIONS_BASE}/search/default`);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(limit));

  const resp = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'WorldMonitor/1.0 sanctions-search',
      Accept: 'application/json',
      Authorization: `ApiKey ${apiKey}`,
    },
    signal: AbortSignal.timeout(OPENSANCTIONS_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`OpenSanctions HTTP ${resp.status}`);

  const data = (await resp.json()) as OpenSanctionsSearchResponse;
  if (!Array.isArray(data.results)) throw new Error('Invalid OpenSanctions search response');
  const hits = data.results;
  const results = hits
    .map(normalizeOpenSanctionsHit)
    .filter((r): r is SanctionEntityMatch => r !== null);
  const total = data.total?.value ?? results.length;
  return { results, total };
}

function searchLocalIndex(q: string, maxResults: number, index: EntityIndexRecord[]): { results: SanctionEntityMatch[]; total: number } {
  const needle = normalize(q);
  const tokens = needle.split(' ').filter(Boolean);
  const scored: Array<{ score: number; entry: EntityIndexRecord }> = [];

  for (const entry of index) {
    const haystack = normalize(entry.name);

    if (haystack === needle) {
      scored.push({ score: 100, entry });
      continue;
    }
    if (haystack.startsWith(needle)) {
      scored.push({ score: 80, entry });
      continue;
    }
    if (tokens.length > 0 && tokens.every((t) => haystack.includes(t))) {
      const pos = haystack.indexOf(tokens[0] ?? '');
      scored.push({ score: 60 - Math.min(pos, 20), entry });
      continue;
    }
    const matchCount = tokens.filter((t) => haystack.includes(t)).length;
    if (matchCount > 0) {
      scored.push({ score: matchCount * 10, entry });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const results: SanctionEntityMatch[] = scored.slice(0, maxResults).map(({ entry }) => ({
    id: entry.id,
    name: entry.name,
    entityType: entry.et,
    countryCodes: entry.cc,
    programs: entry.pr,
  }));

  return { results, total: scored.length };
}

export const lookupSanctionEntity: SanctionsServiceHandler['lookupSanctionEntity'] = async (
  _ctx: ServerContext,
  req: LookupSanctionEntityRequest,
): Promise<LookupSanctionEntityResponse> => {
  const q = (req.q ?? '').trim();
  if (q.length < MIN_QUERY_LENGTH || q.length > MAX_QUERY_LENGTH) {
    return { results: [], total: 0, source: 'Not searched' };
  }

  const maxResults = clampMax(req.maxResults);

  const apiKey = process.env.OPENSANCTIONS_API_KEY?.trim();
  if (apiKey) {
    try {
      const upstream = await cachedFetchJson<{ results: SanctionEntityMatch[]; total: number }>(
        await lookupCacheKey(q, maxResults),
        OPENSANCTIONS_CACHE_TTL_SECONDS,
        () => searchOpenSanctions(q, maxResults, apiKey),
        undefined,
        { cacheFetcherErrors: false },
      );
      if (upstream) {
        return { ...upstream, source: 'opensanctions' };
      }
    } catch {
      // A failed upstream request must not hide the available local index.
    }
  }

  try {
    const raw = await getCachedJson(ENTITY_INDEX_KEY, true);
    if (!Array.isArray(raw)) {
      return { results: [], total: 0, source: 'Local sanctions index unavailable' };
    }
    const index = raw as EntityIndexRecord[];
    const sources = SOURCE_LABELS
      .filter(([prefix]) => index.some(entry => entry.id.startsWith(prefix)))
      .map(([, label]) => label);
    const source = sources.join(', ') || (index.length === 0 ? 'Local sanctions index (empty)' : 'Local sanctions index');
    return { ...searchLocalIndex(q, maxResults, index), source };
  } catch {
    return { results: [], total: 0, source: 'Local sanctions index unavailable' };
  }
};
