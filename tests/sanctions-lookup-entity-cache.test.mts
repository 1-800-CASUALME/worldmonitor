import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupSanctionEntity } from '../server/worldmonitor/sanctions/v1/lookup-entity.ts';
import { __clearLocalUnavailableBackoffForTests } from '../server/_shared/redis.ts';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
  apiKey: process.env.OPENSANCTIONS_API_KEY,
};
const INDEX = [
  { id: 'SDN:1', name: 'Test Person', et: 'individual', cc: ['RU'], pr: ['SDN'] },
  { id: 'CONSOLIDATED:2', name: 'Test Company', et: 'entity', cc: ['IR'], pr: ['SSI'] },
  { id: 'sema-ca:russia:1-1:3', name: 'Test Vessel', et: 'vessel', cc: [], pr: ['SEMA'] },
];
const ALL_SOURCES = 'OFAC SDN, OFAC Consolidated, Canada SEMA';

function configureEnvironment(t: test.TestContext) {
  __clearLocalUnavailableBackoffForTests();
  t.after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [key, value] of [
      ['UPSTASH_REDIS_REST_URL', ORIGINAL_ENV.url],
      ['UPSTASH_REDIS_REST_TOKEN', ORIGINAL_ENV.token],
      ['OPENSANCTIONS_API_KEY', ORIGINAL_ENV.apiKey],
    ] as const) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  delete process.env.OPENSANCTIONS_API_KEY;
}

function installIndex(t: test.TestContext, index: unknown = INDEX, status = 200) {
  configureEnvironment(t);
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://redis.example.test/get/sanctions%3Aentities%3Av1') {
      return new Response(JSON.stringify({ result: index == null ? null : JSON.stringify(index) }), { status });
    }
    if (url.startsWith('https://api.opensanctions.org/')) {
      return new Response('No API key provided.', { status: 401 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return requests;
}

test('local lookup makes no OpenSanctions or query-cache requests without a licence key', async (t) => {
  const requests = installIndex(t);
  const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
  assert.deepEqual(requests, ['https://redis.example.test/get/sanctions%3Aentities%3Av1']);
  assert.equal(result.source, ALL_SOURCES);
  assert.deepEqual(result.results, [{
    id: 'SDN:1', name: 'Test Person', entityType: 'individual', countryCodes: ['RU'], programs: ['SDN'],
  }, {
    id: 'CONSOLIDATED:2', name: 'Test Company', entityType: 'entity', countryCodes: ['IR'], programs: ['SSI'],
  }, {
    id: 'sema-ca:russia:1-1:3', name: 'Test Vessel', entityType: 'vessel', countryCodes: [], programs: ['SEMA'],
  }]);
  assert.equal(result.total, 3);
});

test('Canada-only lookup reports only Canada and preserves its match', async (t) => {
  installIndex(t, [INDEX[2]]);
  const result = await lookupSanctionEntity({} as never, { q: 'Test Vessel', maxResults: 10 });
  assert.equal(result.source, 'Canada SEMA');
  assert.equal(result.results[0]?.id, INDEX[2]!.id);
});

test('a no-match answer still identifies the full searched index', async (t) => {
  installIndex(t);
  const result = await lookupSanctionEntity({} as never, { q: 'Unlisted', maxResults: 10 });
  assert.deepEqual(result, { results: [], total: 0, source: ALL_SOURCES });
});

test('case, whitespace, ranking, and maxResults keep the local matcher contract', async (t) => {
  installIndex(t, Array.from({ length: 60 }, (_, i) => ({ ...INDEX[0], id: `SDN:${i}`, name: i === 0 ? 'Test Person' : `Test Person ${i}` })));
  for (const [maxResults, expectedLength] of [[1, 1], [5.9, 5], [50, 50], [100, 50], [0, 10], [-1, 10], [NaN, 10]] as const) {
    const result = await lookupSanctionEntity({} as never, { q: '  TEST   person  ', maxResults });
    assert.equal(result.results.length, expectedLength);
    assert.equal(result.total, 60);
    assert.equal(result.results[0]?.name, 'Test Person');
    assert.equal(result.source, 'OFAC SDN');
  }
});

test('invalid query lengths perform no search and claim no source lists', async (t) => {
  const requests = installIndex(t);
  process.env.OPENSANCTIONS_API_KEY = 'test-licensed-key';
  for (const q of ['', 'x', ' '.repeat(10), 'x'.repeat(201)]) {
    const result = await lookupSanctionEntity({} as never, { q, maxResults: 10 });
    assert.deepEqual(result, { results: [], total: 0, source: 'Not searched' });
  }
  assert.deepEqual(requests, []);
});

test('a blank key skips OpenSanctions and its query cache', async (t) => {
  const requests = installIndex(t);
  process.env.OPENSANCTIONS_API_KEY = '   ';
  assert.equal((await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 })).source, ALL_SOURCES);
  assert.deepEqual(requests, ['https://redis.example.test/get/sanctions%3Aentities%3Av1']);
});

for (const [label, index, status, source] of [
  ['empty', [], 200, 'Local sanctions index (empty)'],
  ['missing', null, 200, 'Local sanctions index unavailable'],
  ['invalid', {}, 200, 'Local sanctions index unavailable'],
  ['failed', null, 503, 'Local sanctions index unavailable'],
] as const) {
  test(`${label} index does not claim regulator coverage`, async (t) => {
    const requests = installIndex(t, index, status);
    const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
    assert.deepEqual(result, { results: [], total: 0, source });
    assert.ok(requests.every(url => url.startsWith('https://redis.example.test/')));
  });
}

