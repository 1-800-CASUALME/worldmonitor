// Every HTML page we serve under the site-wide CSP must be able to run its
// own scripts. That CSP (vercel.json catch-all) uses 'strict-dynamic' with no
// 'unsafe-inline', so the browser silently drops:
//   - an inline <script> without an allowed nonce or a listed SHA-256 hash,
//   - a `javascript:` URL,
//   - an inline event-handler attribute (onclick=, onload=, …).
// Each of these shipped once and left a dead control in production (the MCP
// consent page's "Use API key instead", the OAuth error pages' "go back", the
// hosted YouTube embed's player). This sweep reads the served sources so the
// next one fails here instead.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ROOT = new URL('..', import.meta.url);

// Served under a different CSP, or not served as a page under ours.
const EXEMPT = {
  // Own CSP rules in vercel.json.
  'api/slack/oauth/callback.ts': '/api/slack/oauth/callback',
  'api/discord/oauth/callback.ts': '/api/discord/oauth/callback',
  'public/wm-widget-sandbox.html': '/wm-widget-sandbox.html',
  'embed.html': '/embed.html',
  // MCP App resources: the MCP server inlines them and the host renders them
  // in its own sandbox, under the host's CSP.
  'plugin.html': null,
  'market.html': null,
  'country.html': null,
};
const EXEMPT_DIRS = ['api/mcp/ui/'];

const vercel = JSON.parse(readFileSync(new URL('vercel.json', ROOT), 'utf8'));
const cspRules = vercel.headers
  .map((rule) => ({ source: rule.source, csp: rule.headers.find((h) => h.key === 'Content-Security-Policy')?.value }))
  .filter((rule) => rule.csp);
const siteCsp = cspRules.find((rule) => new RegExp(`^${rule.source}$`).test('/oauth/authorize'))?.csp;
const scriptSrc = siteCsp?.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '))?.split(/\s+/) ?? [];

function servedSources() {
  const files = execFileSync('git', ['ls-files', '*.html', 'public/*.html', 'api/**.js', 'api/**.ts', 'server/**.ts'], {
    cwd: ROOT, encoding: 'utf8',
  }).split('\n').filter(Boolean);
  return [...new Set(files)].filter((f) =>
    !f.includes('/') || f.startsWith('public/') || f.startsWith('api/') || f.startsWith('server/'))
    .filter((f) => !/(^|\/)__tests__\/|\.test\.|\.d\.ts$/.test(f))
    .filter((f) => !(f in EXEMPT) && !EXEMPT_DIRS.some((d) => f.startsWith(d)));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

describe('served HTML runs under the site-wide CSP', () => {
  it('reads the site-wide script-src', () => {
    assert.ok(scriptSrc.includes("'strict-dynamic'"), 'the sweep assumes the strict-dynamic catch-all CSP');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"));
  });

  it('every exemption still exists and, when it claims its own CSP, has one', () => {
    for (const [file, route] of Object.entries(EXEMPT)) {
      assert.ok(existsSync(new URL(file, ROOT)), `stale exemption: ${file}`);
      if (route) assert.ok(cspRules.some((rule) => rule.source === route), `${file} claims its own CSP at ${route}`);
    }
  });

  it('no inline script, javascript: URL or inline event handler is blocked', () => {
    const failures = [];
    for (const file of servedSources()) {
      const text = readFileSync(new URL(file, ROOT), 'utf8');
      if (!/<script\b|javascript:|<[a-z]/i.test(text)) continue;
      const isTemplate = /\.(js|ts)$/.test(file);

      for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)) {
        const [, attrs, body] = m;
        if (/\btype=["']?application\/(ld\+)?json/.test(attrs)) continue; // data, never executed
        const nonce = /\bnonce=["']([^"']+)["']/.exec(attrs)?.[1];
        if (nonce && scriptSrc.includes(`'nonce-${nonce}'`)) continue;
        // A template's script body is filled per request, so only a nonce can match it.
        if (!isTemplate && scriptSrc.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`)) continue;
        failures.push(`${file}:${lineOf(text, m.index)} <script${attrs}> has no allowed nonce${isTemplate ? '' : ' or hash'}`);
      }
      for (const m of text.matchAll(/\b(?:href|src|action)\s*=\s*["']?\s*javascript:/gi)) {
        failures.push(`${file}:${lineOf(text, m.index)} javascript: URL`);
      }
      for (const m of text.matchAll(/<[a-zA-Z][^<>]*?\son[a-z]+\s*=\s*["']/g)) {
        failures.push(`${file}:${lineOf(text, m.index)} inline event handler`);
      }
    }
    assert.deepEqual(failures, [], `blocked by the site-wide CSP:\n  ${failures.join('\n  ')}`);
  });
});
