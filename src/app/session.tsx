/**
 * Session + authorization mirroring.
 *
 * The critical discipline in this file: nothing here DECIDES anything. It reads
 * decisions the server already made and renders them. If you deleted this file
 * the app would be less pleasant and exactly as secure.
 */

import { createContext, useContext, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Capability, Decision, RecordPermissions, RoleId, Session } from '../domain/types'
import { Tooltip } from '../ui/primitives'

const SessionContext = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { data, isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['session'],
    queryFn: async (): Promise<Session> => {
      const r = await fetch('/api/session', {
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) throw new Error(`Session request failed (${r.status})`)

      /**
       * Validate the content type before parsing.
       *
       * A dev server's SPA fallback answers an unmatched /api/* route with
       * index.html and HTTP 200. Checking `r.ok` alone passes, and the failure
       * then surfaces as an opaque `Unexpected token '<'` from JSON.parse. The
       * same shape occurs in production behind a misconfigured proxy or a captive
       * portal, so the explicit check earns its keep beyond the prototype.
       */
      const contentType = r.headers.get('content-type') ?? ''
      if (!contentType.includes('application/json')) {
        throw new Error(
          `Session endpoint returned ${contentType || 'an unknown content type'} instead of JSON. ` +
            `The request did not reach the API.`,
        )
      }

      return r.json() as Promise<Session>
    },
    // Session shape changes rarely; refetching it on every mount is waste.
    staleTime: 5 * 60_000,
    retry: 1,
    // Bounded, so a failing session surfaces in ~250ms rather than after
    // React Query's default exponential backoff (~1s for the first retry).
    // Nothing renders until this resolves, so the delay is user-visible.
    retryDelay: 250,
  })

  /**
   * Distinguish pending from failed, deliberately.
   *
   * A single `if (!data)` gate here is a trap: it renders the loading spinner for
   * *every* unsuccessful state, so a failed session request becomes an infinite
   * "Establishing session…" with no error, no retry and nothing in the UI to
   * indicate anything is wrong. It cost real debugging time on this prototype,
   * and it is the same mistake that makes production apps hang on a blank screen
   * after a token expiry.
   *
   * The session gate is the one place where getting this wrong takes the whole
   * app down, because nothing renders until it resolves.
   */
  if (error) {
    return (
      <div className="boot boot--error" role="alert">
        <h1>Could not start the application</h1>
        <p>{(error as Error).message}</p>
        <p className="boot__hint">
          The session endpoint did not respond. In this prototype the API is a
          service worker, so the usual cause is that it has not taken control of
          the page yet — a reload normally resolves it.
        </p>
        <div className="boot__actions">
          <button type="button" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </button>
          <button type="button" onClick={() => location.reload()}>
            Reload the page
          </button>
        </div>
      </div>
    )
  }

  if (isPending || !data) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="boot__spinner" aria-hidden="true" />
        <span>Establishing session…</span>
      </div>
    )
  }

  return <SessionContext.Provider value={data}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession must be used inside SessionProvider')
  return s
}

/**
 * Role switcher — a PROTOTYPE AFFORDANCE ONLY.
 *
 * Present so an evaluator can watch authorization change live. In production
 * role comes from the IdP token and the client cannot influence it; there is no
 * endpoint like this.
 *
 * Switching invalidates the entire cache, because every cached response was
 * shaped by the previous caller's permissions. Reusing it would leak rows.
 */
export function useRoleSwitch(): (role: RoleId) => void {
  const qc = useQueryClient()
  const { mutate } = useMutation({
    mutationFn: async (role: RoleId): Promise<Session> => {
      const r = await fetch('/api/session/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      return r.json() as Promise<Session>
    },
    onSuccess: (next) => {
      qc.setQueryData(['session'], next)
      void qc.invalidateQueries()
    },
  })
  return mutate
}

/* ----------------------------------------------------------- capability API */

/**
 * Resolve a capability against a record's server-supplied permissions.
 *
 * Three outcomes, and the distinction is the whole point:
 *   allowed          → render enabled
 *   denied + hidden  → don't render at all (role never holds it)
 *   denied           → render disabled, with the server's reason in a tooltip
 */
export type Resolution =
  | { state: 'allowed' }
  | { state: 'hidden'; reason: string }
  | { state: 'disabled'; reason: string }

export function resolve(
  perms: RecordPermissions | undefined,
  cap: Capability,
): Resolution {
  const d: Decision | undefined = perms?.[cap]
  // Absent decision is treated as hidden. Fail closed, never open.
  if (!d) return { state: 'hidden', reason: 'Not available.' }
  if (d.allowed) return { state: 'allowed' }
  if (d.hidden) return { state: 'hidden', reason: d.reason ?? 'Not available.' }
  return { state: 'disabled', reason: d.reason ?? 'Not permitted.' }
}

/**
 * Declarative gate.
 *
 * Renders nothing when hidden; renders the child disabled-with-reason when the
 * capability is held but denied on this record.
 *
 * `children` receives the resolution so the caller can wire `disabled` onto
 * whatever element it renders — a render prop rather than cloneElement, so
 * there's no guessing about which prop to inject.
 */
export function Can({
  perms,
  capability,
  children,
}: {
  perms: RecordPermissions | undefined
  capability: Capability
  children: (r: { disabled: boolean; reason?: string }) => ReactNode
}): React.JSX.Element | null {
  const res = resolve(perms, capability)

  if (res.state === 'hidden') return null

  if (res.state === 'disabled') {
    return (
      <Tooltip content={res.reason} wrapDisabled>
        {children({ disabled: true, reason: res.reason })}
      </Tooltip>
    )
  }

  return <>{children({ disabled: false })}</>
}

/** Session-level check, for route guards and nav. Not a security boundary. */
export function useHasCapability(cap: Capability): boolean {
  const session = useSession()
  return session.capabilities.includes(cap)
}
