/**
 * DOCUMENT WORKSPACE.
 *
 * A 1 GB claims bundle is delivered as a manifest (a few KB of JSON) plus N
 * independently-addressable, independently-cacheable page resources. The client
 * fetches the manifest, renders the pages currently in view, and holds at most
 * RETAIN_LIMIT decoded pages in memory. Time-to-first-page is a function of one
 * page's size, not the document's.
 *
 * Everything else here follows from that:
 *   - thumbnails stream in from the derivative pipeline, so navigation is
 *     possible before any full page has rendered
 *   - structural operations are sent as instructions to where the bytes already
 *     live, and tracked as jobs with progress and cancel
 *   - annotations anchor to stable page IDENTITY, not page position, so a split
 *     or merge doesn't silently move them onto the wrong page
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { Annotation, PageComment, PageDescriptor } from '../../domain/types'
import { Can, useSession } from '../../app/session'
import { useJobs } from '../../app/jobs'
import { useClaim, useClaimDocuments } from '../claims/api'
import { formatBytes, formatDate } from '../claims/format'
import {
  useAddAnnotation,
  useRemoveAnnotation,
  useAddComment,
  useAnnotations,
  useComments,
  useDocHistory,
  useManifest,
  usePageText,
} from './api'
import { RETAIN_LIMIT, usePageWindow } from './usePageWindow'
import { useDocumentWorker } from './useDocumentWorker'
import {
  Button,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  Modal,
  Pill,
  Skeleton,
  ToastStack,
  WarningIcon,
  type Toast,
} from '../../ui/primitives'
import './DocumentWorkspace.scss'

export function DocumentWorkspace(): React.JSX.Element {
  const { claimId } = useParams<{ claimId: string }>()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const session = useSession()
  const jobs = useJobs()

  const claim = useClaim(claimId ?? null)
  const documents = useClaimDocuments(claimId ?? null)

  // Selected document lives in the URL, so a specific document in a specific
  // claim is a shareable link.
  const docId = params.get('doc') ?? documents.data?.[0]?.id ?? null
  const manifest = useManifest(docId)
  const comments = useComments(docId)
  const annotations = useAnnotations(docId)
  const history = useDocHistory(docId)

  const addComment = useAddComment(docId ?? '')
  const addAnnotation = useAddAnnotation(docId ?? '')
  const removeAnnotation = useRemoveAnnotation(docId ?? '')

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastSeq = useRef(0)
  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { ...t, id }])
    if (t.tone !== 'error') {
      window.setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), 5000)
    }
  }, [])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null)
  useEffect(() => setScrollRoot(scrollRef.current), [manifest.data?.documentId])

  const pageCount = manifest.data?.pageCount ?? 0
  const pageWindow = usePageWindow(pageCount, scrollRoot)

  const [zoom, setZoom] = useState(1)
  const [tool, setTool] = useState<'select' | 'highlight' | 'redact' | 'comment'>('select')
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set())
  const [splitOpen, setSplitOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [sidebar, setSidebar] = useState<'pages' | 'comments' | 'outline' | 'history'>('pages')

  const worker = useDocumentWorker()

  /* --------------------------------------------------- derived collections */

  // Group by pageId, not page index — see the annotation-anchoring note.
  const commentsByPage = useMemo(() => {
    const m = new Map<string, PageComment[]>()
    for (const c of comments.data ?? []) {
      const bucket = m.get(c.pageId) ?? []
      bucket.push(c)
      m.set(c.pageId, bucket)
    }
    return m
  }, [comments.data])

  const annotationsByPage = useMemo(() => {
    const m = new Map<string, Annotation[]>()
    for (const a of annotations.data ?? []) {
      const bucket = m.get(a.pageId) ?? []
      bucket.push(a)
      m.set(a.pageId, bucket)
    }
    return m
  }, [annotations.data])

  /**
   * Comments whose page no longer exists in the current version — orphaned by a
   * split or a page deletion.
   *
   * Adjudication commentary generally cannot be hard-deleted for retention
   * reasons, so we surface these rather than dropping them. Most viewers just
   * lose them silently; that's a compliance problem, not a UX nicety.
   */
  const orphanedComments = useMemo(() => {
    if (!manifest.data) return []
    const live = new Set(manifest.data.pages.map((p) => p.pageId))
    return (comments.data ?? []).filter((c) => !live.has(c.pageId))
  }, [comments.data, manifest.data])

  const currentDoc = documents.data?.find((d) => d.id === docId)
  const perms = manifest.data?.permissions

  /* ---------------------------------------------------------------- actions */

  const selectDoc = useCallback(
    (id: string) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('doc', id)
          return next
        },
        { replace: true },
      )
      setSelectedPages(new Set())
      scrollRef.current?.scrollTo({ top: 0 })
    },
    [setParams],
  )

  const startSplit = useCallback(
    async (afterIndex: number) => {
      if (!manifest.data || !currentDoc) return
      setSplitOpen(false)

      // Try the client-side path first for small documents. The worker refuses
      // above its size limit and tells us to delegate — which is the decision
      // rule made executable rather than just documented.
      const attempt = await worker.trySplit({
        byteSize: manifest.data.byteSize,
        pageCount: manifest.data.pageCount,
        afterIndex,
        documentName: manifest.data.fileName,
        documentId: manifest.data.documentId,
        etag: manifest.data.etag,
      })

      if (attempt === 'refused') {
        pushToast({
          tone: 'info',
          message: `${formatBytes(manifest.data.byteSize)} exceeds the client-side limit — running on the server instead.`,
        })
        await jobs.start({
          documentId: manifest.data.documentId,
          kind: 'split',
          afterIndex,
          // Optimistic concurrency: if someone else published a version since we
          // loaded, the server rejects with 412 rather than clobbering them.
          ifMatch: manifest.data.etag,
        })
      }
    },
    [manifest.data, currentDoc, worker, jobs, pushToast],
  )

  const startMerge = useCallback(
    async (sourceIds: string[], simulateFailure: boolean) => {
      if (!manifest.data) return
      setMergeOpen(false)
      await jobs.start({
        documentId: manifest.data.documentId,
        kind: 'merge',
        sourceIds,
        simulateFailureFor: simulateFailure ? sourceIds[0] : undefined,
        ifMatch: manifest.data.etag,
      })
    },
    [manifest.data, jobs],
  )

  const startDeletePages = useCallback(async () => {
    if (!manifest.data || selectedPages.size === 0) return
    await jobs.start({
      documentId: manifest.data.documentId,
      kind: 'delete_pages',
      pageIds: [...selectedPages],
      ifMatch: manifest.data.etag,
    })
    setSelectedPages(new Set())
  }, [manifest.data, selectedPages, jobs])

  const togglePageSelection = useCallback((pageId: string) => {
    setSelectedPages((prev) => {
      const next = new Set(prev)
      if (next.has(pageId)) next.delete(pageId)
      else next.add(pageId)
      return next
    })
  }, [])

  const goToPage = useCallback((page: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  /* ------------------------------------------------------- loading ladder */

  // Stage 1: the skeleton, shown while claim + document list resolve.
  if (documents.isLoading || claim.isLoading) {
    return <WorkspaceSkeleton claimId={claimId ?? ''} />
  }

  if (!documents.data?.length) {
    return (
      <div className="ws">
        <WorkspaceHeader
          claimNumber={claim.data?.claimNumber ?? claimId ?? ''}
          claimantName={claim.data?.claimantName ?? ''}
          onBack={() => navigate(-1)}
        />
        <div className="ws__empty">
          <div className="state__glyph" aria-hidden="true">
            <DocGlyph />
          </div>
          <h3>No documents attached</h3>
          <p>
            This claim has no documents yet. Documents arrive through the intake
            channels (email, SFTP, portal) and appear here once the ingest
            pipeline has indexed them.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ws">
      <WorkspaceHeader
        claimNumber={claim.data?.claimNumber ?? claimId ?? ''}
        claimantName={claim.data?.claimantName ?? ''}
        onBack={() => navigate(-1)}
        right={
          <div className="ws__docpicker">
            <label className="sr-only" htmlFor="docpick">
              Select document
            </label>
            <select id="docpick" value={docId ?? ''} onChange={(e) => selectDoc(e.target.value)}>
              {documents.data.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fileName} — {formatBytes(d.byteSize)} · {d.pageCount}pp
                </option>
              ))}
            </select>
            <span className="ws__docpicker-chev" aria-hidden="true">
              <ChevronIcon />
            </span>
          </div>
        }
      />

      {/* Document-level status banner: the honest state of the derivative
          pipeline, which is what gates the structural operations. */}
      {currentDoc ? (
        <div className="ws__banner">
          <div className="ws__bannerinfo">
            <strong>{currentDoc.fileName}</strong>
            <span className="ws__meta">
              {formatBytes(currentDoc.byteSize)} · {manifest.data?.pageCount ?? currentDoc.pageCount}{' '}
              pages · received {formatDate(currentDoc.receivedAt)} ·{' '}
              <span className="ws__version">{manifest.data?.version ?? currentDoc.version}</span>
            </span>
          </div>

          <div className="ws__badges">
            {currentDoc.derivativesReady ? (
              <Pill tone="success" icon={<CheckIcon />}>
                Page index ready
              </Pill>
            ) : (
              <Pill tone="warning" icon={<WarningIcon />} title="The ingest pipeline is still producing page derivatives. Structural operations are unavailable until it completes.">
                Indexing…
              </Pill>
            )}
            <Pill
              tone={currentDoc.ocrStatus === 'complete' ? 'success' : 'neutral'}
              title="A text layer is what makes the document readable by assistive technology and searchable."
            >
              OCR: {currentDoc.ocrStatus}
            </Pill>
            {/* Memory read-out. Normally internal, surfaced here because the
                bounded page window is the point of the design. */}
            <Pill tone="brand" title={`At most ${RETAIN_LIMIT} decoded pages are held in memory at once. ${pageWindow.stats.evicted} have been evicted so far this session.`}>
              {pageWindow.stats.retained}/{RETAIN_LIMIT} pages in memory
            </Pill>
          </div>
        </div>
      ) : null}

      {/* Toolbar: view controls, annotation tools, structural operations. */}
      <div className="ws__toolbar">
        <div className="ws__tools" role="group" aria-label="Annotation tools">
          {(
            [
              { id: 'select', label: 'Select' },
              { id: 'highlight', label: 'Highlight' },
              { id: 'redact', label: 'Redact' },
              { id: 'comment', label: 'Comment' },
            ] as const
          ).map((t) => {
            const cap = t.id === 'comment' ? 'document:comment' : 'document:annotate'
            if (t.id === 'select') {
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`ws__tool ${tool === t.id ? 'is-on' : ''}`}
                  aria-pressed={tool === t.id}
                  onClick={() => setTool(t.id)}
                >
                  {t.label}
                </button>
              )
            }
            return (
              <Can key={t.id} perms={perms} capability={cap}>
                {({ disabled }) => (
                  <button
                    type="button"
                    className={`ws__tool ${tool === t.id ? 'is-on' : ''}`}
                    aria-pressed={tool === t.id}
                    disabled={disabled}
                    onClick={() => setTool(t.id)}
                  >
                    {t.label}
                  </button>
                )}
              </Can>
            )
          })}
        </div>

        <div className="ws__zoom" role="group" aria-label="Zoom">
          <Button size="sm" iconOnly onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="Zoom out">
            −
          </Button>
          <span className="ws__zoomval">{Math.round(zoom * 100)}%</span>
          <Button size="sm" iconOnly onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="Zoom in">
            +
          </Button>
        </div>

        <div className="ws__ops">
          {selectedPages.size > 0 ? (
            <Can perms={perms} capability="document:delete">
              {({ disabled }) => (
                <Button size="sm" variant="danger" disabled={disabled} onClick={() => void startDeletePages()}>
                  Delete {selectedPages.size} page{selectedPages.size === 1 ? '' : 's'}
                </Button>
              )}
            </Can>
          ) : null}

          <Can perms={perms} capability="document:split">
            {({ disabled }) => (
              <Button size="sm" disabled={disabled} onClick={() => setSplitOpen(true)}>
                Split
              </Button>
            )}
          </Can>

          <Can perms={perms} capability="document:merge">
            {({ disabled }) => (
              <Button size="sm" disabled={disabled} onClick={() => setMergeOpen(true)}>
                Merge
              </Button>
            )}
          </Can>
        </div>
      </div>

      <div className="ws__body">
        {/* ------------------------------------------------------ sidebar */}
        <aside className="ws__side" aria-label="Document navigation">
          <div className="ws__tabs" role="tablist" aria-label="Sidebar sections">
            {(
              [
                { id: 'pages', label: 'Pages' },
                { id: 'outline', label: 'Outline' },
                { id: 'comments', label: `Comments${comments.data?.length ? ` (${comments.data.length})` : ''}` },
                { id: 'history', label: 'Versions' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={sidebar === t.id}
                className={sidebar === t.id ? 'is-on' : ''}
                onClick={() => setSidebar(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="ws__sidebody" role="tabpanel">
            {sidebar === 'pages' ? (
              <ThumbnailRail
                docId={docId}
                pages={manifest.data?.pages ?? []}
                currentPage={pageWindow.currentPage}
                selected={selectedPages}
                loading={manifest.isLoading}
                commentCounts={commentsByPage}
                onGo={goToPage}
                onToggleSelect={togglePageSelection}
              />
            ) : sidebar === 'outline' ? (
              <OutlineTree nodes={manifest.data?.outline ?? []} onGo={goToPage} />
            ) : sidebar === 'comments' ? (
              <CommentList
                comments={comments.data ?? []}
                orphaned={orphanedComments}
                pages={manifest.data?.pages ?? []}
                onGo={goToPage}
              />
            ) : (
              <VersionList entries={history.data ?? []} current={manifest.data?.version} />
            )}
          </div>
        </aside>

        {/* -------------------------------------------------- page canvas */}
        <div className="ws__viewer" ref={scrollRef} tabIndex={-1}>
          {manifest.isLoading ? (
            <div className="ws__pageskel">
              <Skeleton width={620} height={860} radius="var(--radius-sm)" />
            </div>
          ) : manifest.error ? (
            <div className="state state--error" role="alert">
              <div className="state__glyph state__glyph--error" aria-hidden="true">
                <WarningIcon />
              </div>
              <h3>Could not load the document manifest</h3>
              <p>{(manifest.error as Error).message}</p>
            </div>
          ) : (
            manifest.data?.pages.map((page) => (
              <PageView
                key={page.pageId}
                docId={manifest.data!.documentId}
                page={page}
                zoom={zoom}
                /* The window decides whether this page's bytes are fetched at
                   all. Outside the window we render a sized placeholder, so
                   scroll geometry stays correct without holding the render. */
                shouldRender={pageWindow.active.has(page.index)}
                observe={pageWindow.observe}
                annotations={annotationsByPage.get(page.pageId) ?? []}
                comments={commentsByPage.get(page.pageId) ?? []}
                tool={tool}
                selected={selectedPages.has(page.pageId)}
                canComment={perms?.['document:comment']?.allowed ?? false}
                canAnnotate={perms?.['document:annotate']?.allowed ?? false}
                onToggleSelect={togglePageSelection}
                onAddComment={(pageId, body, anchor) => {
                  addComment.mutate(
                    { pageId, body, anchor },
                    {
                      onError: (e) =>
                        pushToast({ tone: 'error', message: `Comment failed: ${(e as Error).message}` }),
                    },
                  )
                }}
                onAddAnnotation={(pageId, kind, rect) => {
                  addAnnotation.mutate(
                    {
                      documentId: manifest.data!.documentId,
                      pageId,
                      kind,
                      rect,
                      color: kind === 'redaction' ? '#16171b' : '#f0a22e',
                    },
                    {
                      onError: (e) =>
                        pushToast({ tone: 'error', message: `Annotation failed: ${(e as Error).message}` }),
                    },
                  )
                }}
                onRemoveAnnotation={(annotationId) => {
                  removeAnnotation.mutate(annotationId, {
                    onError: (e) =>
                      pushToast({ tone: 'error', message: `Could not remove: ${(e as Error).message}` }),
                  })
                }}
              />
            ))
          )}
        </div>

        {/* ---------------------------------------------- accessible text */}
        <aside className="ws__text" aria-label="Page text">
          <PageTextPanel docId={docId} page={pageWindow.currentPage} />
        </aside>
      </div>

      {/* Page position live region — announces the current page as the user
          scrolls, without moving focus. */}
      <div className="sr-only" role="status" aria-live="polite">
        {pageCount ? `Page ${pageWindow.currentPage} of ${pageCount}` : ''}
      </div>

      {/* ----------------------------------------------------------- dialogs */}

      <SplitDialog
        open={splitOpen}
        pageCount={pageCount}
        byteSize={manifest.data?.byteSize ?? 0}
        onClose={() => setSplitOpen(false)}
        onConfirm={(after) => void startSplit(after)}
      />

      <MergeDialog
        open={mergeOpen}
        target={currentDoc?.fileName ?? ''}
        candidates={(documents.data ?? []).filter((d) => d.id !== docId)}
        onClose={() => setMergeOpen(false)}
        onConfirm={(ids, fail) => void startMerge(ids, fail)}
      />

      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((p) => p.filter((t) => t.id !== id))} />

      <div className="sr-only">
        Signed in as {session.displayName}, {session.roleLabel}.
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------- header */

function WorkspaceHeader({
  claimNumber,
  claimantName,
  onBack,
  right,
}: {
  claimNumber: string
  claimantName: string
  onBack: () => void
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="ws__head">
      <div className="ws__headleft">
        {/* Back preserves the grid's URL state, so the user returns to the same
            filtered page and scroll position — not a reset queue. */}
        <Button size="sm" variant="ghost" onClick={onBack} aria-label="Back to workqueue">
          <ChevronIcon dir="left" /> Workqueue
        </Button>
        <div className="ws__crumb">
          <Link to="/claims">Claims</Link>
          <span aria-hidden="true">/</span>
          <strong>{claimNumber}</strong>
          {claimantName ? <span className="ws__claimant">{claimantName}</span> : null}
        </div>
      </div>
      {right}
    </header>
  )
}

/* -------------------------------------------------------------- PageView */

interface PageViewProps {
  docId: string
  page: PageDescriptor
  zoom: number
  shouldRender: boolean
  observe: (page: number, el: HTMLElement | null) => void
  annotations: Annotation[]
  comments: PageComment[]
  tool: 'select' | 'highlight' | 'redact' | 'comment'
  selected: boolean
  canComment: boolean
  canAnnotate: boolean
  onToggleSelect: (pageId: string) => void
  onAddComment: (pageId: string, body: string, anchor?: { x: number; y: number }) => void
  onAddAnnotation: (
    pageId: string,
    kind: Annotation['kind'],
    rect: { x: number; y: number; w: number; h: number },
  ) => void
  onRemoveAnnotation: (annotationId: string) => void
}

/**
 * One page.
 *
 * The critical behaviour: when `shouldRender` is false we render a correctly
 * SIZED placeholder rather than nothing. Scroll geometry stays stable (no
 * jumping scrollbar), the IntersectionObserver still has a target, and no bytes
 * are fetched. The dimensions come from the manifest, which is why the manifest
 * carries page dimensions at all.
 */
function PageView({
  docId,
  page,
  zoom,
  shouldRender,
  observe,
  annotations,
  comments,
  tool,
  selected,
  canComment,
  canAnnotate,
  onToggleSelect,
  onAddComment,
  onAddAnnotation,
  onRemoveAnnotation,
}: PageViewProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Which existing comment's popover is open (by id). Clicking a pin opens it.
  const [openComment, setOpenComment] = useState<string | null>(null)

  useEffect(() => {
    observe(page.index, ref.current)
    return () => observe(page.index, null)
  }, [observe, page.index])

  // Reset the decoded flag when the page leaves the window, so re-entering
  // re-runs the fade-in and — more importantly — lets the browser release the
  // decoded image.
  useEffect(() => {
    if (!shouldRender) setLoaded(false)
  }, [shouldRender])

  const scale = zoom
  const width = Math.round(page.widthPt * scale)
  const height = Math.round(page.heightPt * scale)

  const toNormalized = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    }
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (tool === 'highlight' || tool === 'redact') {
      if (!canAnnotate) return
      // Prevent the browser's native image-drag and text-selection, which
      // otherwise "grab" the page instead of letting us draw a rectangle.
      e.preventDefault()
      setDragStart(toNormalized(e))
    }
  }

  const onMouseMove = (e: React.MouseEvent): void => {
    if (!dragStart) return
    e.preventDefault()
    const p = toNormalized(e)
    setDragRect({
      x: Math.min(dragStart.x, p.x),
      y: Math.min(dragStart.y, p.y),
      w: Math.abs(p.x - dragStart.x),
      h: Math.abs(p.y - dragStart.y),
    })
  }

  const onMouseUp = (): void => {
    if (dragRect && dragRect.w > 0.01 && dragRect.h > 0.005) {
      onAddAnnotation(page.pageId, tool === 'redact' ? 'redaction' : 'highlight', dragRect)
    }
    setDragStart(null)
    setDragRect(null)
  }

  const onClick = (e: React.MouseEvent): void => {
    if (tool === 'comment' && canComment) {
      setDraft(toNormalized(e))
    }
  }

  return (
    <div className="pg" ref={ref} data-page={page.index}>
      <div className="pg__gutter">
        <label className="pg__select">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(page.pageId)}
            aria-label={`Select page ${page.index}`}
          />
        </label>
        <span className="pg__num">{page.index}</span>
        {comments.length > 0 ? (
          <span className="pg__cmtcount" title={`${comments.length} comment(s)`}>
            {comments.length}
          </span>
        ) : null}
        {!page.hasTextLayer ? (
          <span className="pg__notext" title="No text layer — this page is not readable by assistive technology until OCR completes.">
            <WarningIcon />
          </span>
        ) : null}
      </div>

      <div
        className={`pg__sheet ${selected ? 'is-selected' : ''} pg__sheet--${tool}`}
        style={{ width, height }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          setDragStart(null)
          setDragRect(null)
        }}
        onClick={onClick}
      >
        {shouldRender ? (
          <>
            {/* Progressive fidelity: the (already cached) thumbnail is shown
                blurred and upscaled until the full render decodes. The user sees
                page content within ~40ms instead of an empty rectangle. */}
            <img
              className="pg__lowres"
              src={`/api/documents/${docId}/pages/${page.index}/thumbnail`}
              alt=""
              aria-hidden="true"
              style={{ opacity: loaded ? 0 : 1 }}
            />
            <img
              className="pg__img"
              src={`/api/documents/${docId}/pages/${page.index}/render?scale=${Math.min(2, Math.max(1, Math.round(zoom * 2) / 2))}`}
              alt={`Page ${page.index}`}
              width={width}
              height={height}
              /* Native lazy loading as a second line of defence behind the
                 window; harmless if the window already gated it. */
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              style={{ opacity: loaded ? 1 : 0 }}
            />
          </>
        ) : (
          // Sized placeholder: correct geometry, zero bytes.
          <div className="pg__placeholder" aria-hidden="true">
            <span>Page {page.index}</span>
            <small>not in view</small>
          </div>
        )}

        {/* Annotation overlay. Normalized coordinates → survives zoom without
            recomputation, and survives re-render because it's anchored to
            pageId. */}
        <div className="pg__overlay">
          {annotations.map((a) => (
            <div
              key={a.id}
              className={`ann ann--${a.kind} ${canAnnotate ? 'ann--removable' : ''}`}
              style={{
                left: `${a.rect.x * 100}%`,
                top: `${a.rect.y * 100}%`,
                width: `${a.rect.w * 100}%`,
                height: `${a.rect.h * 100}%`,
                background: a.kind === 'redaction' ? a.color : undefined,
                borderColor: a.color,
              }}
              title={`${a.kind} by ${a.authorName}${a.note ? ` — ${a.note}` : ''}`}
            >
              {canAnnotate ? (
                <button
                  type="button"
                  className="ann__remove"
                  aria-label={`Remove ${a.kind}`}
                  title={`Remove ${a.kind}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveAnnotation(a.id)
                  }}
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>
          ))}

          {dragRect ? (
            <div
              className={`ann ann--draft ann--${tool === 'redact' ? 'redaction' : 'highlight'}`}
              style={{
                left: `${dragRect.x * 100}%`,
                top: `${dragRect.y * 100}%`,
                width: `${dragRect.w * 100}%`,
                height: `${dragRect.h * 100}%`,
              }}
            />
          ) : null}

          {comments.map((c) =>
            c.anchor ? (
              <div
                key={c.id}
                className="cmtpin-wrap"
                style={{ left: `${c.anchor.x * 100}%`, top: `${c.anchor.y * 100}%` }}
              >
                <button
                  type="button"
                  className={`cmtpin ${c.resolved ? 'is-resolved' : ''} ${c.id.startsWith('optimistic') ? 'is-pending' : ''}`}
                  aria-label={`Comment by ${c.authorName}`}
                  aria-expanded={openComment === c.id}
                  onClick={(e) => {
                    // Stop the click reaching the sheet, which would otherwise
                    // open a new "add comment" draft on top of this one.
                    e.stopPropagation()
                    setOpenComment((prev) => (prev === c.id ? null : c.id))
                  }}
                >
                  {c.authorName
                    .split(' ')
                    .map((n) => n[0])
                    .join('')}
                </button>

                {openComment === c.id ? (
                  <div className="cmtpop" onClick={(e) => e.stopPropagation()}>
                    <div className="cmtpop__head">
                      <span className="cmtpop__author">{c.authorName}</span>
                      {c.resolved ? (
                        <span className="cmtpop__resolved">
                          <CheckIcon /> Resolved
                        </span>
                      ) : null}
                    </div>
                    <p className="cmtpop__body">{c.body}</p>
                    <button
                      type="button"
                      className="cmtpop__close"
                      aria-label="Close comment"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenComment(null)
                      }}
                    >
                      Close
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null,
          )}

          {draft ? (
            <div
              className="cmtdraft"
              style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
              onClick={(e) => e.stopPropagation()}
            >
              <textarea
                autoFocus
                value={draftBody}
                placeholder="Add a page comment…"
                onChange={(e) => setDraftBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setDraft(null)
                    setDraftBody('')
                  }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draftBody.trim()) {
                    onAddComment(page.pageId, draftBody.trim(), draft)
                    setDraft(null)
                    setDraftBody('')
                  }
                }}
              />
              <div className="cmtdraft__actions">
                <small>⌘↵ to save</small>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(null)
                    setDraftBody('')
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!draftBody.trim()}
                  onClick={() => {
                    onAddComment(page.pageId, draftBody.trim(), draft)
                    setDraft(null)
                    setDraftBody('')
                  }}
                >
                  Comment
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------- ThumbnailRail */

function ThumbnailRail({
  docId,
  pages,
  currentPage,
  selected,
  loading,
  commentCounts,
  onGo,
  onToggleSelect,
}: {
  docId: string | null
  pages: PageDescriptor[]
  currentPage: number
  selected: Set<string>
  loading: boolean
  commentCounts: Map<string, PageComment[]>
  onGo: (p: number) => void
  onToggleSelect: (pageId: string) => void
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="rail-thumbs">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} width={108} height={150} radius="var(--radius-sm)" />
        ))}
      </div>
    )
  }

  return (
    <ul className="rail-thumbs">
      {pages.map((p) => (
        <li key={p.pageId}>
          <div className={`thumb ${p.index === currentPage ? 'is-current' : ''} ${selected.has(p.pageId) ? 'is-selected' : ''}`}>
            <button type="button" onClick={() => onGo(p.index)} aria-label={`Go to page ${p.index}`}>
              {/* Thumbnails are tiny, immutable, CDN-cacheable derivatives.
                  Native lazy loading is enough here — a 4,000-page rail would
                  otherwise fire 4,000 requests. */}
              <img
                src={`/api/documents/${docId}/pages/${p.index}/thumbnail`}
                alt=""
                width={108}
                height={150}
                loading="lazy"
                decoding="async"
              />
            </button>
            <label className="thumb__check">
              <input
                type="checkbox"
                checked={selected.has(p.pageId)}
                onChange={() => onToggleSelect(p.pageId)}
                aria-label={`Select page ${p.index}`}
              />
            </label>
            <span className="thumb__num">{p.index}</span>
            {commentCounts.get(p.pageId)?.length ? (
              <span className="thumb__badge">{commentCounts.get(p.pageId)!.length}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------ OutlineTree */

function OutlineTree({
  nodes,
  onGo,
  depth = 0,
}: {
  nodes: { title: string; pageIndex: number; children?: { title: string; pageIndex: number }[] }[]
  onGo: (p: number) => void
  depth?: number
}): React.JSX.Element {
  return (
    <ul className="outline" style={{ paddingLeft: depth === 0 ? 0 : 'var(--space-4)' }}>
      {nodes.map((n) => (
        <li key={`${n.title}-${n.pageIndex}`}>
          <button type="button" onClick={() => onGo(n.pageIndex)}>
            <span className="outline__title">{n.title}</span>
            <span className="outline__page">{n.pageIndex}</span>
          </button>
          {n.children?.length ? <OutlineTree nodes={n.children} onGo={onGo} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------ CommentList */

function CommentList({
  comments,
  orphaned,
  pages,
  onGo,
}: {
  comments: PageComment[]
  orphaned: PageComment[]
  pages: PageDescriptor[]
  onGo: (p: number) => void
}): React.JSX.Element {
  const pageIndexById = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of pages) m.set(p.pageId, p.index)
    return m
  }, [pages])

  const live = comments.filter((c) => pageIndexById.has(c.pageId))

  if (live.length === 0 && orphaned.length === 0) {
    return <p className="ws__hint">No comments on this document yet.</p>
  }

  return (
    <div className="cmtlist">
      {live.map((c) => (
        <article key={c.id} className={`cmt ${c.resolved ? 'is-resolved' : ''}`}>
          <header>
            <span className="cmt__author">{c.authorName}</span>
            <button type="button" className="cmt__page" onClick={() => onGo(pageIndexById.get(c.pageId)!)}>
              p.{pageIndexById.get(c.pageId)}
            </button>
          </header>
          <p>{c.body}</p>
          {c.resolved ? (
            <Pill tone="success" icon={<CheckIcon />}>
              Resolved
            </Pill>
          ) : null}
        </article>
      ))}

      {/* Orphaned commentary is surfaced, not silently dropped — see the
          retention note in the workspace header comment. */}
      {orphaned.length > 0 ? (
        <section className="cmtlist__orphans">
          <h4>
            <WarningIcon /> Orphaned by a page operation ({orphaned.length})
          </h4>
          <p className="ws__hint">
            These comments were anchored to pages that no longer exist in this
            version. They are retained for audit rather than deleted.
          </p>
          {orphaned.map((c) => (
            <article key={c.id} className="cmt cmt--orphan">
              <header>
                <span className="cmt__author">{c.authorName}</span>
                <span className="cmt__page">page removed</span>
              </header>
              <p>{c.body}</p>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------ VersionList */

function VersionList({
  entries,
  current,
}: {
  entries: { version: string; note: string }[]
  current?: string
}): React.JSX.Element {
  return (
    <ol className="versions">
      {entries
        .slice()
        .reverse()
        .map((e) => (
          <li key={e.version} className={e.version === current ? 'is-current' : ''}>
            <span className="versions__id">{e.version}</span>
            <span className="versions__note">{e.note}</span>
            {e.version === current ? <Pill tone="brand">current</Pill> : null}
          </li>
        ))}
    </ol>
  )
}

/* ---------------------------------------------------------- PageTextPanel */

/**
 * The accessible representation of the current page.
 *
 * A rasterised page is opaque to a screen reader — full stop. Rather than
 * pretend otherwise, the extracted/OCR'd text is presented as real, selectable,
 * announceable text beside the image. This panel, the outline, and the comment
 * list are the accessible path through the document; the canvas is not.
 */
function PageTextPanel({ docId, page }: { docId: string | null; page: number }): React.JSX.Element {
  const { data, isLoading } = usePageText(docId, page)

  return (
    <div className="textpanel">
      <h3 className="textpanel__head">
        Page {page} text
        <span className="textpanel__hint">accessible representation</span>
      </h3>

      {isLoading ? (
        <div className="textpanel__skel">
          <Skeleton height={10} />
          <Skeleton height={10} width="88%" />
          <Skeleton height={10} width="94%" />
          <Skeleton height={10} width="72%" />
        </div>
      ) : data?.available ? (
        <p className="textpanel__body">{data.text}</p>
      ) : (
        <div className="textpanel__none">
          <WarningIcon />
          <p>{data?.reason ?? 'No text layer available for this page.'}</p>
          <p className="ws__hint">
            Until OCR completes, this page is an image with no machine-readable
            content. Assistive technology cannot read it, and it will not appear
            in search results.
          </p>
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- dialogs */

function SplitDialog({
  open,
  pageCount,
  byteSize,
  onClose,
  onConfirm,
}: {
  open: boolean
  pageCount: number
  byteSize: number
  onClose: () => void
  onConfirm: (afterIndex: number) => void
}): React.JSX.Element {
  const [after, setAfter] = useState(Math.max(1, Math.floor(pageCount / 2)))

  useEffect(() => {
    if (open) setAfter(Math.max(1, Math.floor(pageCount / 2)))
  }, [open, pageCount])

  const clientSide = byteSize <= 25 * 1024 * 1024

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split document"
      width={520}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onConfirm(after)}>
            Split after page {after}
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Split after page</span>
        <input
          type="number"
          min={1}
          max={Math.max(1, pageCount - 1)}
          value={after}
          onChange={(e) => setAfter(Math.max(1, Math.min(pageCount - 1, Number(e.target.value))))}
        />
      </label>
      <p className="ws__hint">
        Pages 1–{after} are retained in this document; the remainder move to a new
        document. The operation publishes a <strong>new immutable version</strong>{' '}
        rather than mutating this one, so annotations and comments anchored to
        surviving pages are unaffected.
      </p>

      {/* The client-vs-server decision, made visible. */}
      <div className={`execnote ${clientSide ? 'is-client' : 'is-server'}`}>
        <strong>{clientSide ? 'Will run in a Web Worker' : 'Will run on the server'}</strong>
        <span>
          {clientSide
            ? `${formatBytes(byteSize)} is within the 25 MB client-side limit, so this runs locally in a worker — no upload, no round-trip.`
            : `${formatBytes(byteSize)} exceeds the 25 MB client-side limit. Structural edits need the whole file in memory, and the bytes already live server-side, so we send an instruction instead of a gigabyte.`}
        </span>
      </div>
    </Modal>
  )
}

function MergeDialog({
  open,
  target,
  candidates,
  onClose,
  onConfirm,
}: {
  open: boolean
  target: string
  candidates: { id: string; fileName: string; byteSize: number; pageCount: number }[]
  onClose: () => void
  onConfirm: (ids: string[], simulateFailure: boolean) => void
}): React.JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [simulateFailure, setSimulateFailure] = useState(false)

  useEffect(() => {
    if (open) {
      setPicked(new Set())
      setSimulateFailure(false)
    }
  }, [open])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge documents"
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={picked.size === 0}
            onClick={() => onConfirm([...picked], simulateFailure)}
          >
            Merge {picked.size} document{picked.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <p className="ws__hint">
        Selected documents are appended to <strong>{target}</strong>. The merge is
        atomic: either every input is appended and a new version is published, or
        nothing changes. A half-merged version is never visible to anyone.
      </p>

      {candidates.length === 0 ? (
        <p>No other documents on this claim to merge.</p>
      ) : (
        <ul className="mergelist">
          {candidates.map((c) => (
            <li key={c.id}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev)
                      if (next.has(c.id)) next.delete(c.id)
                      else next.add(c.id)
                      return next
                    })
                  }
                />
                <span className="mergelist__name">{c.fileName}</span>
                <span className="mergelist__meta">
                  {c.pageCount}pp · {formatBytes(c.byteSize)}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {/* Deliberate demo affordance for the partial-failure path the case study
          asks about. */}
      {picked.size > 0 ? (
        <label className="failsim">
          <input
            type="checkbox"
            checked={simulateFailure}
            onChange={(e) => setSimulateFailure(e.target.checked)}
          />
          <span>
            <strong>Simulate a partial failure</strong>
            <small>
              Makes the first selected input fail. Demonstrates that nothing is
              published, the failing input is named, and retry-excluding-it is
              offered.
            </small>
          </span>
        </label>
      ) : null}
    </Modal>
  )
}

/* -------------------------------------------------------------- skeletons */

/**
 * The skeleton deliberately mirrors the final layout — same rail, same sheet
 * proportions, same panel. A skeleton that doesn't match its result causes a
 * visible reflow on load, which reads as slower even when it isn't.
 */
function WorkspaceSkeleton({ claimId }: { claimId: string }): React.JSX.Element {
  return (
    <div className="ws" aria-busy="true">
      <header className="ws__head">
        <div className="ws__headleft">
          <Skeleton width={110} height={28} radius="var(--radius-control)" />
          <Skeleton width={220} height={14} />
        </div>
      </header>
      <div className="ws__banner">
        <Skeleton width={280} height={16} />
      </div>
      <div className="ws__body">
        <aside className="ws__side">
          <div className="rail-thumbs">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} width={108} height={150} radius="var(--radius-sm)" />
            ))}
          </div>
        </aside>
        <div className="ws__viewer">
          <div className="ws__pageskel">
            <Skeleton width={620} height={860} radius="var(--radius-sm)" />
          </div>
        </div>
        <aside className="ws__text">
          <Skeleton height={12} />
          <Skeleton height={10} width="86%" />
          <Skeleton height={10} width="92%" />
        </aside>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        Loading documents for claim {claimId}
      </div>
    </div>
  )
}

function DocGlyph(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path d="M8 4h8.5L22 9.5V24H8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M16.5 4v5.5H22" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}
