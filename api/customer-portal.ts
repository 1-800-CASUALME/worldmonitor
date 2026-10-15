// POST: signed-in dashboard (Clerk bearer) gets the portal URL as JSON.
// GET: dunning-email CTA (?t= HMAC token, verified in Convex) or a Clerk
// bearer; 302s only to an https *.dodopayments.com session, else to sign-in.
export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import {
  beginStandaloneIdempotency,
  completeStandaloneIdempotency,
  getIdempotencyKey,
  peekStandaloneIdempotency,
} from './_idempotency.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
import { validateBearerToken } from '../server/auth-session';
import { safeDodoPortalRedirectUrl } from '../server/_shared/dodo-portal-url';

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const CONVEX_TENANT_RELAY_SECRET = process.env.CONVEX_TENANT_RELAY_SECRET ?? '';
const SIGN_IN_URL = 'https://www.worldmonitor.app/dashboard';
const PORTAL_RELAY_USER_AGENT = 'worldmonitor-customer-portal-edge/1.0';

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
  });
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const cors = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      },
    });
  }

  if (req.method === 'GET') {
    return handlePortalGet(req, cors, ctx);
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return json({ error: 'Unauthorized' }, 401, cors);

  const session = await validateBearerToken(token);
  if (!session.valid || !session.userId) {
    return json({ error: 'Unauthorized' }, 401, cors);
  }

  const idempotencyKey = getIdempotencyKey(req);
  const idempotencyOptions = idempotencyKey ? {
    request: req,
    pathname: '/api/customer-portal',
    scope: `user:${session.userId}`,
    idempotencyKey,
    corsHeaders: cors,
  } : null;
  if (idempotencyOptions) {
    const existing = await peekStandaloneIdempotency(idempotencyOptions);
    if (existing.kind !== 'miss' && existing.kind !== 'disabled') return existing.response;
  }

  const limited = await checkRateLimit(req, cors, {
    scope: 'customer-portal', identifier: session.userId, limit: 5, window: '60 s',
    failClosed: true, ctx,
  });
  if (limited) return limited;

  const idempotency = idempotencyOptions
    ? await beginStandaloneIdempotency(idempotencyOptions)
    : null;
  if (
    idempotency &&
    idempotency.kind !== 'proceed' &&
    idempotency.kind !== 'disabled'
  ) {
    return idempotency.response;
  }

  if (!CONVEX_SITE_URL || !CONVEX_TENANT_RELAY_SECRET) {
    return completeStandaloneIdempotency(idempotency, json({ error: 'Service unavailable' }, 503, cors));
  }

  try {
    const resp = await fetch(`${CONVEX_SITE_URL}/relay/customer-portal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PORTAL_RELAY_USER_AGENT,
        Authorization: `Bearer ${CONVEX_TENANT_RELAY_SECRET}`,
      },
      body: JSON.stringify({ userId: session.userId }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.error('[customer-portal] Relay error:', resp.status, data);
      return completeStandaloneIdempotency(
        idempotency,
        json({ error: data?.error || 'Customer portal unavailable' }, resp.status === 404 ? 404 : 502, cors),
      );
    }

    return completeStandaloneIdempotency(idempotency, json(data, 200, cors));
  } catch (err) {
    console.error('[customer-portal] Relay failed:', (err as Error).message);
    captureSilentError(err, { tags: { route: 'api/customer-portal', step: 'relay' }, fingerprint: ['api/customer-portal', 'relay', err instanceof Error ? err.name : 'Error'], ctx });
    return completeStandaloneIdempotency(idempotency, json({ error: 'Customer portal unavailable' }, 502, cors));
  }
}

type MintResult = { ok: true; portalUrl: string } | { ok: false; reason: string };

async function mintPortalUrl(body: { userId?: string; portalToken?: string }): Promise<MintResult> {
  if (!CONVEX_SITE_URL || !CONVEX_TENANT_RELAY_SECRET) {
    return { ok: false, reason: 'relay_unconfigured' };
  }
  const resp = await fetch(`${CONVEX_SITE_URL}/relay/customer-portal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': PORTAL_RELAY_USER_AGENT,
      Authorization: `Bearer ${CONVEX_TENANT_RELAY_SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json().catch(() => ({})) as { portal_url?: unknown; error?: unknown };
  if (resp.status === 401 && data.error === 'INVALID_PORTAL_TOKEN') {
    return { ok: false, reason: 'invalid_token' };
  }
  if (!resp.ok) return { ok: false, reason: `relay_${resp.status}` };
  const portalUrl = safeDodoPortalRedirectUrl(data.portal_url);
  if (!portalUrl) return { ok: false, reason: 'unsafe_portal_url' };
  return { ok: true, portalUrl };
}

// GET is a browser navigation from an email CTA, so every failure lands on
// the dashboard, whose payment banner reaches the portal after sign-in.
async function handlePortalGet(
  req: Request,
  cors: Record<string, string>,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const portalToken = new URL(req.url).searchParams.get('t') ?? '';
  const authHeader = req.headers.get('Authorization') ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!portalToken && !bearer) return redirect(SIGN_IN_URL);

  const limited = await checkRateLimit(req, cors, {
    scope: 'customer-portal-get',
    limit: 10,
    window: '60 s',
    failClosed: true,
    ctx,
  });
  if (limited) return redirect(SIGN_IN_URL);

  try {
    let minted: MintResult;
    if (portalToken) {
      minted = await mintPortalUrl({ portalToken });
    } else {
      const session = await validateBearerToken(bearer);
      if (!session.valid || !session.userId) return redirect(SIGN_IN_URL);
      minted = await mintPortalUrl({ userId: session.userId });
    }
    if (minted.ok) return redirect(minted.portalUrl);
    if (minted.reason !== 'invalid_token' && minted.reason !== 'relay_404') {
      console.error('[customer-portal] GET mint failed:', minted.reason);
      captureSilentError(new Error(`customer-portal GET mint failed: ${minted.reason}`), {
        tags: { route: 'api/customer-portal', step: 'get-relay' },
        fingerprint: ['api/customer-portal', 'get-relay', minted.reason],
        ctx,
      });
    }
  } catch (err) {
    console.error('[customer-portal] GET mint failed:', (err as Error).message);
    captureSilentError(err, {
      tags: { route: 'api/customer-portal', step: 'get-relay' },
      fingerprint: ['api/customer-portal', 'get-relay', err instanceof Error ? err.name : 'Error'],
      ctx,
    });
  }
  return redirect(SIGN_IN_URL);
}
