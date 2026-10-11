/**
 * #9092: the /verify page. It reads the public digest once, builds the same
 * card the verify_claim MCP tool returns, and never calls a claim true or false.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderClaimCardHtml } from '@/components/claim-card';
import { checkClaim, claimDigestFromBody, VERIFY_DIGEST_URL } from '@/services/verify-claim';
import { isPublicSharedRpcRequest } from '@/shared/public-rpc-cache';
import { buildClaimCard } from '../../server/_shared/claim-match';

const NOW = Date.parse('2026-10-09T21:00:00Z');
const T0 = Date.parse('2026-10-09T18:00:00Z');

function proto(source: string, title: string, link: string, publishedAt = T0) {
  return { source, title, link, publishedAt, isAlert: false };
}

const BODY = {
  generatedAt: '2026-10-09T20:55:00.000Z',
  categories: {
    world: {
      items: [
        proto('Reuters', 'Trump strikes diesel deal with Putin', 'https://n.test/1'),
        proto('BBC World', 'Trump says Russia will supply diesel in deal with Putin', 'https://n.test/2', T0 + 3_600_000),
        proto('Reuters World', 'Panama earthquake: 12 dead, toll expected to rise', 'https://n.test/3'),
        proto('Reuters', 'Panama earthquake: 12 dead, toll expected to rise', 'https://n.test/4'),
        proto('RT', 'Kremlin hails <b>diesel</b> deal with Trump as Putin win', 'javascript:alert(1)'),
      ],
    },
    // The same story in a second category must count once.
    europe: { items: [proto('Reuters', 'Trump strikes diesel deal with Putin', 'https://n.test/1')] },
  },
};

// The real page markup, parsed (not regex-stripped), without its entry script.
function pageBody(): string {
  const page = new DOMParser().parseFromString(readFileSync(resolve(import.meta.dirname, '../../verify.html'), 'utf8'), 'text/html');
  for (const script of page.querySelectorAll('script')) script.remove();
  return page.body.innerHTML;
}

describe('claim card on /verify', () => {
  const digest = claimDigestFromBody(BODY);

  it('reads the digest on its public, caller-invariant cache key', () => {
    expect(isPublicSharedRpcRequest(new URL(VERIFY_DIGEST_URL, 'https://www.worldmonitor.app'))).toBe(true);
  });

  it('dedupes digest items across categories', () => {
    expect(digest.items).toHaveLength(5);
    expect(digest.generatedAt).toBe(BODY.generatedAt);
  });

  it('builds exactly the card the MCP tool builds', () => {
    const claim = 'Trump strikes diesel deal with Putin';
    expect(checkClaim(`  ${claim}  `, digest)).toEqual(buildClaimCard(claim, digest.items));
  });

  it('corroborated: names the independent publishers, flags state media, and drops unsafe links', () => {
    const html = renderClaimCardHtml(checkClaim('Trump strikes diesel deal with Putin', digest), NOW);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
    expect(host.querySelector('.vc-verdict-title')?.textContent).toMatch(/^Reported by \d+ independent publishers$/);
    expect(host.textContent).toContain('BBC');
    expect(host.textContent).toContain('State media');
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('Kremlin hails <b>diesel</b> deal');
  });

  it('one publisher on two feeds is single-publisher, and an unstated figure is listed as not stated', () => {
    const host = document.createElement('div');
    host.innerHTML = renderClaimCardHtml(checkClaim('Panama earthquake kills 200', digest), NOW);
    expect(host.querySelector('.vc-card')?.classList.contains('vc-single')).toBe(true);
    expect(host.querySelector('.vc-verdict-title')?.textContent).toBe('Only one publisher is reporting this');
    expect(host.querySelector('.fig-ungrounded')?.textContent).toContain('200');
    expect(host.textContent).toContain('via Reuters World, Reuters');
  });

  it('a claim nobody carries is not found, and the page never says false or fake', () => {
    const html = renderClaimCardHtml(checkClaim('Mars colony declares independence from Earth', digest), NOW);
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('.vc-verdict-title')?.textContent).toBe('Not in WorldMonitor\'s current sources');
    expect(host.textContent).toContain('does not make it false');
    expect(host.textContent).not.toMatch(/\bfake\b|\bdebunked\b|\bis false\b|\bverified true\b/i);
    expect(host.querySelector('.hl-list')).toBeNull();
  });
});

describe('/verify page bootstrap', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = pageBody();
    fetchMock = vi.fn(async () => new Response(JSON.stringify(BODY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
    document.body.innerHTML = '';
  });

  it('checks the ?claim= link on load with one public digest read', async () => {
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('Trump strikes diesel deal with Putin');
    expect(document.querySelector('.vc-card')?.classList.contains('vc-corroborated')).toBe(true);
    expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching 5 live headlines from 4 feeds/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(VERIFY_DIGEST_URL);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
  });

  it('a submitted claim updates the shareable URL and reuses the loaded digest', async () => {
    history.replaceState(null, '', '/verify');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching/));
    (document.getElementById('claimInput') as HTMLTextAreaElement).value = 'Panama earthquake kills 200';
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(new URLSearchParams(location.search).get('claim')).toBe('Panama earthquake kills 200');
    expect(document.querySelector('.vc-card')?.classList.contains('vc-single')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('navigating away from a pending check drops its result', async () => {
    let release!: () => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(JSON.stringify(BODY), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal%20with%20Putin');
    await import('@/verify-main');
    history.replaceState(null, '', '/verify');
    window.dispatchEvent(new PopStateEvent('popstate'));
    release();
    await vi.waitFor(() => expect(document.getElementById('digestStatus')?.textContent).toMatch(/^Searching/));
    expect(document.querySelector('.vc-card')).toBeNull();
    expect((document.getElementById('claimInput') as HTMLTextAreaElement).value).toBe('');
    expect((document.getElementById('verifySubmit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the claim as it is checked: trimmed, then capped', async () => {
    const long = `   ${'diesel '.repeat(60)}`;
    history.replaceState(null, '', `/verify?claim=${encodeURIComponent(long)}`);
    await import('@/verify-main');
    const value = (document.getElementById('claimInput') as HTMLTextAreaElement).value;
    expect(value).toBe(long.trim().slice(0, 300));
    await vi.waitFor(() => expect(document.querySelector('.vc-claim')?.textContent).toBe(`“${value}”`));
  });

  it('a failed digest read shows an error, not a verdict, and retries on the next check', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
    history.replaceState(null, '', '/verify?claim=Trump%20strikes%20diesel%20deal');
    await import('@/verify-main');
    await vi.waitFor(() => expect(document.querySelector('.vc-error')).not.toBeNull());
    expect(document.querySelector('.vc-card')).toBeNull();
    (document.getElementById('verifyForm') as HTMLFormElement).requestSubmit();
    await vi.waitFor(() => expect(document.querySelector('.vc-card')).not.toBeNull());
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
