import assert from 'node:assert/strict';
import { after, it } from 'node:test';

process.env.CLERK_JWT_ISSUER_DOMAIN = 'https://clerk.portal.test';
process.env.CONVEX_SITE_URL = 'https://portal.convex.site';
process.env.CONVEX_TENANT_RELAY_SECRET = 'synthetic-tenant-relay-secret';
process.env.UPSTASH_REDIS_REST_URL = 'https://portal-redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-redis-token';

const { default: handler } = await import('../api/customer-portal.ts');
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function mockInfra(relay: (body: unknown) => Response) {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).origin === 'https://portal-redis.test') {
      const commands = JSON.parse(String(init?.body));
      return Response.json(commands.map(() => ({ result: [9, 10] })));
    }
    assert.equal(url, 'https://portal.convex.site/relay/customer-portal');
    return relay(JSON.parse(String(init?.body)));
  };
}

it('GET with a portal token 302s to the minted Dodo URL', async () => {
  let relayBody: unknown;
  mockInfra((body) => {
    relayBody = body;
    return Response.json({ portal_url: 'https://customer.dodopayments.com/session/abc' });
  });
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig&next=https://evil.example'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://customer.dodopayments.com/session/abc');
  assert.deepEqual(relayBody, { portalToken: 'v1.user_x.1.sig' });
});

it('GET with an invalid portal token sends the user to sign-in, not a query redirect', async () => {
  mockInfra(() => Response.json({ error: 'INVALID_PORTAL_TOKEN' }, { status: 401 }));
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=forged&redirect=https://evil.example'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard');
});

it('GET without a token or session requires sign-in and does not call the relay', async () => {
  let relayCalls = 0;
  mockInfra(() => {
    relayCalls += 1;
    return Response.json({ portal_url: 'https://customer.dodopayments.com/x' });
  });
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?next=https://evil.example'));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://www.worldmonitor.app/dashboard');
  assert.equal(relayCalls, 0);
});

it('GET refuses to redirect to a non-Dodo portal_url', async () => {
  mockInfra(() => Response.json({ portal_url: 'https://evil.example/phish' }));
  const res = await handler(new Request('https://worldmonitor.app/api/customer-portal?t=v1.user_x.1.sig'));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('Location'), null);
});
