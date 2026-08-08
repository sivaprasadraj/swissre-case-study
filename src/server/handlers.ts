/**
 * MOCK API — the HTTP boundary.
 *
 * Everything above this line in the stack is production-shaped: the client
 * speaks HTTP, sends filter/sort/cursor params, receives one page of rows plus
 * server-computed permissions, and polls/streams job progress. Replacing MSW
 * with a real BFF is a base-URL change.
 *
 * Deliberate fidelity details:
 *   - artificial latency, so loading states are real and visible
 *   - a configurable failure rate, so retry/recovery paths are exercisable
 *   - 403 on unauthorized mutations even though the UI disables them
 *   - 412 on ETag mismatch (optimistic concurrency)
 *   - 202 + job id for long-running operations, with SSE progress
 */

import { http, HttpResponse, delay } from 'msw'
import type {
  Capability,
  ClaimQuery,
  ClaimStatus,
  ClaimChannel,
  ClaimPriority,
  RoleId,
  Session,
  SlaState,
} from '../domain/types'
import { KNOWN_ADJUSTERS, getDataset } from './dataset'
import { renderPageSvg, renderThumbnailSvg } from './pageRenderer'
import { queryClaims, queryClaimsByPage } from './queryEngine'
import {
  ROLES,
  assertAllowed,
  capabilitiesFor,
  decideForClaim,
  decideForDocument,
  rowVisibilityPredicate,
} from './policy'
import {
  addAnnotation,
  removeAnnotation,
  addComment,
  applyDeletePages,
  applyMerge,
  applySplit,
  createJob,
  documentHistory,
  findDoc,
  getDocumentsForClaim,
  getJob,
  updateJob,
} from './documentStore'

/* ------------------------------------------------------------------ session */

/**
 * In production the session comes from an httpOnly cookie exchanged for a
 * short-lived access token; the browser never handles the token itself.
 *
 * Here the role is switchable so an evaluator can watch RBAC change live. That
 * switch is a PROTOTYPE AFFORDANCE — the real system derives role from the IdP
 * claim, and the client cannot influence it.
 */
let currentRole: RoleId = 'claims_adjuster'

function session(): Session {
  const role = ROLES.find((r) => r.id === currentRole)!
  return {
    // Matches a seeded adjuster so the "Assigned to me" filter returns rows.
    userId: 'u-1041',
    displayName: 'Evano Rijkaard',
    jobTitle: role.jobTitle,
    role: role.id,
    roleLabel: role.label,
    capabilities: capabilitiesFor(role.id),
    region: 'EMEA',
  }
}

/* ------------------------------------------------------- latency & failures */

/** Tunable from the UI so an evaluator can feel slow-network behaviour. */
export const netConfig = { latencyMs: 220, jitterMs: 180, failureRate: 0 }

async function simulateNetwork(): Promise<void> {
  const rng = (netConfig.latencyMs * 7919) % 13 // deterministic-ish jitter
  await delay(netConfig.latencyMs + (rng / 13) * netConfig.jitterMs)
}

let failureCounter = 0
function shouldFail(): boolean {
  if (netConfig.failureRate <= 0) return false
  failureCounter++
  return failureCounter % Math.max(2, Math.round(1 / netConfig.failureRate)) === 0
}

/* -------------------------------------------------------------- param parse */

