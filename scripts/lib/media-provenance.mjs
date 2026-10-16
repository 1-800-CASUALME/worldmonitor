// Media provenance checks (#9096), run by scripts/media-provenance-worker.mjs.
//
// Everything here reports evidence: what a file's C2PA content credentials
// declare, and where TinEye's crawler has seen the image. Nothing here decides
// whether media is genuine. Network, Redis and the C2PA reader are passed in,
// so tests drive these functions with fixtures.

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

import {
  MEDIA_IMAGE_TYPES,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_REDIRECTS,
  MEDIA_SEARCHABLE_TYPES,
  MEDIA_URL_MAX_CHARS,
  MEDIA_VIDEO_TYPES,
  TINEYE_DEFAULT_COST_PER_SEARCH_USD,
  TINEYE_DEFAULT_MONTHLY_CAP_USD,
  TINEYE_MAX_COPIES,
  tineyeCacheKey,
  tineyeSpendKey,
} from '../shared/media-provenance-contract.js';

const require = createRequire(import.meta.url);
const { createGuardedLookup, isBlockedResolvedAddress } = require('./notification-webhook-ssrf.cjs');

const FETCH_TIMEOUT_MS = 20_000;
/** Whole download, every hop included: a server that drips bytes cannot hold the worker. */
const FETCH_DEADLINE_MS = 60_000;
const USER_AGENT = 'WorldMonitor-MediaProvenance/1.0 (+https://www.worldmonitor.app/trust)';
const ALLOWED_PORTS = new Set(['', '80', '443']);
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.internal', 'instance-data']);

/** A check that cannot run on this input. `message` is shown to the person who asked. */
export class MediaCheckError extends Error {
  constructor(message, code = 'media-check') {
    super(message);
    this.name = 'MediaCheckError';
    this.code = code;
  }
}

/**
 * Why a URL may not be fetched, or null when its form is acceptable. DNS is
 * checked separately, at connect time, for every hop.
 */
export function mediaUrlProblem(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MEDIA_URL_MAX_CHARS) return 'The link must be a URL of at most 2,048 characters.';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return 'The link is not a valid URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The link must start with http:// or https://.';
  if (url.username || url.password) return 'The link must not contain a user name or password.';
  if (!ALLOWED_PORTS.has(url.port)) return 'The link must use the standard web port.';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return 'The link must point to a public website.';
  }
  if (isBlockedResolvedAddress(host)) return 'The link must point to a public website.';
  return null;
}

/**
 * The media type of a file, from its first bytes. The server's Content-Type
 * is not trusted: a check runs on what the file is, not what it claims.
 */
export function sniffMediaType(bytes) {
  const b = bytes;
  if (!b || b.length < 12) return null;
  const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'image/tiff';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}

function requestOnce(url, { lookup, timeoutMs }) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,video/mp4,video/quicktime;q=0.9,*/*;q=0.1' },
      lookup,
      timeout: timeoutMs,
    }, resolve);
    req.on('timeout', () => req.destroy(new MediaCheckError('The file took too long to download.', 'timeout')));
    req.on('error', reject);
    req.end();
  });
}

function readCapped(res, maxBytes, deadlineAt) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const timer = setTimeout(() => {
      res.destroy(new MediaCheckError('The file took too long to download.', 'timeout'));
    }, Math.max(0, deadlineAt - Date.now()));
    res.on('close', () => clearTimeout(timer));
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy(new MediaCheckError(`The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'too-large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Download a public media file. Every hop is re-checked: the URL form here,
 * and every DNS answer at connect time (createGuardedLookup), so a redirect or
 * a DNS answer to a private address is refused.
 */
export async function fetchMedia(rawUrl, {
  request = requestOnce,
  lookup = createGuardedLookup(),
  maxBytes = MEDIA_MAX_BYTES,
  maxRedirects = MEDIA_MAX_REDIRECTS,
  timeoutMs = FETCH_TIMEOUT_MS,
  deadlineMs = FETCH_DEADLINE_MS,
} = {}) {
  const deadlineAt = Date.now() + deadlineMs;
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const problem = mediaUrlProblem(current);
    if (problem) throw new MediaCheckError(problem, 'url');
    if (Date.now() >= deadlineAt) throw new MediaCheckError('The file took too long to download.', 'timeout');
    const url = new URL(current);
    let res;
    try {
      res = await request(url, { lookup, timeoutMs });
    } catch (error) {
      if (error instanceof MediaCheckError) throw error;
      if (error && error.code === 'ERR_SSRF_BLOCKED') throw new MediaCheckError('The link must point to a public website.', 'url');
      throw new MediaCheckError('The file could not be downloaded.', 'fetch');
    }
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      current = new URL(String(res.headers.location), url).toString();
      continue;
    }
    if (status !== 200) {
      res.resume();
      throw new MediaCheckError(`The file could not be downloaded (HTTP ${status}).`, 'fetch');
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.resume();
      throw new MediaCheckError(`The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB.`, 'too-large');
    }
    const bytes = await readCapped(res, maxBytes, deadlineAt);
    const mediaType = sniffMediaType(bytes);
    if (!mediaType || (!MEDIA_IMAGE_TYPES.includes(mediaType) && !MEDIA_VIDEO_TYPES.includes(mediaType))) {
      throw new MediaCheckError('The link does not point to an image or video file this check can read (JPEG, PNG, WebP, GIF, AVIF, HEIC, TIFF, MP4 or MOV).', 'type');
    }
    return { bytes, mediaType, sha256: createHash('sha256').update(bytes).digest('hex'), finalUrl: url.toString() };
  }
  throw new MediaCheckError('The link redirects too many times.', 'url');
}

