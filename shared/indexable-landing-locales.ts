// Every list of indexable landing languages derives from this table: the
// prerender loop, the sitemap cluster, middleware passthrough, the vercel.json
// slash redirects, and their contract tests. `?lang=` stays application state
// and is never an entry here.

export const LANDING_ORIGIN = 'https://www.worldmonitor.app';

export type LandingDirection = 'ltr' | 'rtl';

export interface IndexableLandingLocale {
  /** App dictionary code (`pro-test/src/locales/{id}.json`). */
  readonly id: string;
  readonly canonicalPath: string;
  readonly canonicalUrl: string;
  readonly hreflang: string;
  readonly htmlLang: string;
  readonly ogLocale: string;
  readonly dir: LandingDirection;
  readonly isDefault: boolean;
}

export interface LandingAlternate {
  readonly hreflang: string;
  readonly href: string;
}

type LandingRow = Omit<IndexableLandingLocale, 'canonicalUrl' | 'isDefault'> & {
  readonly isDefault?: true;
};

const ROWS: readonly LandingRow[] = [
  { id: 'en', canonicalPath: '/', hreflang: 'en', htmlLang: 'en', ogLocale: 'en_US', dir: 'ltr', isDefault: true },
  { id: 'es', canonicalPath: '/es/', hreflang: 'es', htmlLang: 'es', ogLocale: 'es_ES', dir: 'ltr' },
  { id: 'pt', canonicalPath: '/pt/', hreflang: 'pt-BR', htmlLang: 'pt-BR', ogLocale: 'pt_BR', dir: 'ltr' },
  { id: 'ru', canonicalPath: '/ru/', hreflang: 'ru', htmlLang: 'ru', ogLocale: 'ru_RU', dir: 'ltr' },
  { id: 'fr', canonicalPath: '/fr/', hreflang: 'fr', htmlLang: 'fr', ogLocale: 'fr_FR', dir: 'ltr' },
  { id: 'de', canonicalPath: '/de/', hreflang: 'de', htmlLang: 'de', ogLocale: 'de_DE', dir: 'ltr' },
  { id: 'ar', canonicalPath: '/ar/', hreflang: 'ar', htmlLang: 'ar', ogLocale: 'ar_SA', dir: 'rtl' },
];

function parseLandingLocales(rows: readonly LandingRow[]): {
  locales: readonly IndexableLandingLocale[];
  defaultLocale: IndexableLandingLocale;
} {
  const ids = new Set<string>();
  const hreflangs = new Set<string>();
  let defaultLocale: IndexableLandingLocale | undefined;
  const locales = rows.map((row): IndexableLandingLocale => {
    const expectedPath = row.isDefault ? '/' : `/${row.id}/`;
    if (row.canonicalPath !== expectedPath) {
      throw new Error(`landing locale ${row.id} must live at ${expectedPath}, not ${row.canonicalPath}`);
    }
    if (ids.has(row.id)) throw new Error(`duplicate landing locale id ${row.id}`);
    if (hreflangs.has(row.hreflang) || row.hreflang === 'x-default') {
      throw new Error(`landing locale ${row.id} reuses hreflang ${row.hreflang}`);
    }
    const base = row.id.toLowerCase();
    if (row.hreflang.split('-')[0]?.toLowerCase() !== base || row.htmlLang.split('-')[0]?.toLowerCase() !== base) {
      throw new Error(`landing locale ${row.id} declares a different language in hreflang or html lang`);
    }
    ids.add(row.id);
    hreflangs.add(row.hreflang);
    const locale = Object.freeze({
      ...row,
      canonicalUrl: `${LANDING_ORIGIN}${row.canonicalPath}`,
      isDefault: row.isDefault === true,
    });
    if (locale.isDefault) {
      if (defaultLocale) throw new Error('exactly one landing locale may be the default');
      defaultLocale = locale;
    }
    return locale;
  });
  if (!defaultLocale) throw new Error('exactly one landing locale must be the default');
  return { locales: Object.freeze(locales), defaultLocale };
}

const { locales, defaultLocale } = parseLandingLocales(ROWS);

export const INDEXABLE_LANDING_LOCALES: readonly IndexableLandingLocale[] = locales;

const NON_DEFAULT_LOCALES = Object.freeze(locales.filter((locale) => !locale.isDefault));

const HREFLANG_CLUSTER: readonly LandingAlternate[] = Object.freeze([
  Object.freeze({ hreflang: 'x-default', href: defaultLocale.canonicalUrl }),
  ...locales.map((locale) => Object.freeze({ hreflang: locale.hreflang, href: locale.canonicalUrl })),
]);

const BY_CANONICAL_PATH = new Map(locales.map((locale) => [locale.canonicalPath, locale]));

/** `x-default` (the English apex) first, then every locale in table order. */
export function landingHreflangCluster(): readonly LandingAlternate[] {
  return HREFLANG_CLUSTER;
}

export function nonDefaultLandingLocales(): readonly IndexableLandingLocale[] {
  return NON_DEFAULT_LOCALES;
}

/** Accepts the slashless and `index.html` spellings the CDN can also serve. */
export function landingByPath(pathname: string): IndexableLandingLocale | undefined {
  return BY_CANONICAL_PATH.get(pathname.replace(/index\.html$/, '').replace(/\/?$/, '/'));
}
