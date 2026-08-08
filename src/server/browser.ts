import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

export const worker = setupWorker(...handlers)

/** Resolved once so registration and cleanup agree on the expected scope. */
const WORKER_SCOPE = import.meta.env.BASE_URL || '/'
const WORKER_URL = `${WORKER_SCOPE}mockServiceWorker.js`.replace(/\/{2,}/g, '/')

/**
 * Remove service workers registered at any scope other than the app's own.
 *
 * This exists because of a real failure, not defensively-in-theory. An earlier
 * build registered the worker with a page-relative URL, so loading a nested
 * route left a worker registered at '/claims/'. That stale worker then
 * intercepted every request on that path — including Vite's module graph and
 * Google Fonts — and its passthrough failed, taking down the whole app with
 * `Failed to fetch dynamically imported module`.
 *
 * Fixing the registration URL stops NEW bad registrations but does nothing about
 * the one already in a developer's browser: service workers outlive the code
 * that created them, and a hard reload does not remove them. So we clean up
 * explicitly at boot.
 *
 * The symptom is deeply confusing — the error names a module that serves 200
 * perfectly well — so the few lines here save someone an afternoon.
 */
async function removeStaleWorkers(): Promise<{ reloadRequired: boolean }> {
  if (!('serviceWorker' in navigator)) return { reloadRequired: false }

  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    const expected = new URL(WORKER_SCOPE, location.origin).href
    const stale = registrations.filter((r) => r.scope !== expected)

    if (stale.length === 0) return { reloadRequired: false }

    /**
     * Is the page currently controlled by one of the stale registrations?
     *
     * Compare by REGISTRATION IDENTITY, not by scriptURL. A worker registered at
     * scope '/claims/' and one registered at '/' both have the scriptURL
     * '/mockServiceWorker.js', so a scriptURL comparison declares the stale
     * worker healthy and skips the reload — which is exactly the bug this
     * function exists to fix.
     *
     * Unregistering does not evict the controller: it keeps serving this document
     * until the next navigation, so a reload is required to escape it.
     */
    const controller = navigator.serviceWorker.controller
    const controlledByStale = Boolean(
      controller &&
        stale.some(
          (r) =>
            r.active === controller || r.waiting === controller || r.installing === controller,
        ),
    )

    for (const r of stale) {
      // eslint-disable-next-line no-console -- a silent unregister is worse
      console.info(
        `[mock-api] Unregistering a stale service worker at ${r.scope}. ` +
          `It was left by an earlier build and would intercept requests on that path.`,
      )
      await r.unregister()
    }

    return { reloadRequired: controlledByStale }
  } catch {
    // Cleanup is best-effort. Never let it prevent startup.
    return { reloadRequired: false }
  }
}

/**
 * Guard against a reload loop.
 *
 * If cleanup somehow never resolves the problem, we must not reload forever. One
 * attempt per tab, recorded in sessionStorage.
 */
const RELOAD_FLAG = 'mock-api:recovered-from-stale-worker'

export async function startMockApi(): Promise<void> {
  const { reloadRequired } = await removeStaleWorkers()

  if (reloadRequired && !sessionStorage.getItem(RELOAD_FLAG)) {
    // Reload once, now that the stale controller is unregistered, so this
    // document is served without it. Without this the page keeps running under
    // the old worker and every dynamic import fails.
    sessionStorage.setItem(RELOAD_FLAG, '1')
    location.reload()
    // Never resolves — the reload replaces this execution context.
    return new Promise<void>(() => {})
  }

  await worker.start({
    /**
     * The worker URL is resolved against the app's BASE_URL, not the current page.
     *
     * A relative './mockServiceWorker.js' looks harmless but breaks every nested
     * route: at /claims/clm-119640 it resolves to /claims/mockServiceWorker.js,
     * which the dev server answers with the SPA's index.html. Registration then
     * fails on the MIME type, no API is mocked, and a deep link renders blank.
     */
    serviceWorker: {
      url: WORKER_URL,
      // Claim the whole app rather than the worker script's directory, so
      // nested routes are intercepted too.
      options: { scope: WORKER_SCOPE },
    },
    /**
     * Only our own API is mocked. Everything else — Vite's module graph, fonts,
     * source maps — passes through untouched and unlogged.
     */
    onUnhandledRequest: 'bypass',
    quiet: true,
  })

  await waitForController()
}

/**
 * Wait until the service worker is actually CONTROLLING this page.
 *
 * `worker.start()` resolves once the worker is registered and activated, which is
 * not the same as controlling the current document. On a first load — or the load
 * right after a stale worker was unregistered — the page can be uncontrolled for
 * a few hundred milliseconds.
 *
 * Requests made in that window bypass MSW completely and hit the dev server,
 * where the SPA fallback answers `/api/session` with `index.html` and HTTP 200.
 * The failure is genuinely nasty: the status says 200, so nothing looks wrong
 * until JSON.parse chokes on `<!doctype html>`, and the app hangs at boot.
 *
 * `navigator.serviceWorker.ready` is not sufficient here either, since it also
 * resolves without a controller. We poll for the controller specifically, and
 * fall through after a bounded wait rather than hanging forever — a slow app with
 * a visible error beats a permanently blank one.
 */
async function waitForController(timeoutMs = 3000): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  if (navigator.serviceWorker.controller) return

  await new Promise<void>((resolve) => {
    const done = (): void => {
      navigator.serviceWorker.removeEventListener('controllerchange', done)
      window.clearTimeout(timer)
      window.clearInterval(poll)
      resolve()
    }

    navigator.serviceWorker.addEventListener('controllerchange', done)
    // controllerchange does not always fire for the initial claim, so poll too.
    const poll = window.setInterval(() => {
      if (navigator.serviceWorker.controller) done()
    }, 50)
    const timer = window.setTimeout(done, timeoutMs)
  })
}
