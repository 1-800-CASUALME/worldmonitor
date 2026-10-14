import {
  landingHreflangCluster,
  type IndexableLandingLocale,
} from '../../shared/indexable-landing-locales';

export interface WelcomeLandingCopy {
  title: string;
  description: string;
  ogTitle: string;
  ogDescription: string;
  faqs: readonly { q: string; a: string }[];
}

const JSON_LD_SCRIPT_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']application\/ld\+json["'])[^>]*>([\s\S]*?)<\/script>/gi;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function replaceHtmlLang(html: string, lang: string): string {
  if (/<html\b[^>]*\blang="/i.test(html)) {
    return html.replace(/(<html\b[^>]*\blang=")[^"]*(")/i, `$1${lang}$2`);
  }
  return html.replace(/<html\b/i, `<html lang="${lang}"`);
}

function setDocumentDir(html: string, dir: 'ltr' | 'rtl'): string {
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0];
  if (!htmlTag) return html;
  let nextTag = htmlTag.replace(/\sdir="[^"]*"/i, '');
  if (dir === 'rtl') {
    nextTag = nextTag.replace(/<html\b/i, '<html dir="rtl"');
  }
  return html.replace(htmlTag, nextTag);
}

function setMeta(
  html: string,
  attr: 'name' | 'property',
  key: string,
  content: string,
): string {
  const escaped = escapeAttr(content);
  const named = new RegExp(
    `(<meta\\b[^>]*\\b${attr}="${key}"[^>]*\\bcontent=")[^"]*(")`,
    'i',
  );
  if (named.test(html)) return html.replace(named, `$1${escaped}$2`);
  const reversed = new RegExp(
    `(<meta\\b[^>]*\\bcontent=")[^"]*("[^>]*\\b${attr}="${key}")`,
    'i',
  );
  if (reversed.test(html)) return html.replace(reversed, `$1${escaped}$2`);
  return html;
}

function clusterLinkTags(): string {
  const cluster = landingHreflangCluster();
  return cluster
    .map((entry) => `    <link rel="alternate" hreflang="${entry.hreflang}" href="${entry.href}" />`)
    .join('\n');
}

function linkRelations(tag: string): string[] {
  const rel = tag.match(/\brel="([^"]*)"/i)?.[1]?.toLowerCase() ?? '';
  return rel.split(/\s+/).filter(Boolean);
}

function isCanonicalOrHreflangLink(tag: string): boolean {
  const relations = linkRelations(tag);
  return relations.includes('canonical')
    || (relations.includes('alternate') && /\bhreflang="/i.test(tag));
}

function rewriteCanonicalAndHreflang(html: string, canonical: string): string {
  const canonicalTag = `    <link rel="canonical" href="${canonical}" />`;
  const block = `${canonicalTag}\n${clusterLinkTags()}\n`;
  const open = html.match(/<head\b[^>]*>/i);
  if (!open || open.index === undefined) return `${html}${block}`;
  const innerStart = open.index + open[0].length;
  const closeOffset = html.slice(innerStart).search(/<\/head\b/i);
  if (closeOffset < 0) return `${html}${block}`;
  const inner = html.slice(innerStart, innerStart + closeOffset);
  const kept: string[] = [];
  const linkRe = /<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let cursor = 0;
  for (const match of inner.matchAll(linkRe)) {
    const index = match.index ?? 0;
    kept.push(inner.slice(cursor, index));
    if (!isCanonicalOrHreflangLink(match[0])) kept.push(match[0]);
    cursor = index + match[0].length;
  }
  kept.push(inner.slice(cursor));
  return `${html.slice(0, innerStart)}${kept.join('')}${block}${html.slice(innerStart + closeOffset)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  const declared = node['@type'];
  if (Array.isArray(declared)) return declared.includes(type);
  return declared === type;
}

function rewriteJsonLdValue(
  value: unknown,
  locale: IndexableLandingLocale,
  copy: WelcomeLandingCopy,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonLdValue(entry, locale, copy));
  }
  if (!isRecord(value)) return value;
  if (Array.isArray(value['@graph'])) {
    return {
      ...value,
      '@graph': value['@graph'].map((entry) => rewriteJsonLdValue(entry, locale, copy)),
    };
  }
  if (hasType(value, 'WebPage')) {
    const webpageId = `${locale.canonicalUrl}#webpage`;
    const breadcrumbId = `${locale.canonicalUrl}#breadcrumb`;
    const next: Record<string, unknown> = {
      ...value,
      '@id': webpageId,
      url: locale.canonicalUrl,
      name: copy.ogTitle,
      description: copy.description,
      inLanguage: locale.htmlLang,
    };
    if (isRecord(next.breadcrumb)) {
      next.breadcrumb = { ...next.breadcrumb, '@id': breadcrumbId };
    }
    return next;
  }
  if (hasType(value, 'BreadcrumbList')) {
    const items = Array.isArray(value.itemListElement)
      ? value.itemListElement.map((item, index) => {
        if (!isRecord(item) || index !== 0) return item;
        return { ...item, item: locale.canonicalUrl };
      })
      : value.itemListElement;
    return {
      ...value,
      '@id': `${locale.canonicalUrl}#breadcrumb`,
      itemListElement: items,
    };
  }
  if (hasType(value, 'FAQPage')) {
    return {
      ...value,
      mainEntity: copy.faqs.map((faq) => ({
        '@type': 'Question',
        name: faq.q,
        acceptedAnswer: { '@type': 'Answer', text: faq.a },
      })),
    };
  }
  return value;
}

