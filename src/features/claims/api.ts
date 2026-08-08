/**
 * Data-access layer for the claims grid.
 *
 * All server state flows through TanStack Query. The query key is derived from
 * the URL-encoded query, so caching, deduplication and refetching are automatic
 * and the cache never disagrees with the address bar.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type QueryClient,
} from '@tanstack/react-query'
import type { Claim, ClaimQuery, ClaimQueryResult, DocumentSummary } from '../../domain/types'
import { toSearchParams } from '../../app/useGridState'

export interface ApiError extends Error {
  status: number
  retryable?: boolean
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; retryable?: boolean }
    const err = new Error(body.error ?? `Request failed (${res.status})`) as ApiError
    err.status = res.status
    err.retryable = body.retryable
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const claimKeys = {
  list: (q: ClaimQuery, page: number) => ['claims', toSearchParams(q, page)] as const,
  stats: () => ['claims', 'stats'] as const,
  detail: (id: string) => ['claim', id] as const,
  documents: (claimId: string) => ['documents', claimId] as const,
}

export function useClaims(q: ClaimQuery, page: number) {
  return useQuery({
    queryKey: claimKeys.list(q, page),
    queryFn: () => request<ClaimQueryResult>(`/api/claims?${toSearchParams(q, page)}`),
    // Keeps the previous page on screen while the next loads, so paging doesn't
    // flash an empty grid. This is the single highest-value perceived-perf win
    // in a paginated table.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      const e = error as ApiError
      // Never retry an authorization or validation failure — retrying a 403
      // just burns requests and confuses the user.
      if (e.status === 403 || e.status === 422) return false
      return failureCount < 2
    },
  })
}

export function useClaimStats() {
  return useQuery({
    queryKey: claimKeys.stats(),
    queryFn: () =>
      request<{
        openClaims: number
        slaBreached: number
        slaAtRisk: number
        unassigned: number
        assignedToMe: number
        openDocumentBytes: number
      }>('/api/claims/stats'),
    staleTime: 60_000,
  })
}

export function useClaim(id: string | null) {
  return useQuery({
    queryKey: claimKeys.detail(id ?? ''),
    queryFn: () => request<Claim>(`/api/claims/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
  })
}

export function useClaimDocuments(claimId: string | null) {
  return useQuery({
    queryKey: claimKeys.documents(claimId ?? ''),
    queryFn: () => request<DocumentSummary[]>(`/api/claims/${claimId}/documents`),
    enabled: Boolean(claimId),
    staleTime: 60_000,
  })
}

export function useAdjusters() {
  return useQuery({
    queryKey: ['adjusters'],
    queryFn: () => request<{ id: string; name: string }[]>('/api/adjusters'),
    staleTime: 10 * 60_000,
  })
}

/**
 * Prefetch a claim's documents on row hover/focus.
 *
 * By the time the user clicks, the manifest request is usually already in
 * flight or resolved — which is most of what makes the grid→workspace
 * transition feel instant. Cheap (a few KB) and idempotent.
 */
export function prefetchClaimDocuments(qc: QueryClient, claimId: string): void {
  void qc.prefetchQuery({
    queryKey: claimKeys.documents(claimId),
    queryFn: () => request<DocumentSummary[]>(`/api/claims/${claimId}/documents`),
    staleTime: 60_000,
  })
}

/* ------------------------------------------------------------------ writes */

/**
 * ASSIGN — optimistic.
 *
 * Assignment is high-frequency (a supervisor triaging a queue does it dozens of
 * times in a sitting), low-stakes, and trivially reversible. Waiting for a
 * round-trip on each one makes the queue feel broken. We patch the cache
 * immediately and roll back on failure.
 */
export function useAssignClaim(q: ClaimQuery, page: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { claimId: string; assigneeId: string | null }) =>
      request<Claim>(`/api/claims/${vars.claimId}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigneeId: vars.assigneeId }),
      }),

    onMutate: async (vars) => {
      const key = claimKeys.list(q, page)
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<ClaimQueryResult>(key)

      qc.setQueryData<ClaimQueryResult>(key, (old) => {
        if (!old) return old
        return {
          ...old,
          rows: old.rows.map((r) =>
            r.id === vars.claimId
              ? {
                  ...r,
                  assigneeId: vars.assigneeId,
                  assigneeName: vars.assigneeId ? 'Saving…' : null,
                }
              : r,
          ),
        }
      })

      // Returned context is what onError rolls back to.
      return { previous, key }
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(ctx.key, ctx.previous)
    },

    onSuccess: (updated, _vars, ctx) => {
      // Reconcile with the server's version rather than trusting our guess —
      // the server may have changed derived fields (permissions, SLA state).
      qc.setQueryData<ClaimQueryResult>(ctx.key, (old) =>
        old
          ? { ...old, rows: old.rows.map((r) => (r.id === updated.id ? updated : r)) }
          : old,
      )
      void qc.invalidateQueries({ queryKey: claimKeys.stats() })
    },
  })
}

/**
 * DELETE — pessimistic.
 *
 * Destructive and not reversible from the UI. Optimistically removing a row and
 * then restoring it on failure is a worse experience than a brief spinner: the
 * user has already moved on and mentally closed the task.
 */
export function useDeleteClaim() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (claimId: string) =>
      request<void>(`/api/claims/${claimId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claims'] })
    },
  })
}

/**
 * EDIT — pessimistic, in a form.
 *
 * Multi-field, validated, and the server may normalise values. Showing
 * speculative values in a form the user is still reading invites confusion.
 */
export function useUpdateClaim() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { claimId: string; patch: Partial<Claim> }) =>
      request<Claim>(`/api/claims/${vars.claimId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars.patch),
      }),
    onSuccess: (updated) => {
      qc.setQueryData(claimKeys.detail(updated.id), updated)
      void qc.invalidateQueries({ queryKey: ['claims'] })
    },
  })
}
