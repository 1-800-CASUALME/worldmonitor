import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENERATED_LOCALES,
  LOCALES,
  baselinePathFor,
  classifyKeys,
  expectedKeysForLocale,
  findPluralBases,
  flatten,
  getPluralCategories,
  localesRootFor,
} from '../scripts/translate-locales.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOCALES_DIR = join(ROOT, localesRootFor(true));
const BASELINE_PATH = join(ROOT, baselinePathFor(true));

const REFRESH_HINT =
  'Run: ANTHROPIC_API_KEY=... node scripts/translate-locales.mjs --pro-test  ' +
  '(the deploy rebuilds /pro itself since #6898 — commit only the locales).';

// The locales below iterate LOCALES, which keeps zh-TW so the freshness gate
// still covers it. The command in REFRESH_HINT no longer writes it: zh-TW is
// converted from zh.json by scripts/convert-zh-tw.py, and translate-locales.mjs
// skips generated locales on the write path (it even rejects --only=zh-TW). A
// reader who follows the hint on a stale zh-TW gets a run that reports the same
// gap and changes nothing.
const GENERATED_HINT =
  'Generated locales (' +
  [...GENERATED_LOCALES].sort().join(', ') +
  ') are not written by that command — regenerate with: npm run locales:zh-tw';

/** Appended only when a generated locale is actually implicated. */
const hintFor = (locales) =>
  locales.some((locale) => GENERATED_LOCALES.has(locale))
    ? REFRESH_HINT + '  ' + GENERATED_HINT
    : REFRESH_HINT;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const enFlat = flatten(readJson(join(LOCALES_DIR, 'en.json')));

// A value equal to en.json is untranslated, except keys whose English source is
// the string every locale should keep: brand names, plan names, acronyms, and
// bare numbers. A per-locale count cannot say that. uk's old ceiling of 574 sat
// above 440 identical values, so a homepage sentence could ship in English and
// CI stayed green (#9165).
const ENGLISH_ALLOWED_KEYS = new Set([
  'nav.api',
  'nav.pro',
  'nav.enterprise',
  'tiers.pro',
  'tiers.enterprise',
  'twoPath.entTitle',
  'twoPath.proTitle',
  'whatsNew.proTag',
  'apiSection.business',
  'apiSection.starter',
  'pricingTable.apiRow',
  'pricingTable.apiHeader',
  'pricingTable.proHeader',
  'pricingTable.freeHeader',
  'pricingTable.f3',
  'pricingTable.f10',
  'pricingTable.f25',
  'pricingTable.f40',
  'pricingTable.f80',
  'pricingTable.fBYOK',
  'pricingTable.fSiemMcp',
  'pricingTable.fWebhook',
  'pricingTable.fRestWebhook',
  'pricingTable.ai',
  'welcome.pricing.proTitle',
  'welcome.agents.resources.api',
  'pricing.tiers.enterprise.features[8]',
  'enterpriseShowcase.soc',
]);

// Temporary review list for Elie. These labels are still English in some
// locales (meta titles, "Blog", "Live", loanwords) and this change leaves them.
// Translate a key, or move it into ENGLISH_ALLOWED_KEYS, when that decision lands.
// A new untranslated sentence does not belong in this set.
const PENDING_ENGLISH_REVIEW_KEYS = new Set([
  'meta.title',
  'meta.ogTitle',
  'welcome.nav.blog',
  'welcome.live.liveBadge',
  'welcome.nav.menu',
  'welcome.pricing.freeTitle',
  'welcome.hero.trustOpenSource',
  'welcome.live.marketBest',
  'welcome.live.trendStable',
  'welcome.depth.s8l',
  'welcome.moments.m2.c1',
  'welcome.moments.m4.c3',
  'welcome.agents.resources.mcp',
  'welcome.agents.resources.agentView',
  'welcome.agents.termTitle',
  'pricingTable.fCloud',
  'pricingTable.fStandard',
  'pricingTable.fStandardCadence',
  'pricingTable.deployment',
  'pricingTable.dashboard',
  'pricingTable.fCloudOnPrem',
  'pricingTable.fLiveEdge',
  'pricingTable.fWhiteLabel',
  'pricingTable.fQuotes30s',
  'proShowcase.supplyChainLab',
  'deliveryDesk.eyebrow',
  'slackMock.elevated',
  'pricing.axisCommercial',
  'pricing.axisPersonal',
  'hero.signalWord',
  'whatsNew.eyebrow',
  'pricing.tiers.proBusiness.features[4]',
  'pricing.tiers.apiBusiness.features[2]',
  'livePreview.iframeTitle',
]);

// Persian is #5644. The number is how many non-allowlisted, non-pending values
// are still the English source. Lower it as Persian is translated. Never raise it.
const TEMPORARY_LOCALE_EXEMPTIONS = {
  fa: 390,
};