function rewriteJsonLd(
  html: string,
  locale: IndexableLandingLocale,
  copy: WelcomeLandingCopy,
): string {
  return html.replace(JSON_LD_SCRIPT_RE, (_script, body: string) => {
    const next = rewriteJsonLdValue(JSON.parse(body), locale, copy);
    const serialized = JSON.stringify(next).replace(/</g, '\\u003c');
    return `<script type="application/ld+json">${serialized}</script>`;
  });
}

function setPrerenderLang(html: string, localeId: string): string {
  if (/\bdata-wm-prerender-lang="/i.test(html)) {
    return html.replace(
      /(\bdata-wm-prerender-lang=")[^"]*(")/i,
      `$1${localeId}$2`,
    );
  }
  return html.replace(
    /<div id="root"/i,
    `<div id="root" data-wm-prerendered="welcome" data-wm-prerender-lang="${localeId}"`,
  );
}

/**
 * Rewrite a cloned English welcome document into one indexable locale.
 * Leaves `#website` / `#organization` / `#software` node values untouched so
 * the product graph stays one body per `@id`.
 */
export function localizeWelcomeDocument(
  html: string,
  locale: IndexableLandingLocale,
  copy: WelcomeLandingCopy,
): string {
  let next = replaceHtmlLang(html, locale.htmlLang);
  next = setDocumentDir(next, locale.dir);
  next = next.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(copy.title)}</title>`);
  next = setMeta(next, 'name', 'description', copy.description);
  next = setMeta(next, 'property', 'og:title', copy.ogTitle);
  next = setMeta(next, 'property', 'og:description', copy.ogDescription);
  next = setMeta(next, 'property', 'og:url', locale.canonicalUrl);
  next = setMeta(next, 'property', 'og:locale', locale.ogLocale);
  next = setMeta(next, 'name', 'twitter:title', copy.ogTitle);
  next = setMeta(next, 'name', 'twitter:description', copy.ogDescription);
  next = rewriteCanonicalAndHreflang(next, locale.canonicalUrl);
  // English already carries the template JSON-LD (and its CSP hashes).
  // Re-serializing it with JSON.stringify would minify those blocks and
  // desync vercel.json script-src. Locale clones need the rewrite.
  if (!locale.isDefault) {
    next = rewriteJsonLd(next, locale, copy);
  }
  next = setPrerenderLang(next, locale.id);
  return next;
}
