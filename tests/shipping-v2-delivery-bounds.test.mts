// Bounds on the address-pinned POST that carries shipping v2 webhook
// deliveries (scripts/lib/shipping-webhook-dispatch.cjs → notification-webhook-ssrf.cjs).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';

const require = createRequire(import.meta.url);
const { postJsonWithPinnedAddress } = require('../scripts/lib/notification-webhook-ssrf.cjs');
const { sendDelivery } = require('../scripts/lib/shipping-webhook-dispatch.cjs');

const url = new URL('https://callback.example/hook?test=1');

function fixture(t: TestContext, statusCode = 200, address = '93.184.216.34', respond = true) {
  const response = Object.assign(new PassThrough(), { statusCode, statusMessage: 'test', headers: {} });
  const request = Object.assign(new EventEmitter(), {
    destroyed: false,
    setTimeout: () => request,
    write: () => true,
    end: () => {},
    destroy(error?: Error) {
      request.destroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
      return request;
    },
  });
  let options!: https.RequestOptions;
  t.mock.method(https, 'request', (opts: https.RequestOptions, callback: (res: unknown) => void) => {
    options = opts;
    if (respond) queueMicrotask(() => callback(response));
    return request;
  });
  const promise = postJsonWithPinnedAddress(url, '{}', { 'content-type': 'application/json' }, [address]) as Promise<Response>;
  return { response, request, promise, get options() { return options; } };
}

test('rejects and stops a response larger than 1 MiB', async (t) => {
  const f = fixture(t);
  const outcome = f.promise.then(() => null, error => error);
  await setImmediate();
  f.response.write(Buffer.alloc(1024 * 1024));
  f.response.end(Buffer.from('x'));
  assert.match(String(await outcome), /response too large/);
  assert.equal(f.request.destroyed, true);
});

test('hard deadline rejects an active trickle without a socket timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  let outcome: unknown = 'pending';
  const done = f.promise.then(value => { outcome = value; }, error => { outcome = error; });
  await setImmediate();
  for (let i = 0; i < 10; i++) {
    f.response.write(Buffer.from('x'));
    t.mock.timers.tick(1000);
    await setImmediate();
  }
  const atDeadline = outcome;
  f.response.end();
  await done;
  assert.match(String(atDeadline), /timed out/);
  assert.equal(f.request.destroyed, true);
});

for (const status of [200, 204, 302, 304, 500]) {
  test(`returns status ${status}`, async (t) => {
    const f = fixture(t, status);
    await setImmediate();
    f.response.end();
    const result = await f.promise;
    assert.equal(result.status, status);
    assert.equal(result.ok, status >= 200 && status < 300);
  });
}

for (const address of ['93.184.216.34', '2606:4700:4700::1111']) {
  test(`keeps the validated pin and TLS hostname for ${address}`, async (t) => {
    const f = fixture(t, 200, address);
    await setImmediate();
    assert.equal(f.options.hostname, 'callback.example');
    assert.equal(f.options.path, '/hook?test=1');
    assert.equal(f.options.rejectUnauthorized, undefined);
    assert.equal(f.options.checkServerIdentity, undefined);
    const lookup = f.options.lookup as (hostname: string, options: object, callback: (error: unknown, address: string, family: number) => void) => void;
    lookup('callback.example', {}, (error: unknown, pinned: string, family: number) => {
      assert.equal(error, null);
      assert.equal(pinned, address);
      assert.equal(family, address.includes(':') ? 6 : 4);
    });
    f.response.end();
    await f.promise;
  });
}

test('refuses to pin a private address even if handed one', async () => {
  await assert.rejects(postJsonWithPinnedAddress(url, '{}', {}, ['10.0.0.9']), /private\/reserved/);
});

test('bounds time before response headers arrive', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, 200, '93.184.216.34', false);
  let outcome: unknown = 'pending';
  const done = f.promise.then(value => { outcome = value; }, error => { outcome = error; });
  await setImmediate();
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.match(String(outcome), /timed out/);
  assert.equal(f.request.destroyed, true);
  await done;
});

test('allows exactly 1 MiB and clears the deadline after success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await setImmediate();
  f.response.end(Buffer.alloc(1024 * 1024));
  assert.equal((await f.promise).ok, true);
  t.mock.timers.tick(10_000);
  assert.equal(f.request.destroyed, false);
});

test('a response stream error rejects', async (t) => {
  const f = fixture(t);
  const outcome = f.promise.then(() => null, error => error);
  await setImmediate();
  f.response.emit('error', new Error('socket hang up'));
  assert.match(String(await outcome), /socket hang up/);
});

test('sendDelivery reports a timed-out send as a timeout failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The fixture's own direct POST also times out; only the sendDelivery call is under test.
  fixture(t, 200, '93.184.216.34', false).promise.catch(() => {});
  const record = { callbackUrl: url.href, secret: 's' };
  const pending = sendDelivery(record, { subscriberId: 'wh_x' }, 'whd_x', {
    assertSafe: async () => ({ url, resolvedAddresses: ['93.184.216.34'] }),
  });
  await setImmediate();
  await setImmediate();
  t.mock.timers.tick(10_000);
  assert.deepEqual(await pending, { ok: false, status: 0, error: 'timeout' });
});