describe('pro locale freshness', () => {
  it('tracks every shipped locale', () => {
    // Everything below iterates LOCALES. A language added to the app and given a
    // locale file but never added to the translator's list would be skipped by
    // all of it — present, untracked, and silently exempt from the gate.
    const shipped = readdirSync(LOCALES_DIR)
      .filter((name) => name.endsWith('.json') && name !== 'en.json')
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
    // Containment, not equality. LOCALES is shared by both roots, and
    // translate-locales.mjs deliberately skips a locale with no file in the
    // active root ("a locale added to main may not yet have a pro-test
    // counterpart... placeholders trigger the pro-bundle freshness hook").
    // Requiring equality would red CI on the supported way to add an app
    // language and push the author into creating exactly the placeholder file
    // the script warns against.
    const untracked = shipped.filter((locale) => !LOCALES.includes(locale));
    assert.deepEqual(
      untracked,
      [],
      'these locale files exist but scripts/translate-locales.mjs does not know about them, so nothing translates or gates them — add them to LOCALES',
    );
  });

  it('keeps the EN baseline in step with en.json', () => {
    // This is the assertion that catches #5633 recurring. English pricing copy
    // gets edited far more often than the translations get refreshed; when that
    // happens the baseline no longer describes what the locales were translated
    // from, and every stale string ships silently.
    assert.ok(existsSync(BASELINE_PATH), baselinePathFor(true) + ' is missing. ' + REFRESH_HINT);
    const baseline = readJson(BASELINE_PATH);

    const drifted = Object.keys(enFlat).filter((key) => baseline[key] !== enFlat[key]);
    const dropped = Object.keys(baseline).filter((key) => !(key in enFlat));
    assert.deepEqual(
      { drifted, dropped },
      { drifted: [], dropped: [] },
      'en.json changed without a translation pass, so ' +
        drifted.length +
        ' English string(s) no longer match what the locales were translated from. ' +
        REFRESH_HINT,
    );
  });

  it('ships every locale complete and free of stale translations', () => {
    const baseline = readJson(BASELINE_PATH);
    const pluralBases = findPluralBases(enFlat);
    const baselinePlurals = findPluralBases(baseline);

    const problems = [];
    const problemLocales = [];
    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, locale + '.json');
      if (!existsSync(file)) continue;
      const categories = getPluralCategories(locale);
      const result = classifyKeys(
        flatten(readJson(file)),
        expectedKeysForLocale(enFlat, pluralBases, categories),
        expectedKeysForLocale(baseline, baselinePlurals, categories),
      );
      if (result.missing.length || result.stale.length || result.orphan.length) {
        problemLocales.push(locale);
        problems.push(
          locale + ': ' + result.missing.length + ' missing, ' + result.stale.length + ' stale, ' +
            result.orphan.length + ' orphaned (e.g. ' +
            [...result.missing, ...result.stale, ...result.orphan].slice(0, 3).join(', ') + ')',
        );
      }
    }
    assert.deepEqual(problems, [], 'pro locales are out of date. ' + hintFor(problemLocales));
  });

  it('names only real catalog keys in the English allowlist and the review exemption', () => {
    const overlap = [...ENGLISH_ALLOWED_KEYS].filter((key) => PENDING_ENGLISH_REVIEW_KEYS.has(key));
    const missing = [...ENGLISH_ALLOWED_KEYS, ...PENDING_ENGLISH_REVIEW_KEYS].filter((key) => !(key in enFlat));
    assert.deepEqual({ overlap, missing }, { overlap: [], missing: [] });
  });

  it('rejects untranslated English outside the allowlist', () => {
    // validateTranslation accepts a reply identical to its English source, so a
    // truncated model echo is written, counted as refreshed, and then hidden by
    // the next baseline advance. Equality with en.json is the failure, per key.
    const violations = [];
    for (const locale of LOCALES) {
      const file = join(LOCALES_DIR, locale + '.json');
      if (!existsSync(file)) continue;
      const flat = flatten(readJson(file));
      const unexplained = Object.keys(flat)
        .filter((key) => key in enFlat && flat[key] === enFlat[key])
        .filter((key) => !ENGLISH_ALLOWED_KEYS.has(key) && !PENDING_ENGLISH_REVIEW_KEYS.has(key))
        .sort();
      const exemption = TEMPORARY_LOCALE_EXEMPTIONS[locale];
      if (exemption !== undefined) {
        if (unexplained.length > exemption) {
          violations.push(
            locale + ' has ' + unexplained.length + ' unlisted English values, above its temporary exemption of ' +
              exemption + ' (do not raise it): ' + unexplained.slice(0, 8).join(', '),
          );
        }
        continue;
      }
      for (const key of unexplained) violations.push(locale + ' ' + key);
    }
    assert.deepEqual(violations, []);
  });
});
