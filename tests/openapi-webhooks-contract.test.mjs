import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadUnifiedOpenApiSpec } from './_lib/openapi-spec-cache.mjs';

import {
  injectYamlWebhooks,
  WEBHOOK_EVENT,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_ID_HEADER,
} from '../scripts/openapi-inject-webhooks.mjs';

// Guards the outbound webhook-delivery contract injected into the OpenAPI bundle
// by scripts/openapi-inject-webhooks.mjs (orank Access — "webhook signing
// referenced but no branded signature header identified"). The published spec
// (public/openapi.json ← docs/api/worldmonitor.openapi.yaml) must name the
// branded X-WM-Signature header and describe how to verify it, and that
// documented contract must not drift from what the delivery worker actually
// sends (scripts/lib/shipping-webhook-dispatch.cjs, run by the AIS relay).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'docs/api/worldmonitor.openapi.yaml');

const bundleRaw = readFileSync(bundlePath, 'utf8');
const bundle = loadUnifiedOpenApiSpec();
const dispatch = createRequire(import.meta.url)('../scripts/lib/shipping-webhook-dispatch.cjs');

const sampleRecord = {
  subscriberId: 'wh_1a2b3c4d5e6f7a8b9c0d1e2f', callbackUrl: 'https://hooks.example.com/wm',
  chokepointIds: ['suez'], alertThreshold: 50, active: true, secret: 'a'.repeat(64),
};
const sampleChokepoint = {
  id: 'suez', name: 'Suez Canal', disruptionScore: 72, status: 'red', activeWarnings: 2,
  aisDisruptions: 1, congestionLevel: 'elevated', warRiskTier: 'WAR_RISK_TIER_CRITICAL',
  navigationalWarningsAvailable: true, aisSnapshotAvailable: true, description: 'test',
};
const samplePayload = dispatch.buildPayload(sampleRecord, sampleChokepoint, { score: 72, triggeredAt: '2026-07-04T12:34:56Z' });

async function captureDelivery() {
  const seen = {};
  const outcome = await dispatch.sendDelivery(sampleRecord, samplePayload, 'whd_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', {
    assertSafe: async (url) => ({ url: new URL(url), resolvedAddresses: ['93.184.216.34'] }),
    post: async (_url, body, headers) => { Object.assign(seen, { body, headers }); return { status: 200 }; },
  });
  assert.equal(outcome.ok, true);
  return seen;
}

const webhook = bundle.webhooks?.[WEBHOOK_EVENT]?.post;