function parseQuery(url: URL): ClaimQuery {
  const csv = <T extends string>(key: string): T[] | undefined => {
    const raw = url.searchParams.get(key)
    if (!raw) return undefined
    return raw.split(',').filter(Boolean) as T[]
  }

  const sortField = (url.searchParams.get('sortField') ?? 'receivedAt') as ClaimQuery['sort']['field']
  const sortDir = (url.searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc'

  return {
    q: url.searchParams.get('q') ?? undefined,
    status: csv<ClaimStatus>('status'),
    channel: csv<ClaimChannel>('channel'),
    priority: csv<ClaimPriority>('priority'),
    slaState: csv<SlaState>('slaState'),
    assignee: (url.searchParams.get('assignee') as ClaimQuery['assignee']) ?? undefined,
    sort: { field: sortField, direction: sortDir },
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: Math.min(500, Number(url.searchParams.get('limit') ?? 100)),
  }
}

/* ---------------------------------------------------------------- handlers */

export const handlers = [
  /* ------------------------------------------------------------- session */

  http.get('/api/session', async () => {
    await delay(80)
    return HttpResponse.json(session())
  }),

  http.get('/api/roles', async () => {
    await delay(40)
    return HttpResponse.json(ROLES)
  }),

  // Prototype-only. Lets the evaluator switch roles to observe RBAC.
  http.post('/api/session/role', async ({ request }) => {
    const body = (await request.json()) as { role: RoleId }
    currentRole = body.role
    await delay(60)
    return HttpResponse.json(session())
  }),

  http.post('/api/dev/network', async ({ request }) => {
    const body = (await request.json()) as Partial<typeof netConfig>
    Object.assign(netConfig, body)
    return HttpResponse.json(netConfig)
  }),

  /* -------------------------------------------------------------- claims */

  http.get('/api/claims', async ({ request }) => {
    await simulateNetwork()
    if (shouldFail()) {
      return HttpResponse.json(
        { error: 'Upstream claims service timed out.', retryable: true },
        { status: 503 },
      )
    }

    const url = new URL(request.url)
    const q = parseQuery(url)
    const pageParam = url.searchParams.get('page')

    const result = pageParam
      ? queryClaimsByPage(session(), q, Number(pageParam))
      : queryClaims(session(), q)

    return HttpResponse.json(result)
  }),

  /** KPI tiles. Re-pointed at adjudication metrics, not vanity counts. */
  http.get('/api/claims/stats', async () => {
    await delay(140)
    const s = session()
    const all = getDataset()
    const visible = all.filter(rowVisibilityPredicate(s))

    const open = visible.filter(
      (c) => c.status !== 'closed' && c.status !== 'approved' && c.status !== 'denied',
    )
    return HttpResponse.json({
      openClaims: open.length,
      slaBreached: visible.filter((c) => c.slaState === 'breached').length,
      slaAtRisk: visible.filter((c) => c.slaState === 'at_risk').length,
      unassigned: open.filter((c) => c.assigneeId === null).length,
      assignedToMe: open.filter((c) => c.assigneeId === s.userId).length,
      // Volume of document bytes in the open queue — drives capacity planning.
      openDocumentBytes: open.reduce((a, c) => a + c.documentBytes, 0),
    })
  }),

  http.get('/api/claims/:id', async ({ params }) => {
    await simulateNetwork()
    const claim = getDataset().find((c) => c.id === params.id)
    if (!claim) return HttpResponse.json({ error: 'Not found' }, { status: 404 })
    const s = session()
    return HttpResponse.json({ ...claim, permissions: decideForClaim(s, claim) })
  }),

  /**
   * Mutating handlers all follow the same shape:
   *   1. re-derive permissions server-side (never trust the client)
   *   2. assertAllowed -> 403 with a displayable reason
   *   3. apply
   *
   * The UI disables these buttons, yet the check is still here. That redundancy
   * is the point: the UI is a courtesy, this is the control.
   */
  http.patch('/api/claims/:id', async ({ params, request }) => {
    await simulateNetwork()
    const claim = getDataset().find((c) => c.id === params.id)
    if (!claim) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const s = session()
    const gate = assertAllowed(decideForClaim(s, claim), 'claim:edit')
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    const patch = (await request.json()) as Record<string, unknown>
    Object.assign(claim, patch)
    return HttpResponse.json({ ...claim, permissions: decideForClaim(s, claim) })
  }),

  http.post('/api/claims/:id/assign', async ({ params, request }) => {
    await simulateNetwork()
    const claim = getDataset().find((c) => c.id === params.id)
    if (!claim) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const s = session()
    const gate = assertAllowed(decideForClaim(s, claim), 'claim:assign')
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    if (shouldFail()) {
      return HttpResponse.json(
        { error: 'Assignment service unavailable. Please retry.', retryable: true },
        { status: 503 },
      )
    }

    const body = (await request.json()) as { assigneeId: string | null }
    const adjuster = KNOWN_ADJUSTERS.find((a) => a.id === body.assigneeId)
    claim.assigneeId = adjuster?.id ?? null
    claim.assigneeName = adjuster?.name ?? null
    return HttpResponse.json({ ...claim, permissions: decideForClaim(s, claim) })
  }),

  http.delete('/api/claims/:id', async ({ params }) => {
    await simulateNetwork()
    const all = getDataset()
    const idx = all.findIndex((c) => c.id === params.id)
    if (idx < 0) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const s = session()
    const gate = assertAllowed(decideForClaim(s, all[idx]!), 'claim:delete')
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    all.splice(idx, 1)
    return new HttpResponse(null, { status: 204 })
  }),

  http.get('/api/adjusters', async () => {
    await delay(60)
    return HttpResponse.json(KNOWN_ADJUSTERS)
  }),

  /* ----------------------------------------------------------- documents */

  http.get('/api/claims/:id/documents', async ({ params }) => {
    await simulateNetwork()
    const s = session()
    const docs = getDocumentsForClaim(String(params.id))
    return HttpResponse.json(
      docs.map((d) => ({
        ...d.summary,
        permissions: decideForDocument(s, d.summary),
      })),
    )
  }),

  /**
   * The manifest endpoint — the crux of the large-document strategy.
   * A few KB describing a document that may be 1 GB on disk.
   */
  http.get('/api/documents/:docId/manifest', async ({ params }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const s = session()
    return HttpResponse.json({
      ...doc.manifest,
      permissions: decideForDocument(s, doc.summary),
      derivativesReady: doc.summary.derivativesReady,
      ocrStatus: doc.summary.ocrStatus,
    })
  }),

  http.get('/api/documents/:docId/history', async ({ params }) => {
    await delay(90)
    return HttpResponse.json(documentHistory(String(params.docId)))
  }),

  http.get('/api/documents/:docId/comments', async ({ params }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })
    return HttpResponse.json(doc.comments)
  }),

  http.post('/api/documents/:docId/comments', async ({ params, request }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const s = session()
    const gate = assertAllowed(decideForDocument(s, doc.summary), 'document:comment')
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    const body = (await request.json()) as {
      pageId: string
      body: string
      anchor?: { x: number; y: number }
    }
    if (!body.body?.trim()) {
      return HttpResponse.json({ error: 'Comment cannot be empty.' }, { status: 422 })
    }
    const created = addComment(
      String(params.docId),
      body.pageId,
      body.body.trim(),
      { id: s.userId, name: s.displayName },
      body.anchor,
    )
    return HttpResponse.json(created, { status: 201 })
  }),

  http.get('/api/documents/:docId/annotations', async ({ params }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })
    return HttpResponse.json(doc.annotations)
  }),

  http.post('/api/documents/:docId/annotations', async ({ params, request }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const s = session()
    const gate = assertAllowed(decideForDocument(s, doc.summary), 'document:annotate')
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    const body = (await request.json()) as Parameters<typeof addAnnotation>[1]
    const created = addAnnotation(String(params.docId), {
      ...body,
      authorId: s.userId,
      authorName: s.displayName,
    })
    return HttpResponse.json(created, { status: 201 })
  }),

  http.delete('/api/documents/:docId/annotations/:annotationId', async ({ params }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    // Same capability as creating one: if you can annotate, you can remove.
    const s = session()
    const gate = assertAllowed(decideForDocument(s, doc.summary), 'document:annotate')
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    const removed = removeAnnotation(String(params.docId), String(params.annotationId))
    if (!removed) return HttpResponse.json({ error: 'Annotation not found' }, { status: 404 })
    return new HttpResponse(null, { status: 204 })
  }),

  /**
   * Synthetic page thumbnail as an SVG.
   *
   * Stands in for a CDN-served derivative produced by the ingest pipeline. In
   * production these are presigned object-store URLs that bypass the BFF
   * entirely — which is why they are plain URLs in the manifest rather than
   * bytes embedded in the JSON response.
   */
  http.get('/api/documents/:docId/pages/:page/thumbnail', async ({ params }) => {
    // Thumbnails stream in progressively; a small stagger makes that visible.
    await delay(40 + (Number(params.page) % 7) * 25)
    const page = Number(params.page)
    const doc = findDoc(String(params.docId))
    const desc = doc?.manifest.pages.find((p) => p.index === page)

    const svg = renderThumbnailSvg({
      fileName: doc?.manifest.fileName ?? 'document.pdf',
      pageIndex: page,
      pageCount: doc?.manifest.pageCount ?? 1,
      hasTextLayer: desc?.hasTextLayer ?? true,
    })

    return new HttpResponse(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        // Prototype derivatives are generated on the fly, so never cache them.
        // In production these are true immutable per-version artefacts and would
        // use `public, max-age=31536000, immutable` instead.
        'Cache-Control': 'no-store',
      },
    })
  }),

  /**
   * Full page render. Returns a larger synthetic SVG "page".
   *
   * Real implementation: either a pre-rendered tile from the derivative
   * pipeline, or a byte range of the source PDF handed to pdf.js. The prototype
   * uses SVG so the workspace is demonstrable without shipping a 1 GB fixture.
   */
  http.get('/api/documents/:docId/pages/:page/render', async ({ params, request }) => {
    const url = new URL(request.url)
    const scale = Number(url.searchParams.get('scale') ?? 1)
    // Larger renders take longer — this is what the progressive-fidelity ladder
    // (thumbnail → full render) is designed to hide.
    await delay(180 + Math.random() * 220)

    const doc = findDoc(String(params.docId))
    const pageNum = Number(params.page)
    const desc = doc?.manifest.pages.find((p) => p.index === pageNum)

    // Render at the page's natural point size and let the viewer scale it — the
    // SVG is resolution-independent, so `scale` only affects perceived cost here.
    const svg = renderPageSvg({
      fileName: doc?.manifest.fileName ?? 'document.pdf',
      claimNumber: doc?.manifest.fileName.split('_')[0] ?? 'CLM-2026-000000',
      pageIndex: pageNum,
      pageCount: doc?.manifest.pageCount ?? 1,
      version: doc?.manifest.version ?? 'v1000',
      widthPt: desc?.widthPt ?? 595,
      heightPt: desc?.heightPt ?? 842,
      hasTextLayer: desc?.hasTextLayer ?? true,
    })
    void scale

    return new HttpResponse(svg, {
      headers: {
        'Content-Type': 'image/svg+xml',
        // Generated on the fly in the prototype, so never cache. Production
        // per-version derivatives would be immutable and cached hard.
        'Cache-Control': 'no-store',
      },
    })
  }),

  /**
   * Extracted text layer for a page — the accessible representation.
   * Absent when OCR has not completed, which the viewer must handle honestly.
   */
  http.get('/api/documents/:docId/pages/:page/text', async ({ params }) => {
    await delay(120)
    const doc = findDoc(String(params.docId))
    const pageNum = Number(params.page)
    const desc = doc?.manifest.pages.find((p) => p.index === pageNum)
    if (!desc?.hasTextLayer) {
      return HttpResponse.json(
        {
          available: false,
          reason:
            'No text layer. This page was scanned and OCR has not completed for it.',
        },
        { status: 200 },
      )
    }
    return HttpResponse.json({
      available: true,
      text: [
        `${doc?.manifest.fileName} — page ${pageNum}.`,
        'Attending physician statement records the date of first consultation and the primary diagnosis code.',
        'Treatment dates fall within the policy period as scheduled under the governing treaty.',
        'Benefit calculation is subject to the retention and cession terms recorded in the treaty schedule.',
      ].join(' '),
    })
  }),

  /* --------------------------------------------------- long-running jobs */

  /**
   * Structural operations return 202 + a job id rather than blocking.
   *
   * `executor` records where the work ran, so the UI can show it. Server for
   * real documents (the bytes are already there); worker only for the small
   * client-side fallback path.
   */
  http.post('/api/documents/:docId/operations', async ({ params, request }) => {
    await delay(120)
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const body = (await request.json()) as {
      kind: 'split' | 'merge' | 'delete_pages'
      afterIndex?: number
      pageIds?: string[]
      sourceIds?: string[]
      simulateFailureFor?: string
      ifMatch?: string
    }

    const capability: Capability =
      body.kind === 'split'
        ? 'document:split'
        : body.kind === 'merge'
          ? 'document:merge'
          : 'document:delete'

    const s = session()
    const gate = assertAllowed(decideForDocument(s, doc.summary), capability)
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    const job = createJob(body.kind, doc.summary.id, doc.manifest.fileName, 'server')
    // Parked on the job so the SSE stream can apply it at completion.
    pendingOps.set(job.id, { docId: doc.summary.id, ...body })

    return HttpResponse.json(job, { status: 202 })
  }),

  /**
   * Commit output produced client-side in a worker.
   *
   * The worker computed the new document; the server still owns publication.
   * That split matters: compute can happen anywhere, but the version, the ETag
   * and the audit entry are the server's to issue. Without this endpoint a
   * client-side operation would "succeed" while changing nothing — which is
   * worse than failing.
   *
   * The same authorization gate and the same ETag precondition apply as for a
   * server-executed operation. Where the bytes were crunched is irrelevant to
   * whether the caller may publish.
   */
  http.post('/api/documents/:docId/commit', async ({ params, request }) => {
    await simulateNetwork()
    const doc = findDoc(String(params.docId))
    if (!doc) return HttpResponse.json({ error: 'Not found' }, { status: 404 })

    const body = (await request.json()) as {
      kind: 'split' | 'delete_pages'
      afterIndex?: number
      pageIds?: string[]
      ifMatch?: string
    }

    const capability: Capability =
      body.kind === 'split' ? 'document:split' : 'document:delete'

    const s = session()
    const gate = assertAllowed(decideForDocument(s, doc.summary), capability)
    if (!gate.ok) return HttpResponse.json({ error: gate.reason }, { status: 403 })

    const result =
      body.kind === 'split'
        ? applySplit(doc.summary.id, body.afterIndex ?? 1, body.ifMatch ?? null)
        : applyDeletePages(doc.summary.id, body.pageIds ?? [], body.ifMatch ?? null)

    if (!result.ok) {
      return HttpResponse.json({ error: result.error }, { status: result.status })
    }
    return HttpResponse.json({ version: result.version, etag: result.etag })
  }),

  http.get('/api/jobs/:jobId', async ({ params }) => {
    await delay(50)
    const job = getJob(String(params.jobId))
    if (!job) return HttpResponse.json({ error: 'Not found' }, { status: 404 })
    return HttpResponse.json(job)
  }),

  /**
   * Progress via Server-Sent Events.
   *
   * SSE over WebSocket: progress is one-directional, SSE rides plain HTTP (so
   * it inherits auth, proxies and HTTP/2 multiplexing), and EventSource
   * reconnects on its own. A bidirectional socket would be unearned complexity.
   */
  http.get('/api/jobs/:jobId/events', ({ params }) => {
    const jobId = String(params.jobId)
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }

        updateJob(jobId, { state: 'running', message: 'Starting', progress: 0 })
        send(getJob(jobId))

        const stages = [
          { at: 12, message: 'Validating page ranges' },
          { at: 28, message: 'Reading source object' },
          { at: 46, message: 'Rewriting page tree' },
          { at: 64, message: 'Regenerating thumbnails' },
          { at: 82, message: 'Re-indexing text layer' },
          { at: 96, message: 'Publishing new version' },
        ]

        for (const stage of stages) {
          await delay(420)
          const job = getJob(jobId)
          // Cancellation is cooperative: the loop observes the flag and stops.
          if (!job || job.state === 'cancelled') {
            send({ ...job, state: 'cancelled', message: 'Cancelled by user' })
            controller.close()
            return
          }
          updateJob(jobId, { progress: stage.at, message: stage.message })
          send(getJob(jobId))
        }

        // Commit at the end — the new version is published atomically.
        const op = pendingOps.get(jobId)
        let result: { ok: boolean; status: number; version?: string; etag?: string; error?: string; failedInputs?: string[] } = { ok: true, status: 200 }

        if (op) {
          if (op.kind === 'split') {
            result = applySplit(op.docId, op.afterIndex ?? 1, op.ifMatch ?? null)
          } else if (op.kind === 'delete_pages') {
            result = applyDeletePages(op.docId, op.pageIds ?? [], op.ifMatch ?? null)
          } else {
            result = applyMerge(
              op.docId,
              op.sourceIds ?? [],
              op.ifMatch ?? null,
              op.simulateFailureFor,
            )
          }
          pendingOps.delete(jobId)
        }

        if (result.ok) {
          updateJob(jobId, {
            state: 'succeeded',
            progress: 100,
            message: 'Complete',
            resultVersion: result.version,
          })
        } else {
          updateJob(jobId, {
            state: 'failed',
            message: 'Failed',
            error: result.error,
            failedInputs: result.failedInputs,
          })
        }
        send(getJob(jobId))
        controller.close()
      },
    })

    return new HttpResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }),

  http.post('/api/jobs/:jobId/cancel', async ({ params }) => {
    await delay(80)
    const job = updateJob(String(params.jobId), {
      state: 'cancelled',
      message: 'Cancelled by user',
    })
    if (!job) return HttpResponse.json({ error: 'Not found' }, { status: 404 })
    return HttpResponse.json(job)
  }),

  /* ------------------------------------------------- chunked upload (resumable) */

  http.post('/api/uploads', async ({ request }) => {
    await delay(120)
    const body = (await request.json()) as { fileName: string; byteSize: number; chunkSize: number }
    const uploadId = `up-${Math.abs(hash(body.fileName))}`
    const totalChunks = Math.ceil(body.byteSize / body.chunkSize)
    uploads.set(uploadId, { received: new Set(), totalChunks, fileName: body.fileName })
    return HttpResponse.json({ uploadId, totalChunks, chunkSize: body.chunkSize }, { status: 201 })
  }),

  /** Per-chunk PUT with deterministic transient failures, to exercise retry. */
  http.put('/api/uploads/:uploadId/chunks/:index', async ({ params }) => {
    const up = uploads.get(String(params.uploadId))
    if (!up) return HttpResponse.json({ error: 'Unknown upload' }, { status: 404 })
    const idx = Number(params.index)
    await delay(90 + (idx % 5) * 40)

    // Every 7th chunk fails once, then succeeds on retry.
    const key = `${params.uploadId}:${idx}`
    if (idx % 7 === 6 && !retriedChunks.has(key)) {
      retriedChunks.add(key)
      return HttpResponse.json(
        { error: 'Chunk write failed', retryable: true },
        { status: 503 },
      )
    }

    up.received.add(idx)
    return HttpResponse.json({ received: up.received.size, total: up.totalChunks })
  }),

  /** Resume support: the client asks which chunks the server already holds. */
  http.get('/api/uploads/:uploadId', async ({ params }) => {
    await delay(70)
    const up = uploads.get(String(params.uploadId))
    if (!up) return HttpResponse.json({ error: 'Unknown upload' }, { status: 404 })
    return HttpResponse.json({
      uploadId: params.uploadId,
      fileName: up.fileName,
      totalChunks: up.totalChunks,
      receivedChunks: [...up.received].sort((a, b) => a - b),
    })
  }),

  http.post('/api/uploads/:uploadId/complete', async ({ params }) => {
    await delay(200)
    const up = uploads.get(String(params.uploadId))
    if (!up) return HttpResponse.json({ error: 'Unknown upload' }, { status: 404 })
    if (up.received.size !== up.totalChunks) {
      return HttpResponse.json(
        {
          error: `Incomplete: ${up.received.size}/${up.totalChunks} chunks received.`,
          missing: Array.from({ length: up.totalChunks }, (_, i) => i).filter(
            (i) => !up.received.has(i),
          ),
        },
        { status: 409 },
      )
    }
    return HttpResponse.json({ documentId: `doc-new-${params.uploadId}`, status: 'processing' })
  }),
]

/* ------------------------------------------------------------------ locals */

interface PendingOp {
  docId: string
  kind: 'split' | 'merge' | 'delete_pages'
  afterIndex?: number
  pageIds?: string[]
  sourceIds?: string[]
  simulateFailureFor?: string
  ifMatch?: string
}
const pendingOps = new Map<string, PendingOp>()

const uploads = new Map<
  string,
  { received: Set<number>; totalChunks: number; fileName: string }
>()
const retriedChunks = new Set<string>()

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
