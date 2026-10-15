import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

/**
 * Starts the fast bootstrap tier from the dashboard entry script, before the
 * App chunk downloads and evaluates. `fetchBootstrapData()` adopts the request
 * instead of issuing its own, so the first dashboard data no longer waits
 * behind the largest chunk on the page.
 *
 * Kept free of bootstrap.ts imports so the entry chunk only gains this file.
 */

const FAST_TIER_PATH = '/api/bootstrap?tier=fast&public=1';

interface PrimedTier {
  url: string;
  startedAt: number;
  response: Promise<Response>;
  controller: AbortController;
}

let primed: PrimedTier | null = null;

export function primeBootstrapFastTier(): void {
  if (primed || typeof fetch !== 'function') return;
  // Desktop waits for its local sidecar before bootstrap; offline boots read
  // the cached tier instead of the network.
  if (isDesktopRuntime()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

  const controller = new AbortController();
  const url = toApiUrl(FAST_TIER_PATH);
  const startedAt = performance.now();
  // Same credential-less shape fetchTier uses: the session interceptor and the
  // edge CORS policy both depend on it.
  const response = fetch(url, { signal: controller.signal, credentials: 'omit' });
  // The adopter observes the rejection; this branch only keeps an unadopted
  // failure from surfacing as an unhandled rejection.
  response.catch(() => undefined);
  primed = { url, startedAt, response, controller };
}

/**
 * `performance.now()` at which the pending primed request started, or null.
 * The fast-tier abort budget counts from here, so boot never waits longer for
 * the tier than it did before the request moved to the entry script.
 */
export function primedBootstrapTierStartedAt(): number | null {
  return primed?.startedAt ?? null;
}

/**
 * Hands over the primed fast-tier request once. An abort of `signal` aborts the
 * primed request, so the caller's timeout budget still applies.
 */
export function adoptPrimedBootstrapTier(
  url: string,
  signal: AbortSignal,
): { response: Promise<Response>; startedAt: number } | null {
  const current = primed;
  primed = null;
  if (!current) return null;
  if (current.url !== url) {
    current.controller.abort();
    return null;
  }
  if (signal.aborted) current.controller.abort();
  else signal.addEventListener('abort', () => current.controller.abort(), { once: true });
  return { response: current.response, startedAt: current.startedAt };
}

export function resetPrimedBootstrapTierForTests(): void {
  primed?.controller.abort();
  primed = null;
}
