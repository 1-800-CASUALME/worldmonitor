/**
 * GET    /api/v2/shipping/webhooks/{subscriberId} — Status read for a single
 *        webhook.
 * DELETE /api/v2/shipping/webhooks/{subscriberId} — Unsubscribe: removes the
 *        record, both index entries and the worker's delivery state. Zapier's
 *        performUnsubscribe calls this when a Zap is turned off.
 *
 * Preserved on the legacy path-param URL shape because sebuf does not
 * currently support path-parameter RPC paths; tracked for eventual migration
 * under #3207.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getHeaderApiKey, USER_API_KEY_GATEWAY_VALIDATION_ERROR, validateApiKey } from '../../../_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../../_cors.js';
import { renderBillingVerificationDenial } from '../../../../server/_shared/entitlement-check';
import { validateUserApiKey } from '../../../../server/_shared/user-api-key';
import { checkFailClosedScopedIpRateLimit } from '../../../../server/_shared/rate-limit';
import { resolvePremiumCallerIdentity } from '../../../../server/_shared/premium-check';
import { getCachedJson, runRedisPipeline } from '../../../../server/_shared/redis';
import {
  ALL_INDEX_KEY,
  webhookKey,
  ownerIndexKey,
  callerFingerprint,
  recordEventType,
  type WebhookRecord,
} from '../../../../server/worldmonitor/shipping/v2/webhook-shared';

// Deletes only while the record is still the snapshot the owner check read,
// so a rotate-secret or worker write that lands in between is not deleted
// blind; the caller gets 409 and may retry. The worker's state hash goes with
// the record so a re-registered subscription starts armed.
const DELETE_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('DEL', KEYS[1])",
  "redis.call('SREM', KEYS[2], ARGV[2])",
  "redis.call('SREM', KEYS[3], ARGV[2])",
  "redis.call('DEL', KEYS[4])",
  'return 1',
].join(' ');

export function deliveryStateKey(subscriberId: string): string {
  return `webhook:state:${subscriberId}:v1`;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = {
    ...getCorsHeaders(req, 'GET, DELETE, OPTIONS'),
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const apiKeyResult = await validateApiKey(req, { forceKey: true });
  if (apiKeyResult.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR) {
    const validationGuard = await checkFailClosedScopedIpRateLimit(
      req, 'user-api-key:pre-auth-validation', 600, '60 s', cors,
    );
    if (validationGuard) return validationGuard;
    const credential = getHeaderApiKey(req);
    let userKey;
    try {
      userKey = credential ? await validateUserApiKey(credential) : null;
    } catch {
      return new Response(JSON.stringify({ error: 'Service temporarily unavailable' }), {
        status: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    if (!userKey) {
      return new Response(JSON.stringify({ error: 'Invalid API key' }), {
        status: 401,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    apiKeyResult.valid = true;
    apiKeyResult.credential = credential;
  }
  if (apiKeyResult.required && !apiKeyResult.valid) {
    return new Response(JSON.stringify({ error: apiKeyResult.error ?? 'API key required' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const identity = await resolvePremiumCallerIdentity(req);
  if (!identity.isPremium) {
    if (identity.billingDenial) return renderBillingVerificationDenial(identity.billingDenial, cors);
    return new Response(JSON.stringify({ error: 'PRO subscription required' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(req.url);
  const parts = url.pathname.replace(/\/+$/, '').split('/');
  const subscriberId = parts[parts.length - 1];
  if (!subscriberId || !subscriberId.startsWith('wh_')) {
    return new Response(JSON.stringify({ error: 'Webhook not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

  let raw: string | null = null;
  let record: WebhookRecord | null = null;
  if (req.method === 'DELETE') {
    // The delete script compares the exact stored bytes, so read them raw.
    const [row] = await runRedisPipeline([['GET', webhookKey(subscriberId)]]).catch(() => [null]);
    if (!row || row.error) return json(503, { error: 'Service temporarily unavailable' });
    if (typeof row.result === 'string') {
      raw = row.result;
      try {
        record = JSON.parse(raw) as WebhookRecord;
      } catch {
        record = null;
      }
    }
  } else {
    record = (await getCachedJson(webhookKey(subscriberId)).catch(() => null)) as WebhookRecord | null;
  }
  if (!record) return json(404, { error: 'Webhook not found' });

  const ownerHash = await callerFingerprint(req, apiKeyResult.credential);
  if (record.ownerTag !== ownerHash) return json(403, { error: 'Forbidden' });

  if (req.method === 'DELETE') {
    const [row] = await runRedisPipeline([[
      'EVAL', DELETE_SCRIPT, '4',
      webhookKey(subscriberId), ownerIndexKey(record.ownerTag), ALL_INDEX_KEY, deliveryStateKey(subscriberId),
      raw as string, subscriberId,
    ]]).catch(() => [null]);
    if (!row || row.error) return json(503, { error: 'Service temporarily unavailable' });
    if (row.result === 0 || row.result === '0') {
      return json(409, { error: 'Webhook changed during delete; retry' });
    }
    return json(200, { subscriberId, deleted: true, deletedAt: new Date().toISOString() });
  }

  return json(200, {
    subscriberId: record.subscriberId,
    callbackUrl: record.callbackUrl,
    chokepointIds: record.chokepointIds,
    alertThreshold: record.alertThreshold,
    createdAt: record.createdAt,
    active: record.active,
    eventType: recordEventType(record),
    countries: Array.isArray(record.countries) ? record.countries : [],
    minLiveSignal: record.minLiveSignal ?? 0,
    failureCount: record.failureCount ?? 0,
    lastDeliveryAt: record.lastDeliveryAt ?? null,
    lastDeliveryStatus: record.lastDeliveryStatus ?? null,
  });
}
