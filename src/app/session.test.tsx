/**
 * SESSION GATE TESTS.
 *
 * The session gate is the one component whose failure takes the entire app down,
 * because nothing renders until it resolves. It shipped with a bug worth pinning
 * permanently:
 *
 *     if (!data) return <Spinner />
 *
 * That single line renders the loading state for *every* unsuccessful outcome, so
 * a failed session request became an infinite "Establishing session…" with no
 * error, no retry, and nothing to indicate anything was wrong. It is the same
 * mistake that makes production apps hang on a blank screen after a token expiry.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './session'
import type { Session } from '../domain/types'

const SESSION: Session = {
  userId: 'u-1041',
  displayName: 'Evano Rijkaard',
  jobTitle: 'Adjudication',
  role: 'claims_adjuster',
  roleLabel: 'Claims Adjuster',
  capabilities: ['claim:view'],
  region: 'EMEA',
}

function renderWithClient(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <div data-testid="app">Application</div>
      </SessionProvider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SessionProvider', () => {
  it('renders the app once the session resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          // Content-Type must be set explicitly: `new Response(string)` defaults
          // to text/plain, which the provider correctly rejects.
          new Response(JSON.stringify(SESSION), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )
    renderWithClient()
    await waitFor(() => expect(screen.getByTestId('app')).toBeDefined())
  })

  it('shows the loading state while pending, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    renderWithClient()
    await waitFor(() => expect(screen.getByRole('status')).toBeDefined())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  /** The regression: a failure must surface, not spin forever. */
  it('surfaces an error with a retry when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    )
    renderWithClient()

    // The component sets retry: 1 with a 250ms delay, which overrides the test
    // client's retry: false — so allow for the retry before asserting.
    const alert = await waitFor(() => screen.getByRole('alert'), { timeout: 3000 })
    expect(alert).toBeDefined()
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /reload/i })).toBeDefined()
    // Critically: NOT still claiming to be loading.
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByTestId('app')).toBeNull()
  })

  /**
   * The specific production-shaped failure that motivated this.
   *
   * When the service worker has not yet claimed the page, `/api/session` escapes
   * the mock and the dev server's SPA fallback answers with index.html and HTTP
   * 200. The status looks healthy; JSON parsing is what fails. The gate must
   * treat that as an error rather than an endless spinner.
   */
  it('treats an HTML response with status 200 as an error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html><html><body>SPA fallback</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    )
    renderWithClient()

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined(), { timeout: 3000 })
    expect(screen.queryByRole('status')).toBeNull()
    // The message must name the real problem, not surface a JSON.parse error.
    expect(screen.getByRole('alert').textContent).toMatch(/did not reach the API/i)
  })
})
