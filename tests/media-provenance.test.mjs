// #9096 media provenance: the worker's checks (scripts/lib/media-provenance.mjs,
// scripts/media-provenance-worker.mjs) and the wording they report with.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import sharp from 'sharp';

import {
  MEDIA_CAVEATS,
  MEDIA_WORDING,
  tineyeCacheKey,
  tineyeSpendKey,
} from '../shared/media-provenance-contract.js';
import {
  MediaCheckError,
  fetchMedia,
  findEarliestCopies,
  mediaUrlProblem,
  parseTinEyeResponse,
  readCredentials,
  sniffMediaType,
  strippedSearchBytes,
  summarizeCredentials,
  tineyeLimits,
} from '../scripts/lib/media-provenance.mjs';
import { runMediaCheck, sweepExpiredMedia } from '../scripts/media-provenance-worker.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/media-provenance/${name}`, import.meta.url), 'utf8'));

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(60)]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(60)]);
const HTML = Buffer.from('<!doctype html><html><body>not an image</body></html>');

/** A fake http(s).request result. */
function response(statusCode, headers = {}, body = Buffer.alloc(0)) {
  const res = new PassThrough();
  res.statusCode = statusCode;
  res.headers = headers;
  setImmediate(() => res.end(body));
  return res;
}

function scriptedRequest(routes) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: url.toString(), options });
    const route = routes[url.toString()];
    if (!route) throw Object.assign(new Error('unexpected host'), { code: 'ENOTFOUND' });
    return typeof route === 'function' ? route() : route;
  };
  return { request, calls };
}

function fakeRedis(initial = {}) {
  const store = new Map(Object.entries(initial));
  const log = [];
  const cmd = async (name, args) => {
    log.push([name, ...args]);
    const [key, value] = args;
    switch (name) {
      case 'get': return store.has(key) ? store.get(key) : null;
      case 'set': store.set(key, value); return 'OK';
      case 'incrby': store.set(key, Number(store.get(key) ?? 0) + Number(value)); return store.get(key);
      case 'decrby': store.set(key, Number(store.get(key) ?? 0) - Number(value)); return store.get(key);
      case 'expire': return 1;
      default: throw new Error(`unexpected ${name}`);
    }
  };
  return { cmd, store, log };
}

describe('media URLs (SSRF guard, form)', () => {
  it('accepts a public http(s) URL on the standard port', () => {
    assert.equal(mediaUrlProblem('https://example.com/photo.jpg'), null);
    assert.equal(mediaUrlProblem('http://cdn.example.org:80/a.png'), null);
  });

  it('refuses private, local and metadata hosts, credentials, other ports and schemes', () => {
    for (const url of [
      'http://127.0.0.1/a.jpg',
      'http://10.0.0.5/a.jpg',
      'http://192.168.1.1/a.jpg',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/a.jpg',
      'http://[::ffff:127.0.0.1]/a.jpg',
      'http://localhost/a.jpg',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://printer.local/a.jpg',
      'http://intranet/a.jpg',
      'https://user:pass@example.com/a.jpg',
      'https://example.com:8443/a.jpg',
      'ftp://example.com/a.jpg',
      'file:///etc/passwd',
      'not a url',
      `https://example.com/${'a'.repeat(2100)}`,
    ]) {
      assert.ok(mediaUrlProblem(url), url);
    }
  });
});

describe('media type sniffing', () => {
  it('reads the type from the bytes, not the header', () => {
    assert.equal(sniffMediaType(JPEG), 'image/jpeg');
    assert.equal(sniffMediaType(PNG), 'image/png');
    assert.equal(sniffMediaType(MP4), 'video/mp4');
    assert.equal(sniffMediaType(MOV), 'video/quicktime');
    assert.equal(sniffMediaType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)])), 'image/webp');
    assert.equal(sniffMediaType(HTML), null);
    assert.equal(sniffMediaType(Buffer.alloc(4)), null);
  });
});

