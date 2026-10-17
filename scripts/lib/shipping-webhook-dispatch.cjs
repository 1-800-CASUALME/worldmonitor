'use strict';

// Delivers `chokepoint.disruption` webhooks registered through
// POST /api/v2/shipping/webhooks (#9217). The AIS relay runs one dispatch after
// each chokepoint warm-ping; everything here takes its Redis pipeline and HTTP
// sender as arguments so the data suites can drive it without a network.

const { createHash, createHmac, randomBytes } = require('node:crypto');
const {
  assertNotificationWebhookDeliveryUrlSafe,
  postJsonWithPinnedAddress,
  SSRF_BLOCKED_ERROR_CODE,
} = require('./notification-webhook-ssrf.cjs');

const WEBHOOK_EVENT = 'chokepoint.disruption';
const CHOKEPOINT_STATUS_KEY = 'supply_chain:chokepoints:v4';
const GLOBAL_INDEX_KEY = 'webhook:all:v1';
const BACKFILL_MARKER_KEY = 'webhook:all:backfill:v1';
const DISPATCH_LOCK_KEY = 'webhook:dispatch:lock:v1';
const LAST_RUN_KEY = 'shipping:webhook-delivery:last-run';
const LAST_RUN_META_KEY = 'seed-meta:shipping:webhook-delivery:last-run';
const LAST_RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
// No TTL: ends /api/health's on-demand softening for the heartbeat for good.
const ACTIVATION_KEY = 'seed-activated:shipping:webhook-delivery';
const STATE_TTL_SECONDS = 30 * 24 * 60 * 60;
// The lock outlives the send budget, so a tick that is still delivering is
// never joined by a second dispatcher; both stay under the 30-min cadence.
const LOCK_TTL_SECONDS = 25 * 60;
const SEND_BUDGET_MS = 20 * 60 * 1000;
// Re-run the idempotent backfill daily: the relay and Vercel deploy
// independently, so a registration served by pre-index Vercel code is picked
// up on the next pass instead of never.
const BACKFILL_MARKER_TTL_SECONDS = 24 * 60 * 60;
// Consecutive failed delivery attempts before the subscription is deactivated.
// A pending delivery is retried on every dispatch (30 min), so five failures
// span roughly two hours of an unreachable callback.
const FAILURE_CEILING = 5;
// The status key's own TTL is 5 minutes; this guards a payload whose
// fetchedAt is old even though the key is present.
const SOURCE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SUBSCRIBER_CONCURRENCY = 4;
const BACKFILL_SCAN_COUNT = 500;
const BACKFILL_MAX_SCAN_CALLS = 2000;
const USER_AGENT = 'WorldMonitor-ShippingV2-Webhooks/1.0';
// Failures that say nothing about the subscriber's callback. When every
// subscriber attempted in a tick fails this way, the relay's own egress is the
// likelier fault, so no subscriber's failure count moves.
const TRANSPORT_ERRORS = new Set(['timeout', 'network_error', 'dns_error']);

const REASONS = Object.freeze([
  'ais_congestion_spike',
  'navigational_warning',
  'transit_drop',
  'score_threshold',
]);

// Mirrors server/worldmonitor/supply-chain/v1/_scoring.mjs. The relay image
// does not ship server/, so tests/shipping-webhook-dispatch.test.mjs pins the
// two against each other.
const THREAT_POINTS_BY_TIER = Object.freeze({
  WAR_RISK_TIER_WAR_ZONE: 70,
  WAR_RISK_TIER_CRITICAL: 40,
  WAR_RISK_TIER_HIGH: 30,
  WAR_RISK_TIER_ELEVATED: 15,
  WAR_RISK_TIER_NORMAL: 0,
});
const AIS_POINTS_BY_CONGESTION = Object.freeze({ high: 15, elevated: 10, low: 5 });

function webhookKey(subscriberId) {
  return `webhook:sub:${subscriberId}:v1`;
}

function stateKey(subscriberId) {
  return `webhook:state:${subscriberId}:v1`;
}