const AI_SOURCE_TYPES = new Set(['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia']);
const HASH_MISMATCH_CODES = new Set([
  'assertion.dataHash.mismatch',
  'assertion.bmffHash.mismatch',
  'assertion.boxesHash.mismatch',
  'assertion.collectionHash.mismatch',
]);

function text(value, max = 200) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function agentName(agent) {
  if (typeof agent === 'string') return text(agent);
  if (agent && typeof agent === 'object') return text(agent.name);
  return '';
}

function generatorName(manifest) {
  const info = Array.isArray(manifest.claim_generator_info) ? manifest.claim_generator_info[0] : null;
  if (info && typeof info === 'object' && text(info.name)) {
    return [text(info.name), text(info.version, 40)].filter(Boolean).join(' ');
  }
  return text(manifest.claim_generator);
}

/**
 * What the active manifest of a C2PA manifest store (Reader.json()) declares.
 * `trustListConfigured` says whether the reader was given trust anchors: only
 * then can "untrusted" be told apart from "not checked".
 */
export function summarizeCredentials(store, { trustListConfigured = false } = {}) {
  if (store == null) return { state: 'none' };
  const manifests = store && typeof store === 'object' ? store.manifests : null;
  const active = manifests && typeof manifests === 'object' ? manifests[store.active_manifest] : null;
  if (!active || typeof active !== 'object') return { state: 'unreadable' };

  const signature = active.signature_info && typeof active.signature_info === 'object' ? active.signature_info : {};
  const actions = [];
  for (const assertion of Array.isArray(active.assertions) ? active.assertions : []) {
    if (!assertion || typeof assertion.label !== 'string' || !assertion.label.startsWith('c2pa.actions')) continue;
    for (const entry of Array.isArray(assertion.data?.actions) ? assertion.data.actions : []) {
      if (!entry || typeof entry.action !== 'string') continue;
      actions.push({
        action: text(entry.action, 80),
        softwareAgent: agentName(entry.softwareAgent),
        digitalSourceType: text(entry.digitalSourceType, 200),
      });
    }
  }

  const failures = [];
  const results = store.validation_results?.activeManifest;
  for (const item of Array.isArray(results?.failure) ? results.failure : []) {
    if (item && typeof item.code === 'string') failures.push(text(item.code, 100));
  }
  for (const item of Array.isArray(store.validation_status) ? store.validation_status : []) {
    if (item && typeof item.code === 'string' && !failures.includes(item.code)) failures.push(text(item.code, 100));
  }
  const successes = (Array.isArray(results?.success) ? results.success : [])
    .map((item) => (item && typeof item.code === 'string' ? item.code : ''));
  const validationState = text(store.validation_state, 20).toLowerCase();
  // The signer's trust is its own result: a file changed after signing is
  // "invalid" overall while its signer can still be on the trust list.
  const signerTrust = validationState === 'trusted' || successes.includes('signingCredential.trusted')
    ? 'trusted'
    : trustListConfigured && failures.includes('signingCredential.untrusted') ? 'untrusted' : 'unknown';

  return {
    state: 'found',
    signer: text(signature.issuer),
    signerCommonName: text(signature.common_name),
    signerTrust,
    claimGenerator: generatorName(active),
    signedAt: text(signature.time, 40),
    actions: actions.slice(0, 50),
    declaresAiGeneration: actions.some((a) => AI_SOURCE_TYPES.has(a.digitalSourceType.split('/').pop())),
    ingredientCount: Array.isArray(active.ingredients) ? active.ingredients.length : 0,
    validationState,
    contentChangedAfterSigning: failures.some((code) => HASH_MISMATCH_CODES.has(code)),
    failureCodes: failures.slice(0, 20),
  };
}

/**
 * Read content credentials with @contentauth/c2pa-node. `readerFactory` is
 * (assetPath, mimeType) => Promise<store | null>; a read error that is not
 * "no manifest" reports the credentials as unreadable.
 */
export async function readCredentials(assetPath, mimeType, readerFactory, options) {
  try {
    return summarizeCredentials(await readerFactory(assetPath, mimeType), options);
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/jumbf ?not ?found|no ?manifest|manifest ?not ?found|ProvenanceMissing/i.test(message)) return { state: 'none' };
    return { state: 'unreadable' };
  }
}