describe('fetching media', () => {
  it('downloads an image, hashes it and routes every connection through the guarded lookup', async () => {
    const lookup = () => {};
    const { request, calls } = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, { 'content-type': 'text/html' }, JPEG) });
    const fetched = await fetchMedia('https://example.com/a.jpg', { request, lookup });
    assert.equal(fetched.mediaType, 'image/jpeg', 'sniffed, despite the text/html header');
    assert.match(fetched.sha256, /^[a-f0-9]{64}$/);
    assert.equal(calls[0].options.lookup, lookup);
  });

  it('re-checks every redirect and refuses one that points inside the network', async () => {
    const { request, calls } = scriptedRequest({
      'https://example.com/a.jpg': () => response(302, { location: 'http://169.254.169.254/latest/meta-data/' }),
    });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request }), (error) => error instanceof MediaCheckError && error.code === 'url');
    assert.equal(calls.length, 1, 'the metadata address is never requested');
  });

  it('follows a public redirect, up to the limit', async () => {
    const { request } = scriptedRequest({
      'https://example.com/a': () => response(301, { location: '/b' }),
      'https://example.com/b': () => response(200, {}, PNG),
    });
    assert.equal((await fetchMedia('https://example.com/a', { request })).mediaType, 'image/png');
    const loop = scriptedRequest({ 'https://example.com/a': () => response(302, { location: '/a' }) });
    await assert.rejects(fetchMedia('https://example.com/a', { request: loop.request, maxRedirects: 2 }), /redirects too many times/);
  });

  it('refuses a DNS answer the guarded lookup blocks', async () => {
    const request = async () => { throw Object.assign(new Error('blocked'), { code: 'ERR_SSRF_BLOCKED' }); };
    await assert.rejects(fetchMedia('https://rebind.example.com/a.jpg', { request }), /public website/);
  });

  it('refuses files over the size limit, by header and while streaming', async () => {
    const declared = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, { 'content-length': '999999999' }, JPEG) });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request: declared.request }), (e) => e.code === 'too-large');
    const streamed = scriptedRequest({ 'https://example.com/a.jpg': () => response(200, {}, Buffer.concat([JPEG, Buffer.alloc(200)])) });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request: streamed.request, maxBytes: 100 }), (e) => e.code === 'too-large');
  });

  it('gives up on a server that drips bytes past the overall deadline', async () => {
    const drip = scriptedRequest({ 'https://example.com/a.jpg': () => {
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = {};
      res.write(JPEG.subarray(0, 4));
      return res;
    } });
    await assert.rejects(fetchMedia('https://example.com/a.jpg', { request: drip.request, deadlineMs: 50 }), (e) => e.code === 'timeout');
  });

  it('refuses a page that is not an image or video, and an error status', async () => {
    const page = scriptedRequest({ 'https://example.com/a': () => response(200, { 'content-type': 'image/jpeg' }, HTML) });
    await assert.rejects(fetchMedia('https://example.com/a', { request: page.request }), (e) => e.code === 'type');
    const missing = scriptedRequest({ 'https://example.com/a': () => response(404) });
    await assert.rejects(fetchMedia('https://example.com/a', { request: missing.request }), /HTTP 404/);
  });
});

describe('content credentials', () => {
  it('reports a trusted signer, the declared actions and the AI declaration (real c2pa-node output)', () => {
    const summary = summarizeCredentials(fixture('c2pa-store-trusted.json'), { trustListConfigured: true });
    assert.equal(summary.state, 'found');
    assert.equal(summary.signer, 'Example Newsroom (test)');
    assert.equal(summary.signerCommonName, 'Example Newsroom Signer');
    assert.equal(summary.signerTrust, 'trusted');
    assert.equal(summary.claimGenerator, 'WorldMonitor test fixture 1.0');
    assert.deepEqual(summary.actions.map((a) => a.action), ['c2pa.created', 'c2pa.cropped']);
    assert.equal(summary.actions[0].softwareAgent, 'Example Image Model');
    assert.equal(summary.declaresAiGeneration, true, 'the manifest declares trainedAlgorithmicMedia');
    assert.equal(summary.validationState, 'trusted');
    assert.equal(summary.contentChangedAfterSigning, false);
  });

  it('tells "not on the trust list" apart from "not checked"', () => {
    const store = fixture('c2pa-store-untrusted.json');
    assert.equal(summarizeCredentials(store, { trustListConfigured: true }).signerTrust, 'untrusted');
    assert.equal(summarizeCredentials(store, { trustListConfigured: false }).signerTrust, 'unknown');
  });

  it('reports a file changed after signing only from a hash mismatch', () => {
    const summary = summarizeCredentials(fixture('c2pa-store-tampered.json'));
    assert.equal(summary.validationState, 'invalid');
    assert.equal(summary.contentChangedAfterSigning, true);
    assert.ok(summary.failureCodes.includes('assertion.dataHash.mismatch'));
    assert.equal(summarizeCredentials(fixture('c2pa-store-untrusted.json')).contentChangedAfterSigning, false, 'an untrusted signer is not a changed file');
    // A trusted signer stays trusted when the file was changed after signing.
    const trustedButChanged = summarizeCredentials(fixture('c2pa-store-tampered-trusted.json'), { trustListConfigured: true });
    assert.deepEqual([trustedButChanged.signerTrust, trustedButChanged.validationState, trustedButChanged.contentChangedAfterSigning], ['trusted', 'invalid', true]);
  });

  it('treats no manifest as the ordinary result and a broken one as unreadable', async () => {
    assert.deepEqual(summarizeCredentials(null), { state: 'none' });
    assert.deepEqual(summarizeCredentials({ manifests: {} }), { state: 'unreadable' });
    assert.deepEqual(await readCredentials('/x', 'image/jpeg', async () => { throw new Error('JumbfNotFound'); }), { state: 'none' });
    assert.deepEqual(await readCredentials('/x', 'image/jpeg', async () => { throw new Error('ClaimDecoding'); }), { state: 'unreadable' });
  });
});

