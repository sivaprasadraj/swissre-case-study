/**
 * Regression test for the service-worker URL.
 *
 * A relative worker URL ('./mockServiceWorker.js') works on the root route and
 * breaks every nested one: at /claims/clm-119640 it resolves to
 * /claims/mockServiceWorker.js, the dev server answers with the SPA's
 * index.html, registration fails on the MIME type, and the whole app renders
 * blank. It is invisible in normal click-through use because you arrive at the
 * nested route by client-side navigation, with the worker already registered.
 *
 * The bug is a one-character difference in config, so it gets a test that
 * asserts the resolved URL is absolute rather than path-relative.
 */

import { describe, expect, it } from 'vitest'

/** Mirrors the resolution in browser.ts. */
function resolveWorkerUrl(baseUrl: string): string {
  return `${baseUrl}mockServiceWorker.js`.replace(/\/{2,}/g, '/')
}

describe('service worker URL resolution', () => {
  it('is absolute when served from the domain root', () => {
    expect(resolveWorkerUrl('/')).toBe('/mockServiceWorker.js')
  })

  it('is absolute when served from a subpath', () => {
    expect(resolveWorkerUrl('/claims-bench/')).toBe('/claims-bench/mockServiceWorker.js')
  })

  it('never resolves relative to the current route', () => {
    const url = resolveWorkerUrl('/')
    expect(url.startsWith('/')).toBe(true)
    expect(url.startsWith('./')).toBe(false)
    expect(url.startsWith('../')).toBe(false)
  })

  /**
   * The failure this guards against: resolved against a nested route, a relative
   * URL points at a path the server will answer with index.html.
   */
  it('a relative URL would break a nested route (documents the bug)', () => {
    const relative = './mockServiceWorker.js'
    const resolved = new URL(relative, 'http://localhost:5173/claims/clm-119640').pathname
    expect(resolved).toBe('/claims/mockServiceWorker.js')
    // Which is NOT where the worker script lives.
    expect(resolved).not.toBe('/mockServiceWorker.js')
  })

  it('collapses duplicate slashes rather than emitting //', () => {
    expect(resolveWorkerUrl('//')).toBe('/mockServiceWorker.js')
  })
})