describe('OpenAPI webhooks contract', () => {
  it('bundle documents the chokepoint.disruption outbound webhook', () => {
    assert.ok(bundle.webhooks, 'bundle must carry a top-level `webhooks` object');
    assert.ok(webhook, `bundle.webhooks['${WEBHOOK_EVENT}'].post must exist`);
    assert.equal(webhook.operationId, 'ChokepointDisruptionWebhook');
    // The delivery is outbound (the consumer receives it), so it carries no API
    // key — document it as unauthenticated to the consumer, authenticated by the
    // signature instead.
    assert.deepEqual(webhook.security, [], 'outbound webhook must document security: []');
  });

  it('documents the three branded delivery headers as required header params', () => {
    const headerParams = (webhook.parameters ?? []).filter((p) => p.in === 'header');
    const byName = new Map(headerParams.map((p) => [p.name, p]));
    for (const name of [SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_ID_HEADER]) {
      const p = byName.get(name);
      assert.ok(p, `missing header parameter ${name}`);
      assert.equal(p.required, true, `${name} must be required`);
      assert.equal(p.schema?.type, 'string', `${name} schema must be a string`);
    }
  });

  it('the signature header schema constrains the sha256=<hex> format', () => {
    const sig = webhook.parameters.find((p) => p.name === SIGNATURE_HEADER);
    assert.equal(sig.schema.pattern, '^sha256=[0-9a-f]{64}$');
  });

  it('the delivery id header schema constrains the whd_<32hex> format', () => {
    const deliveryId = webhook.parameters.find((p) => p.name === DELIVERY_ID_HEADER);
    assert.equal(deliveryId.schema.pattern, '^whd_[0-9a-f]{32}$');
  });

  it('documents a verification recipe (HMAC-SHA256, constant-time compare)', () => {
    const desc = webhook.description ?? '';
    for (const needle of ['HMAC-SHA256', 'constant time', 'secret', 'do not hex-decode']) {
      assert.ok(desc.includes(needle), `webhook description must mention "${needle}"`);
    }
  });

  it('payload schema matches the payload the worker builds', () => {
    const schema = webhook.requestBody.content['application/json'].schema;
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(samplePayload).sort());
    // details is the only optional field.
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(samplePayload).filter((name) => name !== 'details').sort(),
    );
  });

  it('documents the reason enum the worker emits', () => {
    const schema = webhook.requestBody.content['application/json'].schema;
    assert.deepEqual(schema.properties.reason.enum, [...dispatch.REASONS]);
    assert.ok(dispatch.REASONS.includes(samplePayload.reason));
    assert.ok(dispatch.REASONS.includes(webhook.requestBody.content['application/json'].example.reason));
  });

  it('documented headers match what the delivery worker actually sends', async () => {
    const { headers } = await captureDelivery();
    const sent = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
    for (const name of [SIGNATURE_HEADER, EVENT_HEADER, DELIVERY_ID_HEADER]) {
      assert.ok(sent.has(name.toLowerCase()), `worker must send the ${name} header it documents`);
    }
  });

  it('the worker signs with the documented HMAC-SHA256 recipe', async () => {
    const { body, headers } = await captureDelivery();
    const expected = 'sha256=' + createHmac('sha256', sampleRecord.secret).update(body).digest('hex');
    assert.equal(headers[SIGNATURE_HEADER.toLowerCase()], expected);
    assert.match(headers[SIGNATURE_HEADER.toLowerCase()], new RegExp(webhook.parameters.find((p) => p.name === SIGNATURE_HEADER).schema.pattern));
  });

  it('the worker sends the documented event name', async () => {
    const { headers } = await captureDelivery();
    assert.equal(headers[EVENT_HEADER.toLowerCase()], WEBHOOK_EVENT);
    assert.equal(dispatch.WEBHOOK_EVENT, WEBHOOK_EVENT);
  });

  it('the committed bundle is up to date with the injector (idempotent)', () => {
    const result = injectYamlWebhooks(bundleRaw);
    assert.equal(result.changed, false, 'run `npm run gen:openapi:webhooks` — committed bundle is stale');
  });

  it('documents a body-agnostic any-2xx acknowledgement', () => {
    assert.equal(webhook.responses?.['200'], undefined, 'webhook must not invent an exact 200 response');
    const acknowledgement = webhook.responses?.['2XX'];
    assert.ok(acknowledgement, 'webhook must document the any-2xx acknowledgement');
    assert.equal(
      acknowledgement.content,
      undefined,
      'acknowledgement must not require a response body or media type',
    );
    assert.match(acknowledgement.description ?? '', /any 2xx/i);
  });

  it('webhooks live at the top level, not under paths (no phantom REST op)', () => {
    assert.ok(!('/webhooks/chokepoint.disruption' in (bundle.paths ?? {})));
    assert.equal(Object.keys(bundle.webhooks).length, 1);
  });
});

// The published, verifiable sample delivery (public/.well-known/webhook-sample.json)
// lets an agent confirm its HMAC verification end-to-end BEFORE registering a live
// webhook (orank Usability — "webhook signature verification"). This guards it
// against drift: the committed signature MUST be the genuine HMAC of the committed
// body+secret, and the scheme must match the documented + worker contract.
describe('webhook verification fixture (/.well-known/webhook-sample.json)', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(root, 'public/.well-known/webhook-sample.json'), 'utf8'),
  );

  it('the committed signature is the genuine HMAC-SHA256 of body keyed by secret', () => {
    const expected = 'sha256=' + createHmac('sha256', fixture.secret).update(fixture.body).digest('hex');
    assert.equal(fixture.signature, expected, 'fixture signature is stale — recompute it from body+secret');
  });

  it('the sample matches the documented signing scheme', () => {
    assert.equal(fixture.algorithm, 'HMAC-SHA256');
    assert.equal(fixture.signatureHeader, SIGNATURE_HEADER);
    assert.equal(fixture.event, WEBHOOK_EVENT);
    // Same shape the OpenAPI signature-header schema constrains (^sha256=[0-9a-f]{64}$).
    assert.match(fixture.signature, /^sha256=[0-9a-f]{64}$/);
    // Sample secret uses the real registration format (raw 64-char lowercase hex).
    assert.match(fixture.secret, /^[0-9a-f]{64}$/);
  });

  it('the signature does NOT match if the body is tampered (guards the recipe)', () => {
    const tampered = fixture.body.replace('"score":72', '"score":99');
    const forged = 'sha256=' + createHmac('sha256', fixture.secret).update(tampered).digest('hex');
    assert.notEqual(fixture.signature, forged, 'a mutated body must not verify against the sample signature');
  });

  it('the echoed X-WM-Signature header equals the top-level signature', () => {
    assert.equal(fixture.headers?.['X-WM-Signature'], fixture.signature);
  });
});