describe('earliest copies (TinEye)', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const limits = { capCents: 5000, costCents: 4 };

  it('lists copies oldest first, once each, with dated http(s) pages only', () => {
    const parsed = parseTinEyeResponse(fixture('tineye-search.json'));
    assert.deepEqual(parsed.copies.map((c) => [c.crawlDate, c.pageUrl]), [
      ['2024-03-03', 'https://example.org/2024/03/03/first'],
      ['2026-10-14', 'https://example.net/news/2026/10/14/story'],
      ['2026-10-15', 'https://example.net/gallery/1'],
    ]);
    assert.equal(parsed.totalMatches, 3);
    assert.equal(parseTinEyeResponse({ code: 401, messages: ['bad key'] }), null);
    assert.equal(parseTinEyeResponse(null), null);
  });

  it('defaults to the owner cap of $50 a month at about $0.04 a search', () => {
    assert.deepEqual(tineyeLimits({}), { capCents: 5000, costCents: 4 });
    assert.deepEqual(tineyeLimits({ TINEYE_MONTHLY_CAP_USD: '10', TINEYE_COST_PER_SEARCH_USD: '0.05' }), { capCents: 1000, costCents: 5 });
    assert.equal(tineyeSpendKey(now), 'media-provenance:tineye-spend:v1:2026-10');
  });

  it('does not search video, or without a key', async () => {
    const redis = fakeRedis();
    const search = async () => { throw new Error('must not search'); };
    const base = { sha256: 'a'.repeat(64), searchBytes: async () => JPEG, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: search, limits, now, cacheTtlSeconds: 60 };
    assert.equal((await findEarliestCopies({ ...base, mediaType: 'video/mp4' })).state, 'unsupported-media');
    assert.equal((await findEarliestCopies({ ...base, mediaType: 'image/jpeg', apiKey: '' })).state, 'not-configured');
    assert.equal(redis.log.length, 0);
  });

  it('serves a repeat image from the cache without spending', async () => {
    const sha = 'b'.repeat(64);
    const redis = fakeRedis({ [tineyeCacheKey(sha)]: JSON.stringify({ copies: [{ domain: 'example.org', pageUrl: 'https://example.org/x', crawlDate: '2024-01-01' }], totalMatches: 1, searchedAt: '2026-10-01T00:00:00.000Z' }) });
    const result = await findEarliestCopies({ sha256: sha, mediaType: 'image/jpeg', searchBytes: async () => JPEG, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: async () => { throw new Error('must not search'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(result.state, 'ok');
    assert.equal(result.searchedAt, '2026-10-01T00:00:00.000Z', 'shows when the search first ran');
    assert.ok(!redis.log.some(([name]) => name === 'incrby'));
  });

  it('reports the cap as reached instead of searching or skipping silently', async () => {
    const redis = fakeRedis({ [tineyeSpendKey(now)]: 4998 });
    const result = await findEarliestCopies({ sha256: 'c'.repeat(64), mediaType: 'image/png', searchBytes: async () => PNG, apiKey: 'k', redisCmd: redis.cmd, searchTinEye: async () => { throw new Error('must not search'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(result.state, 'cap-reached');
    assert.equal(redis.store.get(tineyeSpendKey(now)), 4998, 'the reservation is returned');
  });

  it('spends one reservation per search, refunds a failed one and caches a success', async () => {
    const failing = fakeRedis();
    const failed = await findEarliestCopies({ sha256: 'd'.repeat(64), mediaType: 'image/jpeg', searchBytes: async () => JPEG, apiKey: 'k', redisCmd: failing.cmd, searchTinEye: async () => ({ code: 500 }), limits, now, cacheTtlSeconds: 60 });
    assert.equal(failed.state, 'unavailable');
    assert.equal(failing.store.get(tineyeSpendKey(now)), 0);

    const redis = fakeRedis();
    const sent = [];
    const ok = await findEarliestCopies({ sha256: 'e'.repeat(64), mediaType: 'image/jpeg', searchBytes: async () => Buffer.from('stripped'), apiKey: 'key-1', redisCmd: redis.cmd, searchTinEye: async (bytes, key) => { sent.push([bytes.toString(), key]); return fixture('tineye-search.json'); }, limits, now, cacheTtlSeconds: 60 });
    assert.equal(ok.state, 'ok');
    assert.equal(ok.copies[0].crawlDate, '2024-03-03');
    assert.deepEqual(sent, [['stripped', 'key-1']], 'only the metadata-stripped copy is sent');
    assert.equal(redis.store.get(tineyeSpendKey(now)), 4);
    assert.ok(redis.store.has(tineyeCacheKey('e'.repeat(64))));
  });

  it('strips EXIF (camera, GPS) from the copy it sends', async () => {
    const withExif = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#336699' } })
      .jpeg().withExif({ IFD0: { Make: 'TestCam', Model: 'X1' } }).toBuffer();
    assert.ok((await sharp(withExif).metadata()).exif, 'the source has EXIF');
    const stripped = await strippedSearchBytes(withExif, 'image/jpeg', sharp);
    assert.equal((await sharp(stripped).metadata()).exif, undefined);
  });
});

describe('a whole check (worker)', () => {
  it('reads credentials from a temporary file it then removes, and never fails on storage', async () => {
    let assetPath = '';
    const result = await runMediaCheck({ url: 'https://example.com/a.jpg' }, {
      fetchMedia: async () => ({ bytes: JPEG, mediaType: 'image/jpeg', sha256: 'f'.repeat(64) }),
      storeOriginal: async () => { throw new Error('R2 down'); },
      readerFactory: async (path) => { assetPath = path; assert.ok(existsSync(path)); return fixture('c2pa-store-trusted.json'); },
      trustListConfigured: true,
      strippedSearchBytes: async () => JPEG,
      searchTinEye: async () => fixture('tineye-search.json'),
      tineyeApiKey: 'k',
      limits: { capCents: 5000, costCents: 4 },
      redisCmd: fakeRedis().cmd,
      now: () => Date.parse('2026-10-16T12:00:00Z'),
    });
    assert.equal(existsSync(assetPath), false, 'the temporary copy is deleted');
    assert.equal(result.credentials.signerTrust, 'trusted');
    assert.equal(result.earliest.state, 'ok');
    assert.equal(result.bytes, JPEG.length);
    assert.deepEqual(result.caveats, [...MEDIA_CAVEATS]);
  });

  it('deletes stored files once they pass the 30-day retention', async () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const calls = [];
    const deleted = [];
    const redisCmd = async (name, args) => {
      calls.push([name, ...args]);
      if (name === 'zrangebyscore') return ['media-provenance/v1/aaa', 'unrelated/key'];
      return 1;
    };
    assert.equal(await sweepExpiredMedia({ redisCmd, deleteObject: async (key) => { deleted.push(key); }, now }), 1);
    assert.deepEqual(deleted, ['media-provenance/v1/aaa'], 'only this feature\'s prefix is ever deleted');
    assert.equal(calls[0][3], now - 30 * 24 * 60 * 60 * 1000);
  });
});

describe('wording (#9091: evidence, never a verdict)', () => {
  it('never calls media authentic, fake, verified or original', () => {
    for (const line of [...MEDIA_CAVEATS, ...Object.values(MEDIA_WORDING)]) {
      assert.doesNotMatch(line, /\b(authentic|fake|verified|original|manipulated|real)\b/i, line);
    }
    assert.match(MEDIA_WORDING.noCredentials, /common and says nothing about whether the media was edited/);
  });

  it('shows the fixed caveats in the published OpenAPI example', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/NewsService.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/news/v1/get-media-provenance'].get.responses['200'].content['application/json'].example;
    assert.deepEqual(example.result.caveats, [...MEDIA_CAVEATS]);
    assert.equal(example.result.credentials.state, 'found');
  });
});