// Merges delivery bookkeeping into the live record instead of writing back the
// copy read at the start of the tick, so a rotate-secret or reactivate that
// lands mid-delivery is not overwritten. KEEPTTL leaves the 30-day expiry to
// re-registration, as documented. ARGV[6] = '1' when an earlier send in the
// same tick succeeded, so a later failure counts from zero.
// docker/redis-rest-proxy.mjs pins these bytes; keep the array form so
// tests/redis-rest-proxy-command-parity.test.mjs can prove the copies match.
const RECORD_DELIVERY_SCRIPT = [
  "local raw = redis.call('GET', KEYS[1])",
  'if not raw then return 0 end',
  'local rec = cjson.decode(raw)',
  'rec.lastDeliveryAt = ARGV[1]',
  'rec.lastStatus = tonumber(ARGV[2])',
  "if ARGV[3] == '1' then",
  '  rec.failureCount = 0',
  '  rec.lastError = nil',
  'else',
  "  local base = ARGV[6] == '1' and 0 or (tonumber(rec.failureCount) or 0)",
  '  rec.failureCount = base + 1',
  '  rec.lastError = ARGV[5]',
  '  if rec.failureCount >= tonumber(ARGV[4]) then rec.active = false end',
  'end',
  "redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')",
  'if rec.active == false then return 2 end',
  'return 1',
].join('\n');

const REMOVE_EXPIRED_MEMBER_SCRIPT = "if redis.call('EXISTS', KEYS[2]) == 0 then return redis.call('SREM', KEYS[1], ARGV[1]) else return 0 end";
const RELEASE_LOCK_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/**
 * Splits a chokepoint's disruptionScore into the components
 * get-chokepoint-status adds together, and names the reason for an alert:
 * the largest live signal (AIS congestion, navigational warnings, transit
 * drop), or `score_threshold` when the baseline threat level alone carries
 * the score. Ties resolve in REASONS order.
 */
function scoreBreakdown(chokepoint) {
  const score = Number(chokepoint?.disruptionScore) || 0;
  const threatLevel = THREAT_POINTS_BY_TIER[chokepoint?.warRiskTier] ?? 0;
  const navigationalWarnings = Math.min(15, Math.max(0, Number(chokepoint?.activeWarnings) || 0) * 5);
  const aisCongestion = AIS_POINTS_BY_CONGESTION[chokepoint?.congestionLevel] ?? 0;
  const transitDrop = Math.max(0, score - Math.min(100, threatLevel + navigationalWarnings + aisCongestion));
  const live = [
    ['ais_congestion_spike', aisCongestion],
    ['navigational_warning', navigationalWarnings],
    ['transit_drop', transitDrop],
  ];
  let reason = 'score_threshold';
  let best = 0;
  for (const [name, points] of live) {
    if (points > best) {
      best = points;
      reason = name;
    }
  }
  return {
    reason,
    components: { threatLevel, navigationalWarnings, aisCongestion, transitDrop },
  };
}

/**
 * Per (subscriber, chokepoint) edge state. `armed` fires on the next reading
 * at or above the threshold; `fired` waits for the score to fall below it;
 * `pending` holds a crossing whose delivery failed and is retried with the
 * same triggeredAt (and so the same X-WM-Delivery-Id). A below-threshold
 * reading taken while the warning or AIS source was unavailable does not
 * re-arm: a missing source can only lower the score. Transit data is held to
 * the same rule only for crossings that carried a transit drop, because some
 * chokepoints often lack transit data and would otherwise never re-arm.
 */
function advanceEdgeState(previous, chokepoint, alertThreshold, nowIso) {
  const score = Number(chokepoint?.disruptionScore);
  if (!Number.isFinite(score)) return { next: previous, attempt: null };
  if (score < alertThreshold) {
    const complete = chokepoint.navigationalWarningsAvailable === true
      && chokepoint.aisSnapshotAvailable === true
      && (previous?.transitDrop !== true || chokepoint.transitSummary?.dataAvailable === true);
    return { next: complete ? { phase: 'armed' } : previous, attempt: null };
  }
  if (previous?.phase === 'fired') return { next: previous, attempt: null };
  const triggeredAt = previous?.phase === 'pending' && typeof previous.triggeredAt === 'string'
    ? previous.triggeredAt
    : nowIso;
  const transitDrop = previous?.transitDrop === true || scoreBreakdown(chokepoint).components.transitDrop > 0;
  return {
    next: { phase: 'pending', triggeredAt, ...(transitDrop ? { transitDrop: true } : {}) },
    attempt: { triggeredAt, score },
  };
}

function deliveryIdFor(subscriberId, chokepointId, triggeredAt) {
  const digest = createHash('sha256').update(`${subscriberId}|${chokepointId}|${triggeredAt}`).digest('hex');
  return `whd_${digest.slice(0, 32)}`;
}

