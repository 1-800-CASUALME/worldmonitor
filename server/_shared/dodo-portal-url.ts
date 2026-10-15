/**
 * Open-redirect guard for Dodo customer-portal session URLs.
 *
 * Email CTAs land on /api/customer-portal, which mints a session and 302s
 * to Dodo. The Location must be HTTPS on a Dodo host. A look-alike suffix
 * such as dodopayments.com.evil.com is rejected.
 */

export function safeDodoPortalRedirectUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'dodopayments.com' && !host.endsWith('.dodopayments.com')) {
      return null;
    }
    const path = url.pathname || '/';
    return `https://${host}${path}${url.search}`;
  } catch {
    return null;
  }
}