/** Oldest-first copies from a TinEye search response, or null when the response is not a success. */
export function parseTinEyeResponse(body) {
  if (!body || typeof body !== 'object' || Number(body.code) !== 200) return null;
  const matches = Array.isArray(body.results?.matches) ? body.results.matches : [];
  const seen = new Set();
  const copies = [];
  for (const match of matches) {
    for (const link of Array.isArray(match?.backlinks) ? match.backlinks : []) {
      const pageUrl = text(link?.backlink, 2048);
      const crawlDate = text(link?.crawl_date, 10);
      if (!pageUrl || !/^\d{4}-\d{2}-\d{2}$/.test(crawlDate) || seen.has(pageUrl)) continue;
      let domain = text(match.domain, 253);
      try {
        const parsed = new URL(pageUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
        domain ||= parsed.hostname;
      } catch {
        continue;
      }
      seen.add(pageUrl);
      copies.push({ domain, pageUrl, crawlDate });
    }
  }
  copies.sort((a, b) => a.crawlDate.localeCompare(b.crawlDate) || a.domain.localeCompare(b.domain));
  return { copies: copies.slice(0, TINEYE_MAX_COPIES), totalMatches: matches.length };
}

export function tineyeLimits(env = process.env) {
  const cap = Number(env.TINEYE_MONTHLY_CAP_USD);
  const cost = Number(env.TINEYE_COST_PER_SEARCH_USD);
  return {
    capCents: Math.round((Number.isFinite(cap) && cap >= 0 ? cap : TINEYE_DEFAULT_MONTHLY_CAP_USD) * 100),
    costCents: Math.max(1, Math.round((Number.isFinite(cost) && cost > 0 ? cost : TINEYE_DEFAULT_COST_PER_SEARCH_USD) * 100)),
  };
}

/**
 * Reserve one search against the monthly cap. Returns a refund function, or
 * null when the cap is reached. Reserve first, then search: two workers
 * cannot both spend the last search.
 */
export async function reserveTinEyeSearch(redisCmd, { capCents, costCents }, now = Date.now()) {
  const key = tineyeSpendKey(now);
  const total = Number(await redisCmd('incrby', [key, costCents]));
  await redisCmd('expire', [key, 40 * 24 * 60 * 60]);
  if (!Number.isFinite(total)) throw new Error('spend counter unreadable');
  if (total > capCents) {
    await redisCmd('decrby', [key, costCents]);
    return null;
  }
  return () => redisCmd('decrby', [key, costCents]);
}

/**
 * Earliest copies of an image: cached by content hash, otherwise one TinEye
 * search within the monthly cap. Never throws; every outcome is a state.
 */
export async function findEarliestCopies({ sha256, mediaType, searchBytes, apiKey, redisCmd, searchTinEye, limits, now = Date.now(), cacheTtlSeconds }) {
  const base = { provider: 'TinEye', copies: [], totalMatches: 0, searchedAt: '' };
  if (!MEDIA_SEARCHABLE_TYPES.includes(mediaType)) return { ...base, state: 'unsupported-media' };
  if (!apiKey) return { ...base, state: 'not-configured' };
  try {
    const cached = await redisCmd('get', [tineyeCacheKey(sha256)]);
    if (typeof cached === 'string') {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed?.copies)) return { ...base, state: 'ok', ...parsed };
    }
  } catch {
    // A cache miss or bad entry falls through to a search.
  }
  let refund;
  try {
    refund = await reserveTinEyeSearch(redisCmd, limits, now);
  } catch {
    return { ...base, state: 'unavailable' };
  }
  if (!refund) return { ...base, state: 'cap-reached' };
  let parsed = null;
  try {
    parsed = parseTinEyeResponse(await searchTinEye(await searchBytes(), apiKey));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    await Promise.resolve(refund()).catch(() => {});
    return { ...base, state: 'unavailable' };
  }
  const record = { ...parsed, searchedAt: new Date(now).toISOString() };
  await redisCmd('set', [tineyeCacheKey(sha256), JSON.stringify(record), 'EX', cacheTtlSeconds]).catch(() => {});
  return { ...base, state: 'ok', ...record };
}

/** POST the image to TinEye's search API, oldest crawl first. */
export async function searchTinEye(bytes, apiKey, fetchImpl = (...args) => globalThis.fetch(...args)) {
  const form = new FormData();
  form.append('image_upload', new Blob([bytes], { type: 'application/octet-stream' }), 'image');
  form.append('sort', 'crawl_date');
  form.append('order', 'asc');
  form.append('limit', '20');
  form.append('backlink_limit', '20');
  const resp = await fetchImpl('https://api.tineye.com/rest/search/', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'User-Agent': USER_AGENT },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  return resp.json();
}

/**
 * Bytes for the search with all metadata removed (EXIF location, camera
 * serials, the C2PA manifest): sharp writes none by default. The original
 * file is what the credentials were read from; only this copy leaves.
 */
export async function strippedSearchBytes(bytes, mediaType, sharpImpl) {
  const image = sharpImpl(bytes, { animated: false }).rotate();
  if (mediaType === 'image/png' || mediaType === 'image/gif') return image.png().toBuffer();
  if (mediaType === 'image/webp') return image.webp().toBuffer();
  return image.jpeg({ quality: 92 }).toBuffer();
}