function buildPayload(record, chokepoint, attempt) {
  const { reason, components } = scoreBreakdown(chokepoint);
  return {
    subscriberId: record.subscriberId,
    chokepointId: chokepoint.id,
    score: attempt.score,
    alertThreshold: record.alertThreshold,
    triggeredAt: attempt.triggeredAt,
    reason,
    details: {
      name: chokepoint.name,
      status: chokepoint.status,
      warRiskTier: chokepoint.warRiskTier,
      activeWarnings: chokepoint.activeWarnings,
      aisDisruptions: chokepoint.aisDisruptions,
      congestionLevel: chokepoint.congestionLevel,
      components,
      description: chokepoint.description,
    },
  };
}

function signBody(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Signs and POSTs one delivery. The callback host is re-resolved and vetted
 * immediately before the send and the socket is pinned to the vetted address.
 * Never throws: SSRF refusals, timeouts and network errors come back as
 * `{ ok: false, status: 0, error }` so they count toward the failure ceiling.
 */
async function sendDelivery(record, payload, deliveryId, deps = {}) {
  const assertSafe = deps.assertSafe ?? assertNotificationWebhookDeliveryUrlSafe;
  const post = deps.post ?? postJsonWithPinnedAddress;
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-wm-signature': signBody(body, record.secret),
    'x-wm-delivery-id': deliveryId,
    'x-wm-event': WEBHOOK_EVENT,
  };
  try {
    const { url, resolvedAddresses } = await assertSafe(record.callbackUrl);
    const response = await post(url, body, headers, resolvedAddresses);
    const status = Number(response?.status) || 0;
    if (status >= 200 && status < 300) return { ok: true, status };
    return { ok: false, status, error: `http_${status}` };
  } catch (error) {
    const message = String(error?.message);
    // The guard raises DNS failures with the SSRF code too; they are not refusals.
    const code = /DNS resolution/.test(message) ? 'dns_error'
      : error?.code === SSRF_BLOCKED_ERROR_CODE ? 'ssrf_blocked'
        : /timed out/i.test(message) ? 'timeout'
          : 'network_error';
    return { ok: false, status: 0, error: code };
  }
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assertPipeline(results, expected, label) {
  if (!Array.isArray(results) || results.length !== expected || results.some((row) => !row || row.error)) {
    throw new Error(`${label}: Redis pipeline failed`);
  }
  return results;
}

/**
 * Backfills the global subscriber index from records it does not hold, for
 * records registered before it existed or by pre-deploy Vercel code. A marker
 * with a 24-hour TTL limits the SCAN to one pass a day.
 */
async function ensureGlobalIndexBackfilled(redis) {
  const [marker] = assertPipeline(await redis([['GET', BACKFILL_MARKER_KEY]]), 1, 'backfill marker');
  if (marker.result !== null) return 0;
  let cursor = '0';
  let added = 0;
  for (let calls = 0; calls < BACKFILL_MAX_SCAN_CALLS; calls += 1) {
    const [scan] = assertPipeline(
      await redis([['SCAN', cursor, 'MATCH', 'webhook:sub:*:v1', 'COUNT', String(BACKFILL_SCAN_COUNT)]]),
      1,
      'backfill scan',
    );
    const page = scan.result;
    if (!Array.isArray(page) || page.length !== 2 || !Array.isArray(page[1])) throw new Error('backfill scan: malformed page');
    const ids = page[1]
      .map((key) => /^webhook:sub:(wh_[0-9a-f]+):v1$/.exec(String(key))?.[1])
      .filter(Boolean);
    if (ids.length) {
      assertPipeline(await redis([['SADD', GLOBAL_INDEX_KEY, ...ids]]), 1, 'backfill sadd');
      added += ids.length;
    }
    cursor = String(page[0]);
    if (cursor === '0') {
      assertPipeline(
        await redis([['SET', BACKFILL_MARKER_KEY, new Date().toISOString(), 'EX', String(BACKFILL_MARKER_TTL_SECONDS)]]),
        1,
        'backfill marker',
      );
      return added;
    }
  }
  throw new Error('backfill scan: exceeded call budget');
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Advances every watched chokepoint, persists the pending crossings before
 * any send (so a lost write after a send cannot re-fire under a new delivery
 * ID), then sends them in order. After one failure the callback is treated as
 * down for the rest of the tick; the remaining crossings stay pending.
 */
async function dispatchSubscriber(record, previousState, chokepointsById, nowIso, deps) {
  const state = { ...(previousState && typeof previousState === 'object' ? previousState : {}) };
  const attempts = [];
  for (const chokepointId of record.chokepointIds ?? []) {
    const chokepoint = chokepointsById.get(chokepointId);
    if (!chokepoint) continue;
    const { next, attempt } = advanceEdgeState(state[chokepointId], chokepoint, record.alertThreshold, nowIso);
    if (next) state[chokepointId] = next;
    if (attempt) attempts.push({ chokepoint, attempt });
  }
  const result = { record, state, lastOutcome: null, sent: 0, failed: 0 };
  if (!attempts.length) return result;

  assertPipeline(await deps.redis([
    ['SET', stateKey(record.subscriberId), JSON.stringify(state), 'EX', String(STATE_TTL_SECONDS)],
  ]), 1, 'pending state');

  for (const { chokepoint, attempt } of attempts) {
    if (deps.overBudget()) break;
    const payload = buildPayload(record, chokepoint, attempt);
    const outcome = await deps.send(record, payload, deliveryIdFor(record.subscriberId, chokepoint.id, attempt.triggeredAt));
    result.lastOutcome = outcome;
    if (!outcome.ok) {
      result.failed += 1;
      break;
    }
    state[chokepoint.id] = { ...state[chokepoint.id], phase: 'fired' };
    result.sent += 1;
  }
  return result;
}

/**
 * Runs one dispatch tick and returns its summary. Throws when Redis cannot be
 * read; per-subscriber delivery and write failures are counted, not thrown.
 */
async function runShippingWebhookDispatch({ redis, send = sendDelivery, now = () => Date.now(), log = () => {} }) {
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  const summary = {
    subscribers: 0, active: 0, expired: 0, delivered: 0, failed: 0, deactivated: 0, backfilled: 0,
    writeErrors: 0, egressOutage: false, skipped: null,
  };

  const lockToken = randomBytes(12).toString('hex');
  const [lock] = assertPipeline(
    await redis([['SET', DISPATCH_LOCK_KEY, lockToken, 'NX', 'EX', String(LOCK_TTL_SECONDS)]]),
    1,
    'dispatch lock',
  );
  if (lock.result !== 'OK') return { ...summary, skipped: 'locked' };

  try {
    // Already-indexed subscribers are still served when the backfill fails.
    try {
      summary.backfilled = await ensureGlobalIndexBackfilled(redis);
    } catch (error) {
      log(`[ShippingWebhooks] backfill failed: ${error?.message ?? error}`);
    }

    const [statusRow, membersRow] = assertPipeline(
      await redis([['GET', CHOKEPOINT_STATUS_KEY], ['SMEMBERS', GLOBAL_INDEX_KEY]]),
      2,
      'dispatch read',
    );
    const status = parseJson(statusRow.result);
    const fetchedAtMs = Date.parse(status?.fetchedAt ?? '');
    if (!Array.isArray(status?.chokepoints) || status.chokepoints.length === 0) return { ...summary, skipped: 'source_missing' };
    if (!Number.isFinite(fetchedAtMs) || nowMs - fetchedAtMs > SOURCE_MAX_AGE_MS) return { ...summary, skipped: 'source_stale' };
    const chokepointsById = new Map(status.chokepoints.map((cp) => [cp.id, cp]));

    const ids = Array.isArray(membersRow.result) ? membersRow.result.filter((id) => typeof id === 'string') : [];
    summary.subscribers = ids.length;
    if (!ids.length) return summary;

    const rows = assertPipeline(
      await redis(ids.flatMap((id) => [['GET', webhookKey(id)], ['GET', stateKey(id)]])),
      ids.length * 2,
      'dispatch records',
    );

    const expired = ids.filter((_, i) => rows[i * 2].result === null);
    if (expired.length) {
      assertPipeline(
        await redis(expired.map((id) => ['EVAL', REMOVE_EXPIRED_MEMBER_SCRIPT, '2', GLOBAL_INDEX_KEY, webhookKey(id), id])),
        expired.length,
        'dispatch prune',
      );
      summary.expired = expired.length;
    }

    const work = ids.flatMap((_id, i) => {
      const record = parseJson(rows[i * 2].result);
      if (!record || record.active !== true || typeof record.secret !== 'string') return [];
      return [{ record, previousState: parseJson(rows[i * 2 + 1].result) }];
    });
    summary.active = work.length;

    // Shuffled so a subscriber whose callbacks hang cannot always be first in
    // line; the budget leaves whoever is not reached pending for the next tick.
    const deps = { redis, send, overBudget: () => now() - nowMs > SEND_BUDGET_MS };
    const results = (await mapWithConcurrency(shuffled(work), SUBSCRIBER_CONCURRENCY, async ({ record, previousState }) => {
      try {
        return await dispatchSubscriber(record, previousState, chokepointsById, nowIso, deps);
      } catch (error) {
        summary.writeErrors += 1;
        log(`[ShippingWebhooks] ${record.subscriberId}: ${error?.message ?? error}`);
        return null;
      }
    })).filter(Boolean);

    const attempted = results.filter((result) => result.lastOutcome);
    summary.egressOutage = attempted.length >= 2
      && attempted.every((result) => result.sent === 0 && TRANSPORT_ERRORS.has(result.lastOutcome.error));
    if (summary.egressOutage) log(`[ShippingWebhooks] all ${attempted.length} attempted callbacks failed in transport; failure counts left unchanged`);

    for (const result of results) {
      const { record, lastOutcome } = result;
      summary.delivered += result.sent;
      summary.failed += result.failed;
      const writes = [['SET', stateKey(record.subscriberId), JSON.stringify(result.state), 'EX', String(STATE_TTL_SECONDS)]];
      if (lastOutcome && !summary.egressOutage) {
        writes.push(['EVAL', RECORD_DELIVERY_SCRIPT, '1', webhookKey(record.subscriberId),
          nowIso, String(lastOutcome.status), lastOutcome.ok ? '1' : '0',
          String(FAILURE_CEILING), lastOutcome.error ?? '', result.sent > 0 ? '1' : '0']);
      }
      const written = await Promise.resolve(redis(writes)).catch(() => null);
      if (!Array.isArray(written) || written.length !== writes.length || written.some((row) => !row || row.error)) {
        summary.writeErrors += 1;
        log(`[ShippingWebhooks] state write failed for ${record.subscriberId}`);
        continue;
      }
      if (written[1]?.result === 2 || written[1]?.result === '2') {
        summary.deactivated += 1;
        log(`[ShippingWebhooks] ${record.subscriberId} deactivated after ${FAILURE_CEILING} consecutive failures`);
      }
    }
    return summary;
  } finally {
    await Promise.resolve(redis([['EVAL', RELEASE_LOCK_SCRIPT, '1', DISPATCH_LOCK_KEY, lockToken]])).catch(() => {});
  }
}

/**
 * Health heartbeat: `recordCount: 1` on every completed tick, including ticks
 * with no subscribers, so api/health.js alarms only when the loop stops or
 * errors.
 */
function buildLastRun(summary, nowMs, error) {
  const reason = error ? String(error?.message ?? error).slice(0, 200)
    : summary?.writeErrors ? `${summary.writeErrors} subscriber state write(s) failed`
      : null;
  return {
    fetchedAt: nowMs,
    recordCount: 1,
    status: reason ? 'error' : 'ok',
    ...(summary ?? {}),
    ...(reason ? { errorReason: reason } : {}),
  };
}

function lastRunWrites(run) {
  const value = JSON.stringify(run);
  return [
    ['SET', LAST_RUN_KEY, value, 'EX', String(LAST_RUN_TTL_SECONDS)],
    ['SET', LAST_RUN_META_KEY, value, 'EX', String(LAST_RUN_TTL_SECONDS)],
    ['SET', ACTIVATION_KEY, '1'],
  ];
}

module.exports = {
  ACTIVATION_KEY,
  BACKFILL_MARKER_KEY,
  CHOKEPOINT_STATUS_KEY,
  DISPATCH_LOCK_KEY,
  FAILURE_CEILING,
  GLOBAL_INDEX_KEY,
  LAST_RUN_KEY,
  LAST_RUN_META_KEY,
  REASONS,
  RECORD_DELIVERY_SCRIPT,
  RELEASE_LOCK_SCRIPT,
  REMOVE_EXPIRED_MEMBER_SCRIPT,
  THREAT_POINTS_BY_TIER,
  WEBHOOK_EVENT,
  advanceEdgeState,
  buildLastRun,
  buildPayload,
  deliveryIdFor,
  ensureGlobalIndexBackfilled,
  lastRunWrites,
  runShippingWebhookDispatch,
  scoreBreakdown,
  sendDelivery,
  signBody,
  stateKey,
  webhookKey,
};
