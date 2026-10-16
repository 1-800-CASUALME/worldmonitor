// verify_claim (#9092): the real edge handler, with only the digest fetch mocked.
// The verdict must come from assessCorroboration; nothing says true or false.
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { documentedOutputSchema } from './helpers/mcp-output-schema.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const T0 = Date.parse('2026-10-09T18:00:00Z');
const unavailableDigest = {
  generatedAt: '2026-10-09T21:00:00.000Z',
  feedStatuses: {},
  categories: {},
  coverage: { state: 'unavailable', itemsServed: 0, publisherCount: 0 },
};
let digest;
const liveDigest = {
  generatedAt: '2026-10-09T21:00:00.000Z',
  feedStatuses: { Reuters: 'ok' },
  categories: {
    world: {
      items: [
        { source: 'Reuters', title: 'Trump strikes diesel deal with Putin', link: 'https://n/1', publishedAt: T0, isAlert: false },
        { source: 'BBC World', title: 'Trump says Russia will supply diesel in deal with Putin', link: 'https://n/2', publishedAt: T0 + 3_600_000, isAlert: false },
        { source: 'Reuters World', title: 'Panama earthquake: 12 dead, toll expected to rise', link: 'https://n/3', publishedAt: T0, isAlert: false },
        { source: 'Reuters', title: 'Panama earthquake: 12 dead, toll expected to rise', link: 'https://n/4', publishedAt: T0, isAlert: false },
      ],
    },
  },
};

describe('verify_claim MCP tool', () => {
  let mcpHandler;
  let requests;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    requests = [];
    digest = liveDigest;
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (new URL(url).hostname === 'fake-upstash.test') return Response.json([{ result: null }]);
      if (url.includes('/api/news/v1/list-feed-digest')) return Response.json(digest);
      throw new Error(`unexpected fetch: ${url}`);
    };
    const mod = await import(`../api/mcp.ts?verify=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => { if (!(key in originalEnv)) delete process.env[key]; });
    Object.assign(process.env, originalEnv);
  });

  async function callTool(args) {
    const { deps } = makeProDeps();
    const response = await mcpHandler(proReq('POST', callBody('verify_claim', args)), deps);
    const body = await response.json();
    return body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text) : body;
  }

  it('is listed with a required, capped claim', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((t) => t.name === 'verify_claim');
    assert.ok(tool, 'verify_claim must be listed');
    assert.deepEqual(tool.inputSchema.required, ['claim']);
    assert.equal(tool.inputSchema.properties.claim.maxLength, 300);
    assert.equal(tool.annotations.readOnlyHint, true);
  });

  it('two independent publishers: corroborated, with roster, sightings and caveat', async () => {
    const result = await callTool({ claim: 'Trump strikes diesel deal with Putin' });
    assert.equal(result.found, true);
    assert.equal(result.state, 'corroborated');
    assert.deepEqual(result.corroboration, { state: 'corroborated', publishers: 2 });
    assert.deepEqual(result.publishers.map((p) => p.name).sort(), ['BBC', 'Reuters'].sort());
    assert.ok(result.headlines.length >= 2);
    assert.ok(result.headlines.every((h) => typeof h.tier === 'number' || h.tier === null));
    assert.equal(result.firstSeen, new Date(T0).toISOString());
    assert.match(result.caveat, /Coverage, not accuracy/);
    assert.equal(result.claim, 'Trump strikes diesel deal with Putin', 'the claim is echoed as given, not lowercased');
    assert.equal(result.generatedAt, digest.generatedAt);
    assert.ok(requests.some((url) => url.includes('variant=full')));
  });

  it('one publisher on two feeds is single-publisher, and an unstated figure is listed', async () => {
    const result = await callTool({ claim: 'Panama earthquake kills 200' });
    assert.equal(result.found, true);
    assert.equal(result.state, 'single-publisher');
    assert.deepEqual(result.corroboration, { state: 'single-publisher', publishers: 1 });
    assert.deepEqual(result.figures, { claimed: ['200'], grounded: [], ungrounded: ['200'] });
  });

  it('a claim nobody carries is not found, never false', async () => {
    const result = await callTool({ claim: 'Mars colony declares independence from Earth' });
    assert.equal(result.found, false);
    assert.equal(result.state, 'not-found');
    assert.deepEqual(result.corroboration, { state: 'unknown', publishers: null });
    assert.deepEqual(result.headlines, []);
    assert.equal(result.matchedClusters, 0);
    assert.doesNotMatch(JSON.stringify(result), /\bfalse claim\b|\bfake\b|\bdebunked\b/i);
  });

  it('an unavailable digest is unknown, not not-found: nothing was searched', async () => {
    digest = unavailableDigest;
    const result = await callTool({ claim: 'Trump strikes diesel deal with Putin' });
    assert.equal(result.found, false);
    assert.equal(result.state, 'unknown');
    assert.equal(result.digestCoverage?.state, 'unavailable');
  });

  it('rejects an empty claim without fetching', async () => {
    const result = await callTool({ claim: '   ' });
    assert.equal(result.error, 'claim is required');
    assert.equal(requests.filter((url) => url.includes('list-feed-digest')).length, 0);
  });

  it('found and not-found results both carry every documented required key', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const schema = documentedOutputSchema((await listed.json()).result.tools.find((t) => t.name === 'verify_claim'));
    for (const claim of ['Trump strikes diesel deal with Putin', 'Mars colony declares independence from Earth']) {
      const result = await callTool({ claim });
      for (const key of schema.required) assert.ok(key in result, `${claim}: missing required output key ${key}`);
    }
  });
});