test('an unrecognized record source uses a generic local label', async (t) => {
  installIndex(t, [{ ...INDEX[0], id: 'legacy:1' }]);
  const result = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
  assert.equal(result.source, 'Local sanctions index');
  assert.equal(result.results[0]?.id, 'legacy:1');
});

test('repeat lookups see the current seed instead of a cached query answer', async (t) => {
  const index = [INDEX[0]!];
  const requests = installIndex(t, index);
  const first = await lookupSanctionEntity({} as never, { q: 'Test', maxResults: 10 });
  assert.equal(first.source, 'OFAC SDN');
  assert.equal(first.total, 1);
  index.push(INDEX[2]!);
  const second = await lookupSanctionEntity({} as never, { q: 'Test', maxResults: 10 });
  assert.equal(second.source, 'OFAC SDN, Canada SEMA');
  assert.equal(second.total, 2);
  assert.ok(requests.every(url => url === 'https://redis.example.test/get/sanctions%3Aentities%3Av1'));
});

const OPENSANCTIONS_PAYLOAD = {
  results: [{
    id: 'NK-abc123', schema: 'Person', caption: 'Test Person',
    properties: { name: ['Test Person'], country: ['ru'], program: ['SDN'] },
  }],
  total: { value: 1 },
};

function installLicensedSearch(t: test.TestContext, respond = (_q: string): Response => Response.json(OPENSANCTIONS_PAYLOAD)) {
  configureEnvironment(t);
  process.env.OPENSANCTIONS_API_KEY = 'test-licensed-key';
  const store = new Map<string, string>();
  const upstreamCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      const value = key === 'sanctions:entities:v1' ? JSON.stringify(INDEX) : store.get(key);
      return Response.json({ result: value ?? null });
    }
    if (url === 'https://redis.example.test/') {
      const cmd = JSON.parse(String(init?.body)) as string[];
      if (cmd[0] === 'SET') store.set(cmd[1]!, cmd[2]!);
      return Response.json({ result: 'OK' });
    }
    if (url.startsWith('https://api.opensanctions.org/')) {
      upstreamCalls.push(url);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'ApiKey test-licensed-key');
      assert.ok(init?.signal, 'upstream requests must have a deadline');
      return respond(new URL(url).searchParams.get('q')!);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { store, upstreamCalls };
}

test('licensed search authenticates and reuses the cached OpenSanctions response', async (t) => {
  const { store, upstreamCalls } = installLicensedSearch(t);
  process.env.OPENSANCTIONS_API_KEY = '  test-licensed-key  ';
  const first = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
  assert.deepEqual(first, {
    results: [{ id: 'opensanctions:NK-abc123', name: 'Test Person', entityType: 'individual', countryCodes: ['ru'], programs: ['SDN'] }],
    total: 1, source: 'opensanctions',
  });
  const second = await lookupSanctionEntity({} as never, { q: '  TEST   person  ', maxResults: 10 });
  assert.deepEqual(second, first);
  assert.equal(upstreamCalls.length, 1);
  assert.ok([...store.keys()].every(key => !key.includes('test-licensed-key')));
  delete process.env.OPENSANCTIONS_API_KEY;
  const local = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
  assert.equal(local.source, ALL_SOURCES, 'removing the key must bypass cached upstream results');
});

test('distinct queries with the same legacy FNV hash cannot replay an empty result', async (t) => {
  const attackerQuery = 'entity eoe';
  const targetQuery = 'entity 4s20';
  const { store, upstreamCalls } = installLicensedSearch(t, q => Response.json(q === attackerQuery
    ? { results: [], total: { value: 0 } } : OPENSANCTIONS_PAYLOAD));
  assert.equal((await lookupSanctionEntity({} as never, { q: attackerQuery, maxResults: 10 })).total, 0);
  assert.equal((await lookupSanctionEntity({} as never, { q: targetQuery, maxResults: 10 })).total, 1);
  assert.equal(upstreamCalls.length, 2);
  assert.equal(store.size, 2);
  assert.ok([...store.keys()].every(key => /sanctions:lookup:v2:[a-f0-9]{64}:10$/.test(key)));
});

test('a wider lookup never replays a shorter cached result', async (t) => {
  const { upstreamCalls } = installLicensedSearch(t);
  await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 5 });
  await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 50 });
  assert.deepEqual(upstreamCalls.map(url => new URL(url).searchParams.get('limit')), ['5', '50']);
});

test('a genuine OpenSanctions no-match response caches without falling back locally', async (t) => {
  const { upstreamCalls } = installLicensedSearch(t, () => Response.json({ results: [], total: { value: 0 } }));
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 }), {
      results: [], total: 0, source: 'opensanctions',
    });
  }
  assert.equal(upstreamCalls.length, 1);
});

for (const [label, fail] of [
  ['rejected key', () => new Response('Unauthorized', { status: 401 })],
  ['rate limit', () => new Response('Rate limited', { status: 429 })],
  ['outage', () => new Response('Unavailable', { status: 503 })],
  ['invalid response', () => Response.json({ error: 'unavailable' })],
  ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
] as const) {
  test(`OpenSanctions ${label} uses truthful local sources and does not cache the failure`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    let recovered = false;
    const { store, upstreamCalls } = installLicensedSearch(t, () => recovered ? Response.json(OPENSANCTIONS_PAYLOAD) : fail());
    const fallback = await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 });
    assert.equal(fallback.source, ALL_SOURCES);
    assert.equal(fallback.results[0]?.id, 'SDN:1');
    assert.equal(store.size, 0);
    recovered = true;
    t.mock.timers.tick(4_000);
    assert.equal((await lookupSanctionEntity({} as never, { q: 'Test Person', maxResults: 10 })).source, 'opensanctions');
    assert.equal(upstreamCalls.length, 2);
  });
}
