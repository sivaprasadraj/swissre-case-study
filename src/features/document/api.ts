/**
 * Document data access.
 *
 * The manifest is the whole trick: a few KB of JSON describing a document that
 * may be a gigabyte on disk. Page bytes are fetched individually, on demand,
 * and are independently cacheable and immutable per version.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Annotation,
  DocumentManifest,
  DocumentSummary,
  PageComment,
  RecordPermissions,
} from '../../domain/types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    const err = new Error(body.error ?? `Request failed (${res.status})`) as Error & {
      status: number
    }
    err.status = res.status
    throw err
  }
  // 204 No Content (e.g. DELETE) has no body — don't try to parse it as JSON.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }
  return (await res.json()) as T
}

export type ManifestResponse = DocumentManifest & {
  permissions: RecordPermissions
  derivativesReady: boolean
  ocrStatus: DocumentSummary['ocrStatus']
}

export function useManifest(docId: string | null) {
  return useQuery({
    queryKey: ['manifest', docId],
    queryFn: () => request<ManifestResponse>(`/api/documents/${docId}/manifest`),
    enabled: Boolean(docId),
    // Manifests are per-version immutable, but a job can publish a new version,
    // so we don't cache indefinitely — the job completion invalidates this key.
    staleTime: 60_000,
  })
}

export function useComments(docId: string | null) {
  return useQuery({
    queryKey: ['comments', docId],
    queryFn: () => request<PageComment[]>(`/api/documents/${docId}/comments`),
    enabled: Boolean(docId),
    staleTime: 30_000,
  })
}

export function useAnnotations(docId: string | null) {
  return useQuery({
    queryKey: ['annotations', docId],
    queryFn: () => request<Annotation[]>(`/api/documents/${docId}/annotations`),
    enabled: Boolean(docId),
    staleTime: 30_000,
  })
}

export function useDocHistory(docId: string | null) {
  return useQuery({
    queryKey: ['doc-history', docId],
    queryFn: () => request<{ version: string; note: string }[]>(`/api/documents/${docId}/history`),
    enabled: Boolean(docId),
    staleTime: 30_000,
  })
}

/** Page text layer — the accessible representation of a rendered page. */
export function usePageText(docId: string | null, page: number | null) {
  return useQuery({
    queryKey: ['page-text', docId, page],
    queryFn: () =>
      request<{ available: boolean; text?: string; reason?: string }>(
        `/api/documents/${docId}/pages/${page}/text`,
      ),
    enabled: Boolean(docId && page),
    staleTime: 5 * 60_000,
  })
}

/**
 * Add a page comment — optimistic.
 *
 * Comments are additive, cheap, and the author is looking right at where it
 * should appear. A round-trip delay before the comment shows up feels broken.
 */
export function useAddComment(docId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { pageId: string; body: string; anchor?: { x: number; y: number } }) =>
      request<PageComment>(`/api/documents/${docId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      }),

    onMutate: async (vars) => {
      const key = ['comments', docId]
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<PageComment[]>(key)

      const optimistic: PageComment = {
        id: `optimistic-${vars.pageId}-${previous?.length ?? 0}`,
        documentId: docId,
        pageId: vars.pageId,
        authorId: 'me',
        authorName: 'You',
        body: vars.body,
        createdAt: new Date(Date.UTC(2026, 0, 6)).toISOString(),
        resolved: false,
        anchor: vars.anchor,
      }
      qc.setQueryData<PageComment[]>(key, [...(previous ?? []), optimistic])
      return { previous, key }
    },

    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(ctx.key, ctx.previous)
    },

    // Reconcile with the server's canonical record (real id, real timestamp).
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['comments', docId] })
    },
  })
}

export function useAddAnnotation(docId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: Omit<Annotation, 'id' | 'createdAt' | 'authorId' | 'authorName'>) =>
      request<Annotation>(`/api/documents/${docId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vars),
      }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['annotations', docId] })
    },
  })
}

export function useRemoveAnnotation(docId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (annotationId: string) =>
      request<void>(`/api/documents/${docId}/annotations/${annotationId}`, {
        method: 'DELETE',
      }),

    // Optimistic: annotations are cheap and easily re-added, so remove it from
    // the overlay immediately and roll back if the server rejects.
    onMutate: async (annotationId) => {
      const key = ['annotations', docId]
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<Annotation[]>(key)
      qc.setQueryData<Annotation[]>(key, (old) => (old ?? []).filter((a) => a.id !== annotationId))
      return { previous, key }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(ctx.key, ctx.previous)
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['annotations', docId] })
    },
  })
}
