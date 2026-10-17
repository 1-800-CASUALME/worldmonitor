// Shipping v2 webhooks were registered and documented but nothing delivered
// them (#9217). These suites drive the relay dispatcher end to end against an
// in-memory Redis that speaks the Upstash pipeline shape.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  THREAT_LEVEL,
  computeDisruptionScore,
  warningComponent,
  aisComponent,
} from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';

const require = createRequire(import.meta.url);
const dispatch = require('../scripts/lib/shipping-webhook-dispatch.cjs');
const {
  BACKFILL_MARKER_KEY,
  CHOKEPOINT_STATUS_KEY,
  FAILURE_CEILING,
  GLOBAL_INDEX_KEY,
  LAST_RUN_KEY,
  LAST_RUN_META_KEY,
  REASONS,
  RECORD_DELIVERY_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  REMOVE_EXPIRED_MEMBER_SCRIPT,
  THREAT_POINTS_BY_TIER,
  advanceEdgeState,
  buildLastRun,
  lastRunWrites,
  runShippingWebhookDispatch,
  scoreBreakdown,
  sendDelivery,
  stateKey,
  webhookKey,
} = dispatch;

const NOW = Date.parse('2026-10-17T12:00:00Z');

// The documented receiver recipe (docs/api-shipping-v2.mdx, "Verifying deliveries").
function verifyWorldMonitorWebhook(rawBody, header, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function createFakeRedis() {
  const strings = new Map();
  const sets = new Map();
  const ttls = new Map();
  const calls = [];
  const run = (command) => {
    const [op, ...args] = command;
    switch (op) {
      case 'GET': return strings.has(args[0]) ? strings.get(args[0]) : null;
      case 'SET': {
        const [key, value, ...flags] = args;
        if (flags.includes('NX') && strings.has(key)) return null;
        strings.set(key, value);
        const ex = flags.indexOf('EX');
        if (ex !== -1) ttls.set(key, Number(flags[ex + 1]));
        else if (!flags.includes('KEEPTTL')) ttls.delete(key);
        return 'OK';
      }
      case 'DEL': return strings.delete(args[0]) ? 1 : 0;
      case 'SADD': {
        const set = sets.get(args[0]) ?? new Set();
        sets.set(args[0], set);
        let added = 0;
        for (const member of args.slice(1)) if (!set.has(member)) { set.add(member); added += 1; }
        return added;
      }
      case 'SMEMBERS': return [...(sets.get(args[0]) ?? [])];
      case 'SCAN': {
        const pattern = new RegExp(`^${args[2].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return ['0', [...strings.keys()].filter((key) => pattern.test(key))];
      }
      case 'EVAL': {
        const [script, , ...rest] = args;
        if (script === REMOVE_EXPIRED_MEMBER_SCRIPT) {
          const [setKey, recordKey, member] = rest;
          if (strings.has(recordKey)) return 0;
          return sets.get(setKey)?.delete(member) ? 1 : 0;
        }
        if (script === RELEASE_LOCK_SCRIPT) {
          const [key, token] = rest;
          if (strings.get(key) !== token) return 0;
          strings.delete(key);
          return 1;
        }
        if (script === RECORD_DELIVERY_SCRIPT) {
          const [key, at, status, ok, ceiling, error] = rest;
          if (!strings.has(key)) return 0;
          const rec = JSON.parse(strings.get(key));
          rec.lastDeliveryAt = at;
          rec.lastStatus = Number(status);
          if (ok === '1') {
            rec.failureCount = 0;
            delete rec.lastError;
          } else {
            rec.failureCount = (Number(rec.failureCount) || 0) + 1;
            rec.lastError = error;
            if (rec.failureCount >= Number(ceiling)) rec.active = false;
          }
          strings.set(key, JSON.stringify(rec));
          return rec.active === false ? 2 : 1;
        }
        throw new Error('unknown script');
      }
      default: throw new Error(`unsupported ${op}`);
    }
  };
  const redis = async (commands) => {
    calls.push(commands);
    return commands.map((command) => ({ result: run(command) }));
  };
  return { redis, strings, sets, ttls, calls };
}

function chokepoint(overrides = {}) {
  return {
    id: 'suez',
    name: 'Suez Canal',
    disruptionScore: 74,
    status: 'red',
    activeWarnings: 1,
    aisDisruptions: 1,
    congestionLevel: 'elevated',
    warRiskTier: 'WAR_RISK_TIER_HIGH',
    navigationalWarningsAvailable: true,
    aisSnapshotAvailable: true,
    transitSummary: { dataAvailable: true },
    description: 'test',
    ...overrides,
  };
}

function seedStatus(fake, chokepoints, fetchedAt = new Date(NOW - 60_000).toISOString()) {
  fake.strings.set(CHOKEPOINT_STATUS_KEY, JSON.stringify({ chokepoints, fetchedAt, upstreamUnavailable: false }));
}

function seedSubscriber(fake, overrides = {}, { indexed = true } = {}) {
  const record = {
    subscriberId: 'wh_aaaaaaaaaaaaaaaaaaaaaaaa',
    ownerTag: 'owner',
    callbackUrl: 'https://hooks.example.com/wm',
    chokepointIds: ['suez'],
    alertThreshold: 60,
    createdAt: '2026-10-01T00:00:00Z',
    active: true,
    secret: 'a'.repeat(64),
    ...overrides,
  };
  fake.strings.set(webhookKey(record.subscriberId), JSON.stringify(record));
  fake.ttls.set(webhookKey(record.subscriberId), 86400 * 30);
  if (indexed) {
    const set = fake.sets.get(GLOBAL_INDEX_KEY) ?? new Set();
    set.add(record.subscriberId);
    fake.sets.set(GLOBAL_INDEX_KEY, set);
  }
  return record;
}

function markBackfilled(fake) {
  fake.strings.set(BACKFILL_MARKER_KEY, '2026-10-01T00:00:00Z');
}

function recordingSender(outcomes = []) {
  const sent = [];
  const send = async (record, payload, deliveryId) => {
    sent.push({ record, payload, deliveryId });
    return outcomes.length ? outcomes.shift() : { ok: true, status: 200 };
  };
  return { send, sent };
}

describe('scoreBreakdown', () => {
  it('mirrors the server scoring constants', () => {
    assert.deepEqual(
      {
        WAR_RISK_TIER_WAR_ZONE: THREAT_LEVEL.war_zone,
        WAR_RISK_TIER_CRITICAL: THREAT_LEVEL.critical,
        WAR_RISK_TIER_HIGH: THREAT_LEVEL.high,
        WAR_RISK_TIER_ELEVATED: THREAT_LEVEL.elevated,
        WAR_RISK_TIER_NORMAL: THREAT_LEVEL.normal,
      },
      { ...THREAT_POINTS_BY_TIER },
    );
    for (const warnings of [0, 1, 2, 5]) {
      for (const [level, severity] of [['normal', 0], ['low', 1], ['elevated', 2], ['high', 3]]) {
        const score = computeDisruptionScore(THREAT_LEVEL.high, warnings, severity);
        const { components } = scoreBreakdown(chokepoint({
          disruptionScore: score, activeWarnings: warnings, congestionLevel: level,
        }));
        assert.equal(components.navigationalWarnings, warningComponent(warnings));
        assert.equal(components.aisCongestion, aisComponent(severity));
        assert.equal(components.transitDrop, 0);
      }
    }
  });

  it('names the largest live signal, or score_threshold for baseline-only scores', () => {
    assert.equal(scoreBreakdown(chokepoint({ activeWarnings: 1, congestionLevel: 'high', disruptionScore: 50 })).reason, 'ais_congestion_spike');
    assert.equal(scoreBreakdown(chokepoint({ activeWarnings: 3, congestionLevel: 'low', disruptionScore: 50 })).reason, 'navigational_warning');
    const drop = scoreBreakdown(chokepoint({ activeWarnings: 0, congestionLevel: 'normal', disruptionScore: 40 }));
    assert.equal(drop.reason, 'transit_drop');
    assert.equal(drop.components.transitDrop, 10);
    assert.equal(scoreBreakdown(chokepoint({
      warRiskTier: 'WAR_RISK_TIER_WAR_ZONE', activeWarnings: 0, congestionLevel: 'normal', disruptionScore: 70,
    })).reason, 'score_threshold');
    assert.deepEqual([...REASONS], ['ais_congestion_spike', 'navigational_warning', 'transit_drop', 'score_threshold']);
  });

  it('breaks ties in REASONS order', () => {
    assert.equal(scoreBreakdown(chokepoint({ activeWarnings: 2, congestionLevel: 'elevated', disruptionScore: 50 })).reason, 'ais_congestion_spike');
  });
});

describe('advanceEdgeState', () => {
  const now = '2026-10-17T12:00:00.000Z';

  it('fires on an upward crossing and holds while the score stays above', () => {
    const first = advanceEdgeState(undefined, chokepoint({ disruptionScore: 74 }), 60, now);
    assert.deepEqual(first.attempt, { triggeredAt: now, score: 74 });
    const fired = { phase: 'fired', triggeredAt: now };
    assert.equal(advanceEdgeState(fired, chokepoint({ disruptionScore: 90 }), 60, now).attempt, null);
  });

  it('treats the threshold itself as a crossing', () => {
    assert.ok(advanceEdgeState({ phase: 'armed' }, chokepoint({ disruptionScore: 60 }), 60, now).attempt);
  });

  it('re-arms only on a complete-coverage reading below the threshold', () => {
    const fired = { phase: 'fired', triggeredAt: now };
    assert.deepEqual(advanceEdgeState(fired, chokepoint({ disruptionScore: 40 }), 60, now).next, { phase: 'armed' });
    assert.deepEqual(
      advanceEdgeState(fired, chokepoint({ disruptionScore: 40, navigationalWarningsAvailable: false }), 60, now).next,
      fired,
    );
    assert.deepEqual(
      advanceEdgeState(fired, chokepoint({ disruptionScore: 40, aisSnapshotAvailable: false }), 60, now).next,
      fired,
    );
  });

  it('retries a pending crossing with its original triggeredAt', () => {
    const pending = { phase: 'pending', triggeredAt: '2026-10-17T11:30:00.000Z' };
    const result = advanceEdgeState(pending, chokepoint({ disruptionScore: 70 }), 60, now);
    assert.equal(result.attempt.triggeredAt, pending.triggeredAt);
  });

  it('leaves state untouched when the score is not a number', () => {
    const fired = { phase: 'fired', triggeredAt: now };
    assert.deepEqual(advanceEdgeState(fired, chokepoint({ disruptionScore: undefined }), 60, now), { next: fired, attempt: null });
  });
});

describe('runShippingWebhookDispatch', () => {
  it('delivers once on a crossing and not again while the score stays above', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint({ disruptionScore: 74 })]);
    const record = seedSubscriber(fake);
    const { send, sent } = recordingSender();

    const first = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(first.delivered, 1);
    assert.equal(sent.length, 1);
    const { payload, deliveryId } = sent[0];
    assert.deepEqual(Object.keys(payload), ['subscriberId', 'chokepointId', 'score', 'alertThreshold', 'triggeredAt', 'reason', 'details']);
    assert.equal(payload.subscriberId, record.subscriberId);
    assert.equal(payload.chokepointId, 'suez');
    assert.equal(payload.score, 74);
    assert.equal(payload.alertThreshold, 60);
    assert.equal(payload.triggeredAt, new Date(NOW).toISOString());
    assert.ok(REASONS.includes(payload.reason));
    assert.match(deliveryId, /^whd_[0-9a-f]{32}$/);

    const stored = JSON.parse(fake.strings.get(webhookKey(record.subscriberId)));
    assert.equal(stored.lastStatus, 200);
    assert.equal(stored.failureCount, 0);
    assert.equal(stored.lastDeliveryAt, new Date(NOW).toISOString());
    assert.equal(fake.ttls.get(webhookKey(record.subscriberId)), 86400 * 30, 'delivery bookkeeping keeps the record TTL');

    seedStatus(fake, [chokepoint({ disruptionScore: 80 })], new Date(NOW + 1_800_000).toISOString());
    const second = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW + 1_800_000 });
    assert.equal(second.delivered, 0);
    assert.equal(sent.length, 1);

    seedStatus(fake, [chokepoint({ disruptionScore: 30 })], new Date(NOW + 3_600_000).toISOString());
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW + 3_600_000 });
    seedStatus(fake, [chokepoint({ disruptionScore: 65 })], new Date(NOW + 5_400_000).toISOString());
    const rearmed = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW + 5_400_000 });
    assert.equal(rearmed.delivered, 1, 'a drop below the threshold re-arms the alert');
    assert.notEqual(sent[1].deliveryId, sent[0].deliveryId);
  });

  it('signs the exact body with the subscription secret', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    const record = seedSubscriber(fake);
    const posted = [];
    const send = (rec, payload, deliveryId) => sendDelivery(rec, payload, deliveryId, {
      assertSafe: async (url) => ({ url: new URL(url), resolvedAddresses: ['93.184.216.34'] }),
      post: async (url, body, headers, addresses) => {
        posted.push({ url, body, headers, addresses });
        return { status: 204 };
      },
    });
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(posted.length, 1);
    const [{ body, headers, addresses }] = posted;
    assert.equal(headers['x-wm-event'], 'chokepoint.disruption');
    assert.match(headers['x-wm-delivery-id'], /^whd_[0-9a-f]{32}$/);
    assert.equal(headers['content-type'], 'application/json');
    assert.ok(verifyWorldMonitorWebhook(body, headers['x-wm-signature'], record.secret));
    assert.ok(!verifyWorldMonitorWebhook(body, headers['x-wm-signature'], 'b'.repeat(64)));
    assert.deepEqual(addresses, ['93.184.216.34']);
  });

  it('skips subscribers not watching the chokepoint and scores below the threshold', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint({ id: 'suez', disruptionScore: 74 }), chokepoint({ id: 'panama', disruptionScore: 10 })]);
    seedSubscriber(fake, { chokepointIds: ['panama'] });
    seedSubscriber(fake, { subscriberId: 'wh_bbbbbbbbbbbbbbbbbbbbbbbb', alertThreshold: 80 });
    const { send, sent } = recordingSender();
    const summary = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(summary.active, 2);
    assert.equal(sent.length, 0);
  });

  it('retries a failed delivery with the same delivery id and deactivates at the ceiling', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    const record = seedSubscriber(fake);
    const failures = Array.from({ length: FAILURE_CEILING }, () => ({ ok: false, status: 500, error: 'http_500' }));
    const { send, sent } = recordingSender(failures);
    let deactivated = 0;
    for (let tick = 0; tick < FAILURE_CEILING + 1; tick += 1) {
      const at = NOW + tick * 1_800_000;
      seedStatus(fake, [chokepoint({ disruptionScore: 74 })], new Date(at - 60_000).toISOString());
      const summary = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => at });
      deactivated += summary.deactivated;
    }
    assert.equal(sent.length, FAILURE_CEILING, 'no delivery is attempted once inactive');
    assert.equal(new Set(sent.map((entry) => entry.deliveryId)).size, 1, 'retries reuse X-WM-Delivery-Id');
    assert.equal(new Set(sent.map((entry) => entry.payload.triggeredAt)).size, 1);
    assert.equal(deactivated, 1);
    const stored = JSON.parse(fake.strings.get(webhookKey(record.subscriberId)));
    assert.equal(stored.active, false);
    assert.equal(stored.failureCount, FAILURE_CEILING);
    assert.equal(stored.lastStatus, 500);
    assert.equal(stored.lastError, 'http_500');
    assert.equal(stored.secret, record.secret);
  });

  it('resumes the pending delivery once the subscription is reactivated', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    const record = seedSubscriber(fake, { active: false, failureCount: FAILURE_CEILING });
    fake.strings.set(stateKey(record.subscriberId), JSON.stringify({ suez: { phase: 'pending', triggeredAt: '2026-10-17T09:00:00.000Z' } }));
    seedStatus(fake, [chokepoint()]);
    const { send, sent } = recordingSender();
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(sent.length, 0);

    // What the reactivate route writes.
    fake.strings.set(webhookKey(record.subscriberId), JSON.stringify({ ...record, active: true, failureCount: 0 }));
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.triggeredAt, '2026-10-17T09:00:00.000Z');
  });

  it('counts SSRF refusals as failures without sending', async () => {
    const outcome = await sendDelivery(
      { callbackUrl: 'https://internal.example/hook', secret: 's' },
      { subscriberId: 'wh_x' },
      'whd_x',
      { assertSafe: async () => { const e = new Error('blocked'); e.code = 'ERR_SSRF_BLOCKED'; throw e; }, post: async () => { throw new Error('must not post'); } },
    );
    assert.deepEqual(outcome, { ok: false, status: 0, error: 'ssrf_blocked' });
  });

  it('really refuses a private callback through the shared relay guard', async () => {
    const outcome = await sendDelivery(
      { callbackUrl: 'https://127.0.0.1/hook', secret: 's' },
      { subscriberId: 'wh_x' },
      'whd_x',
      { post: async () => { throw new Error('must not post'); } },
    );
    assert.equal(outcome.error, 'ssrf_blocked');
  });

  it('stops delivering to a subscriber for the rest of the tick after a failure', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint({ id: 'suez' }), chokepoint({ id: 'hormuz_strait' })]);
    const record = seedSubscriber(fake, { chokepointIds: ['suez', 'hormuz_strait'] });
    const { send, sent } = recordingSender([{ ok: false, status: 0, error: 'timeout' }]);
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(sent.length, 1);
    const state = JSON.parse(fake.strings.get(stateKey(record.subscriberId)));
    assert.equal(state.suez.phase, 'pending');
    assert.equal(state.hormuz_strait.phase, 'pending');

    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW + 60_000 });
    assert.deepEqual(sent.slice(1).map((entry) => entry.payload.chokepointId), ['suez', 'hormuz_strait']);
  });

  it('prunes expired subscribers from the global index', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    fake.sets.set(GLOBAL_INDEX_KEY, new Set(['wh_cccccccccccccccccccccccc']));
    const summary = await runShippingWebhookDispatch({ redis: fake.redis, send: recordingSender().send, now: () => NOW });
    assert.equal(summary.expired, 1);
    assert.deepEqual([...fake.sets.get(GLOBAL_INDEX_KEY)], []);
  });

  it('delivers nothing from a stale or missing chokepoint payload', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedSubscriber(fake);
    const { send, sent } = recordingSender();
    assert.equal((await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW })).skipped, 'source_missing');
    fake.strings.set(CHOKEPOINT_STATUS_KEY, '__WM_NEG__');
    assert.equal((await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW })).skipped, 'source_missing');
    seedStatus(fake, [chokepoint()], new Date(NOW - 3 * 3_600_000).toISOString());
    assert.equal((await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW })).skipped, 'source_stale');
    assert.equal(sent.length, 0);
  });

  it('yields to a concurrent dispatch holding the lock and releases its own', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    fake.strings.set('webhook:dispatch:lock:v1', 'other');
    const locked = await runShippingWebhookDispatch({ redis: fake.redis, send: recordingSender().send, now: () => NOW });
    assert.equal(locked.skipped, 'locked');
    fake.strings.delete('webhook:dispatch:lock:v1');
    await runShippingWebhookDispatch({ redis: fake.redis, send: recordingSender().send, now: () => NOW });
    assert.equal(fake.strings.has('webhook:dispatch:lock:v1'), false);
  });

  it('throws when Redis cannot be read', async () => {
    const redis = async (commands) => commands.map(() => ({ error: 'ERR down' }));
    await assert.rejects(runShippingWebhookDispatch({ redis, now: () => NOW }), /Redis pipeline failed/);
  });
});

describe('review hardening', () => {
  const now = '2026-10-17T12:00:00.000Z';

  it('re-arms a transit-drop crossing only once transit data is back', () => {
    const fired = { phase: 'fired', triggeredAt: now, transitDrop: true };
    const below = (dataAvailable) => chokepoint({ disruptionScore: 30, transitSummary: { dataAvailable } });
    assert.deepEqual(advanceEdgeState(fired, below(false), 60, now).next, fired);
    assert.deepEqual(advanceEdgeState(fired, below(true), 60, now).next, { phase: 'armed' });
    const plain = { phase: 'fired', triggeredAt: now };
    assert.deepEqual(advanceEdgeState(plain, below(false), 60, now).next, { phase: 'armed' }, 'no transit drop, no transit requirement');
  });

  it('records a transit drop on the crossing that carried one', () => {
    const drop = advanceEdgeState(undefined, chokepoint({ activeWarnings: 0, congestionLevel: 'normal', disruptionScore: 40 }), 35, now);
    assert.equal(drop.next.transitDrop, true);
    const noDrop = advanceEdgeState(undefined, chokepoint({ activeWarnings: 1, congestionLevel: 'elevated', disruptionScore: 45 }), 40, now);
    assert.equal(noDrop.next.transitDrop, undefined);
  });

  it('drops a pending crossing once the score falls below with full coverage', () => {
    const pending = { phase: 'pending', triggeredAt: now };
    assert.deepEqual(advanceEdgeState(pending, chokepoint({ disruptionScore: 30 }), 60, now), { next: { phase: 'armed' }, attempt: null });
  });

  it('keeps the delivery id when the post-send state write is lost', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    const record = seedSubscriber(fake);
    let dropFiredWrite = true;
    const redis = async (commands) => {
      const first = commands[0];
      if (dropFiredWrite && first[0] === 'SET' && first[1] === stateKey(record.subscriberId) && first[2].includes('"fired"')) {
        dropFiredWrite = false;
        return commands.map(() => ({ error: 'ERR synthetic' }));
      }
      return fake.redis(commands);
    };
    const { send, sent } = recordingSender();
    const first = await runShippingWebhookDispatch({ redis, send, now: () => NOW });
    assert.equal(first.writeErrors, 1);
    assert.equal(buildLastRun(first, NOW).status, 'error');
    await runShippingWebhookDispatch({ redis, send, now: () => NOW + 1_800_000 });
    assert.equal(sent.length, 2, 'at-least-once: the lost write re-sends');
    assert.equal(sent[1].deliveryId, sent[0].deliveryId, 'with the same X-WM-Delivery-Id');
  });

  it('sends nothing when the pending state cannot be persisted', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    const record = seedSubscriber(fake);
    const redis = async (commands) => (commands.length === 1 && commands[0][0] === 'SET' && commands[0][1] === stateKey(record.subscriberId)
      ? [{ error: 'ERR synthetic' }]
      : fake.redis(commands));
    const { send, sent } = recordingSender();
    const summary = await runShippingWebhookDispatch({ redis, send, now: () => NOW });
    assert.equal(sent.length, 0);
    assert.equal(summary.writeErrors, 1);
  });

  it('does not overwrite a secret rotated while the delivery was in flight', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    const record = seedSubscriber(fake);
    const rotated = 'c'.repeat(64);
    const send = async () => {
      fake.strings.set(webhookKey(record.subscriberId), JSON.stringify({ ...record, secret: rotated }));
      return { ok: false, status: 502, error: 'http_502' };
    };
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    const stored = JSON.parse(fake.strings.get(webhookKey(record.subscriberId)));
    assert.equal(stored.secret, rotated);
    assert.equal(stored.failureCount, 1);
    assert.equal(stored.lastStatus, 502);
  });

  it('leaves failure counts alone when every attempted callback fails in transport', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    const a = seedSubscriber(fake);
    const b = seedSubscriber(fake, { subscriberId: 'wh_bbbbbbbbbbbbbbbbbbbbbbbb' });
    const { send } = recordingSender([{ ok: false, status: 0, error: 'network_error' }, { ok: false, status: 0, error: 'timeout' }]);
    const summary = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(summary.egressOutage, true);
    for (const rec of [a, b]) {
      const stored = JSON.parse(fake.strings.get(webhookKey(rec.subscriberId)));
      assert.equal(stored.failureCount, undefined);
      assert.equal(JSON.parse(fake.strings.get(stateKey(rec.subscriberId))).suez.phase, 'pending');
    }
  });

  it('still counts transport failures when another subscriber was reached', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint()]);
    seedSubscriber(fake);
    seedSubscriber(fake, { subscriberId: 'wh_bbbbbbbbbbbbbbbbbbbbbbbb' });
    const { send } = recordingSender([{ ok: false, status: 0, error: 'timeout' }, { ok: true, status: 200 }]);
    const summary = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(summary.egressOutage, false);
    assert.equal(summary.failed, 1);
    assert.equal(summary.delivered, 1);
  });

  it('stops starting sends past the tick budget and leaves the rest pending', async () => {
    const fake = createFakeRedis();
    markBackfilled(fake);
    seedStatus(fake, [chokepoint({ id: 'suez' }), chokepoint({ id: 'hormuz_strait' })]);
    const record = seedSubscriber(fake, { chokepointIds: ['suez', 'hormuz_strait'] });
    let clock = NOW;
    const { sent } = recordingSender();
    const send = async (_rec, payload, id) => {
      sent.push({ payload, id });
      clock = NOW + 21 * 60_000;
      return { ok: true, status: 200 };
    };
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => clock });
    assert.equal(sent.length, 1);
    const state = JSON.parse(fake.strings.get(stateKey(record.subscriberId)));
    assert.equal(state.suez.phase, 'fired');
    assert.equal(state.hormuz_strait.phase, 'pending');
  });

  it('serves indexed subscribers when the backfill scan fails', async () => {
    const fake = createFakeRedis();
    seedStatus(fake, [chokepoint()]);
    seedSubscriber(fake);
    const redis = async (commands) => (commands[0][0] === 'SCAN' ? [{ error: 'ERR synthetic' }] : fake.redis(commands));
    const logs = [];
    const { send, sent } = recordingSender();
    await runShippingWebhookDispatch({ redis, send, now: () => NOW, log: (m) => logs.push(m) });
    assert.equal(sent.length, 1);
    assert.ok(logs.some((m) => /backfill failed/.test(m)));
    assert.equal(fake.strings.has(BACKFILL_MARKER_KEY), false, 'retried next tick');
  });

  it('expires the backfill marker so the scan re-runs daily', async () => {
    const fake = createFakeRedis();
    seedStatus(fake, [chokepoint()]);
    await runShippingWebhookDispatch({ redis: fake.redis, send: recordingSender().send, now: () => NOW });
    assert.equal(fake.ttls.get(BACKFILL_MARKER_KEY), 86400);
  });

  it('reports DNS failures as dns_error, not an SSRF refusal', async () => {
    const forced = await sendDelivery(
      { callbackUrl: 'https://hooks.example.com/wm', secret: 's' },
      { subscriberId: 'wh_x' },
      'whd_x',
      {
        assertSafe: (url) => require('../scripts/lib/notification-webhook-ssrf.cjs')
          .assertNotificationWebhookDeliveryUrlSafe(url, async () => { throw new Error('ENOTFOUND'); }),
        post: async () => { throw new Error('must not post'); },
      },
    );
    assert.deepEqual(forced, { ok: false, status: 0, error: 'dns_error' });
  });
});

describe('relay wiring', () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const warmPing = relay.slice(relay.indexOf('async function seedChokepointWarmPing()'), relay.indexOf('async function runShippingWebhookDispatchTick()'));

  it('dispatches after every warm-ping outcome', () => {
    assert.match(warmPing, /finally \{\s*(\/\/[^\n]*\n\s*)*await runShippingWebhookDispatchTick\(\);\s*\}/);
  });

  it('never overlaps two dispatch ticks in one process', () => {
    const tick = relay.slice(relay.indexOf('async function runShippingWebhookDispatchTick()'));
    assert.match(tick, /if \(shippingWebhookDispatchInFlight\) return;/);
  });
});

describe('global subscriber index backfill', () => {
  it('indexes records registered before the index existed, once', async () => {
    const fake = createFakeRedis();
    seedStatus(fake, [chokepoint()]);
    const legacy = seedSubscriber(fake, {}, { indexed: false });
    fake.strings.set('webhook:sub:not-a-subscriber:v1', '{}');
    const { send, sent } = recordingSender();
    const summary = await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(summary.backfilled, 1);
    assert.deepEqual([...fake.sets.get(GLOBAL_INDEX_KEY)], [legacy.subscriberId]);
    assert.equal(sent.length, 1, 'a backfilled subscriber is delivered on the same tick');
    assert.ok(fake.strings.has(BACKFILL_MARKER_KEY));

    const scans = () => fake.calls.flat().filter((command) => command[0] === 'SCAN').length;
    const before = scans();
    await runShippingWebhookDispatch({ redis: fake.redis, send, now: () => NOW });
    assert.equal(scans(), before, 'the marker stops later SCANs');
  });
});

describe('health heartbeat', () => {
  it('writes recordCount 1 to the keys api/health.js reads', () => {
    const health = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
    assert.ok(new RegExp(`shippingWebhookDelivery:\\s+'${LAST_RUN_KEY}'`).test(health), 'STANDALONE_KEYS entry');
    assert.ok(new RegExp(`shippingWebhookDelivery: \\{\\s+key: '${LAST_RUN_META_KEY}',\\s+maxStaleMin: 90,\\s+activationKey: '${dispatch.ACTIVATION_KEY}'`).test(health), 'SEED_META entry');
    assert.ok(health.includes('shippingWebhookDelivery: SEED_META.shippingWebhookDelivery.activationKey'), 'ACTIVATION_MARKERS entry');
    const run = buildLastRun({ subscribers: 0 }, NOW);
    assert.equal(run.recordCount, 1);
    assert.equal(run.status, 'ok');
    const failed = buildLastRun(null, NOW, new Error('dispatch read: Redis pipeline failed'));
    assert.equal(failed.status, 'error');
    assert.match(failed.errorReason, /Redis pipeline failed/);
    assert.deepEqual(lastRunWrites(run).map((command) => command[1]), [LAST_RUN_KEY, LAST_RUN_META_KEY, dispatch.ACTIVATION_KEY]);
    assert.deepEqual(lastRunWrites(run)[2], ['SET', dispatch.ACTIVATION_KEY, '1'], 'marker has no TTL');
  });
});
