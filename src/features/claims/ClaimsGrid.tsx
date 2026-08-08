/**
 * THE CLAIMS WORKQUEUE GRID.
 *
 * Architecture in one paragraph: the server owns filtering, sorting, row-level
 * authorization and pagination. The client requests one page of ~100 rows and
 * virtualizes the rows *within* that page. Nothing in this component ever holds
 * 20,000 records, and nothing here decides who may do what.
 *
 * Why the hybrid (paged + virtualized) rather than pure infinite scroll:
 *   - An adjudication workqueue is audited. "I actioned the 12th claim on page 3"
 *     has to remain meaningful, and a shared URL has to show a colleague the
 *     same rows. Infinite scroll destroys both.
 *   - Memory is bounded by construction: leaving a page frees its rows. An
 *     infinite list that has accumulated 8,000 rows never gives that memory back.
 *   - Virtualization within the page still keeps the DOM at ~15 rows regardless
 *     of page size, so scrolling is 60fps and the a11y surface stays small
 *     enough to manage correctly.
 *
 * Accessibility is handled explicitly rather than assumed — see the aria-rowcount
 * / aria-rowindex handling and the roving-tabindex keyboard model below. A
 * virtualized grid is inaccessible by default; this one is not.
 */

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Claim, RecordPermissions } from '../../domain/types'
import { useGridState } from '../../app/useGridState'
import { Can, useSession } from '../../app/session'
import {
  prefetchClaimDocuments,
  useAdjusters,
  useAssignClaim,
  useClaimStats,
  useClaims,
  useDeleteClaim,
  type ApiError,
} from './api'
import {
  CHANNEL_LABEL,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  SLA_LABEL,
  SLA_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  formatApprox,
  formatBytes,
  formatCount,
  formatDate,
  formatMoney,
  slaDelta,
} from './format'
import {
  Button,
  Card,
  CheckIcon,
  ChevronIcon,
  ClockIcon,
  DotsIcon,
  Modal,
  Pill,
  SearchInput,
  Skeleton,
  StatTile,
  Tooltip,
  WarningIcon,
  type Toast,
  ToastStack,
} from '../../ui/primitives'
import './ClaimsGrid.scss'

/* -------------------------------------------------------------- column model */

interface Column {
  key: keyof Claim
  header: string
  width: number
  sortable: boolean
  align?: 'right'
  /** Hidden below this viewport width; the grid degrades rather than squashing. */
  minViewport?: number
}

/**
 * Column widths are fixed rather than fractional: the virtualizer needs stable
 * geometry, and a claims grid is scanned column-by-column, so jittering widths
 * between pages would hurt more than it helps.
 *
 * `minViewport` drops lower-value columns on narrower screens instead of
 * squashing every column or forcing a horizontal scrollbar. The thresholds are
 * chosen so the visible set always fits the content area at that width —
 * verified in the browser, not guessed.
 */
const COLUMNS: Column[] = [
  { key: 'claimNumber', header: 'Claim', width: 152, sortable: true },
  { key: 'claimantName', header: 'Claimant', width: 152, sortable: true },
  { key: 'cedent', header: 'Cedent', width: 150, sortable: true, minViewport: 1840 },
  { key: 'treaty', header: 'Treaty', width: 122, sortable: true, minViewport: 2080 },
  { key: 'status', header: 'Status', width: 110, sortable: true },
  { key: 'priority', header: 'Priority', width: 92, sortable: true },
  { key: 'slaState', header: 'SLA', width: 108, sortable: true },
  { key: 'incurredAmount', header: 'Incurred', width: 118, sortable: true, align: 'right' },
  { key: 'documentCount', header: 'Docs', width: 88, sortable: true, align: 'right' },
  { key: 'assigneeName', header: 'Assignee', width: 146, sortable: true },
  { key: 'receivedAt', header: 'Received', width: 104, sortable: true, minViewport: 1500 },
]

const ROW_HEIGHT = 44
const MOBILE_ROW_HEIGHT = 150

/* ------------------------------------------------------------------- screen */

export function ClaimsGrid(): React.JSX.Element {
  const { state, query, activeFilterCount, set, toggleFacet, toggleSort, clearFilters } =
    useGridState()
  const session = useSession()
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Local mirror of the search box so typing stays at 60fps. The URL (and
  // therefore the server query) updates on a debounce, not per keystroke.
  const [searchDraft, setSearchDraft] = useState(state.q)
  const deferredDraft = useDeferredValue(searchDraft)

  useEffect(() => {
    if (deferredDraft === state.q) return
    const t = window.setTimeout(() => set({ q: deferredDraft }), 280)
    return () => window.clearTimeout(t)
  }, [deferredDraft, state.q, set])

  // Keep the box in sync when the URL changes from elsewhere (back button,
  // pasted link, cleared filters).
  useEffect(() => {
    setSearchDraft(state.q)
  }, [state.q])

  const { data, isLoading, isFetching, isPlaceholderData, error, refetch } = useClaims(
    query,
    state.page,
  )
  const stats = useClaimStats()
  const adjusters = useAdjusters()

  const assign = useAssignClaim(query, state.page)
  const del = useDeleteClaim()

  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++toastId.current
    setToasts((prev) => [...prev, { ...t, id }])
    // Errors persist until dismissed; transient successes self-clear.
    if (t.tone !== 'error') {
      window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 4200)
    }
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const [confirmDelete, setConfirmDelete] = useState<Claim | null>(null)
  const [assignFor, setAssignFor] = useState<Claim | null>(null)

  const rows = data?.rows ?? []

  /* ------------------------------------------------------- virtualization */

  const viewportWidth = useViewportWidth()
  const isMobile = viewportWidth <= MOBILE_BREAKPOINT
  const visibleColumns = useVisibleColumns(viewportWidth)
  // Cards need more vertical room than a table row.
  const rowHeight = isMobile ? MOBILE_ROW_HEIGHT : ROW_HEIGHT

  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Fixed row height: no measurement pass, no layout thrash, no cumulative
    // drift. Variable heights would force measureElement on every row.
    estimateSize: () => rowHeight,
    // 8 rows of overscan. Enough that a fast flick doesn't reveal blank space,
    // small enough that the DOM stays tiny.
    overscan: 8,
    getItemKey: (index) => rows[index]?.id ?? index,
  })

  const virtualRows = virtualizer.getVirtualItems()

  // Re-measure when the row height changes (desktop table <-> mobile card).
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  /* ------------------------------------------- keyboard model (roving focus) */

  const [activeRow, setActiveRow] = useState(0)
  const gridRef = useRef<HTMLDivElement>(null)

  // Clamp the cursor when the result set shrinks under it.
  useEffect(() => {
    setActiveRow((r) => Math.min(r, Math.max(0, rows.length - 1)))
  }, [rows.length])

  /**
   * Move the logical cursor, scroll it into view, then move DOM focus.
   *
   * Order matters: the target row may not be rendered yet, so we scroll first,
   * let the virtualizer commit, and only then focus. Without this, arrowing
   * past the rendered window silently drops focus to <body> — the classic
   * virtualized-grid accessibility failure.
   */
  const moveTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, next))
      setActiveRow(clamped)
      virtualizer.scrollToIndex(clamped, { align: 'auto' })
      requestAnimationFrame(() => {
        const el = gridRef.current?.querySelector<HTMLElement>(`[data-rowindex="${clamped}"]`)
        el?.focus()
      })
    },
    [rows.length, virtualizer],
  )

  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const pageJump = Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          moveTo(activeRow + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          moveTo(activeRow - 1)
          break
        case 'PageDown':
          e.preventDefault()
          moveTo(activeRow + pageJump)
          break
        case 'PageUp':
          e.preventDefault()
          moveTo(activeRow - pageJump)
          break
        case 'Home':
          e.preventDefault()
          moveTo(0)
          break
        case 'End':
          e.preventDefault()
          moveTo(rows.length - 1)
          break
        case 'Enter': {
          e.preventDefault()
          const claim = rows[activeRow]
          if (claim) navigate(`/claims/${claim.id}`)
          break
        }
        // Paging from the keyboard, so a keyboard-only user never has to reach
        // for the pagination control at the bottom of the page.
        case 'ArrowRight':
          if (e.altKey && data?.nextCursor) {
            e.preventDefault()
            set({ page: state.page + 1 })
          }
          break
        case 'ArrowLeft':
          if (e.altKey && state.page > 1) {
            e.preventDefault()
            set({ page: state.page - 1 })
          }
          break
      }
    },
    [activeRow, rows, moveTo, navigate, data?.nextCursor, set, state.page],
  )

  /* --------------------------------------------------------------- actions */

  const onAssign = useCallback(
    (claim: Claim, assigneeId: string | null) => {
      setAssignFor(null)
      assign.mutate(
        { claimId: claim.id, assigneeId },
        {
          onError: (err) => {
            const e = err as ApiError
            pushToast({
              tone: 'error',
              message:
                e.status === 403
                  ? `Not permitted: ${e.message}`
                  : `Assignment failed: ${e.message}`,
              action: {
                label: 'Retry',
                onClick: () => onAssign(claim, assigneeId),
              },
            })
          },
          onSuccess: () => {
            pushToast({
              tone: 'success',
              message: assigneeId
                ? `${claim.claimNumber} assigned.`
                : `${claim.claimNumber} unassigned.`,
            })
          },
        },
      )
    },
    [assign, pushToast],
  )

  const onDelete = useCallback(
    (claim: Claim) => {
      del.mutate(claim.id, {
        onSuccess: () => {
          setConfirmDelete(null)
          pushToast({ tone: 'success', message: `${claim.claimNumber} deleted.` })
        },
        onError: (err) => {
          setConfirmDelete(null)
          pushToast({ tone: 'error', message: `Could not delete: ${(err as ApiError).message}` })
        },
      })
    },
    [del, pushToast],
  )

  /**
   * Row callbacks are useCallback'd with empty-ish deps so their identity is
   * stable across renders. This is what makes ClaimRow's memo actually work —
   * without it, every keystroke in the search box would re-render all ~15
   * mounted rows and the memo would be decoration.
   */
  const openClaim = useCallback(
    (claim: Claim) => {
      navigate(`/claims/${claim.id}`)
    },
    [navigate],
  )

  /**
   * Prefetch on intent. Hovering or focusing a row starts the document-list
   * request and warms the lazy workspace chunk, so the click has nothing left
   * to wait for.
   */
  const prefetch = useCallback(
    (claim: Claim) => {
      prefetchClaimDocuments(qc, claim.id)
      void import('../document/DocumentWorkspace')
    },
    [qc],
  )

  /* ----------------------------------------------------------------- render */

  const totalLabel = data ? formatApprox(data.approximateTotal, data.exact) : '—'

  return (
    <div className="grid-screen">
      <header className="grid-screen__head">
        <div>
          <h1 className="grid-screen__title">Claims Workqueue</h1>
          <p className="grid-screen__sub">
            {session.roleLabel} · {session.region} ·{' '}
            <span className="grid-screen__scope">
              {ROW_SCOPE_NOTE[session.role] ?? 'Scope determined server-side'}
            </span>
          </p>
        </div>
        <SearchInput
          label="Search claims"
          placeholder="Claim no., claimant, policy, cedent…"
          value={searchDraft}
          onChange={setSearchDraft}
          busy={isFetching && searchDraft !== state.q}
        />
      </header>

      {/* KPI tiles. Same component as the reference design, re-pointed at
          adjudication signals and made clickable so each one is a filter. */}
      <Card className="kpis" padded={false}>
        {stats.isLoading ? (
          <div className="kpis__loading">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="kpis__skel">
                <Skeleton width={52} height={52} radius="var(--radius-pill)" />
                <div className="kpis__skeltext">
                  <Skeleton width={70} height={10} />
                  <Skeleton width={48} height={18} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <StatTile
              label="Open claims"
              value={formatCount(stats.data?.openClaims ?? 0)}
              icon={<QueueGlyph />}
              tone="brand"
              hint="Claims not yet approved, denied or closed"
            />
            <StatTile
              label="SLA breached"
              value={formatCount(stats.data?.slaBreached ?? 0)}
              delta={{ direction: 'up', text: 'needs action', good: false }}
              icon={<WarningIcon />}
              tone="danger"
              active={state.slaState.includes('breached')}
              onClick={() => toggleFacet('slaState', 'breached')}
              hint="Filter to breached claims"
            />
            <StatTile
              label="At risk (<2 days)"
              value={formatCount(stats.data?.slaAtRisk ?? 0)}
              icon={<ClockIcon />}
              tone="warning"
              active={state.slaState.includes('at_risk')}
              onClick={() => toggleFacet('slaState', 'at_risk')}
              hint="Filter to claims approaching their SLA target"
            />
            <StatTile
              label="Unassigned"
              value={formatCount(stats.data?.unassigned ?? 0)}
              icon={<PersonGlyph />}
              tone="neutral"
              active={state.assignee === 'unassigned'}
              onClick={() =>
                set({ assignee: state.assignee === 'unassigned' ? 'any' : 'unassigned' })
              }
              hint="Filter to claims with no owner"
            />
            <StatTile
              label="Document volume"
              value={formatBytes(stats.data?.openDocumentBytes ?? 0)}
              icon={<DocGlyph />}
              tone="success"
              hint="Total bytes attached to open claims — capacity signal"
            />
          </>
        )}
      </Card>

      <Card className="gridcard" padded={false}>
        {/* Toolbar: facet filters, active-filter chips, page size. */}
        <div className="gridcard__toolbar">
          <div className="gridcard__toolbar-main">
            <h2 className="gridcard__title">
              All Claims
              <span className="gridcard__count">
                {totalLabel} {data?.exact ? 'matching' : 'matching (approx.)'}
              </span>
            </h2>

            <div className="facets">
              <FacetMenu
                label="Status"
                options={data?.facets.status ?? []}
                selected={state.status}
                onToggle={(v) => toggleFacet('status', v as never)}
              />
              <FacetMenu
                label="Priority"
                options={data?.facets.priority ?? []}
                selected={state.priority}
                onToggle={(v) => toggleFacet('priority', v as never)}
              />
              <FacetMenu
                label="Channel"
                options={data?.facets.channel ?? []}
                selected={state.channel}
                onToggle={(v) => toggleFacet('channel', v as never)}
              />
              <FacetMenu
                label="SLA"
                options={data?.facets.slaState ?? []}
                selected={state.slaState}
                onToggle={(v) => toggleFacet('slaState', v as never)}
              />

              <div className="segmented" role="group" aria-label="Assignment filter">
                {(['any', 'me', 'unassigned'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={state.assignee === v ? 'is-on' : ''}
                    aria-pressed={state.assignee === v}
                    onClick={() => set({ assignee: v })}
                  >
                    {v === 'any' ? 'All' : v === 'me' ? 'Mine' : 'Unassigned'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="gridcard__toolbar-side">
            {data ? (
              <span className="gridcard__took" title="Server processing time for this query">
                {data.tookMs} ms server
              </span>
            ) : null}
            <label className="pagesize">
              <span className="sr-only">Rows per page</span>
              <select
                value={state.pageSize}
                onChange={(e) => set({ pageSize: Number(e.target.value) })}
              >
                {[50, 100, 200, 500].map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Active filter chips reflect URL state — the URL is the truth, these
            are a view of it. */}
        {activeFilterCount > 0 ? (
          <div className="chips">
            {state.q ? (
              <Chip label={`Search: "${state.q}"`} onRemove={() => set({ q: '' })} />
            ) : null}
            {state.status.map((s) => (
              <Chip
                key={s}
                label={`Status: ${STATUS_LABEL[s]}`}
                onRemove={() => toggleFacet('status', s)}
              />
            ))}
            {state.priority.map((p) => (
              <Chip
                key={p}
                label={`Priority: ${PRIORITY_LABEL[p]}`}
                onRemove={() => toggleFacet('priority', p)}
              />
            ))}
            {state.channel.map((c) => (
              <Chip
                key={c}
                label={`Channel: ${CHANNEL_LABEL[c]}`}
                onRemove={() => toggleFacet('channel', c)}
              />
            ))}
            {state.slaState.map((s) => (
              <Chip
                key={s}
                label={`SLA: ${SLA_LABEL[s]}`}
                onRemove={() => toggleFacet('slaState', s)}
              />
            ))}
            {state.assignee !== 'any' ? (
              <Chip
                label={state.assignee === 'me' ? 'Assigned to me' : 'Unassigned'}
                onRemove={() => set({ assignee: 'any' })}
              />
            ) : null}
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear all
            </Button>
          </div>
        ) : null}

        {/* ------------------------------------------------------- the grid */}

        {error ? (
          <ErrorState error={error as ApiError} onRetry={() => void refetch()} />
        ) : isLoading ? (
          <GridSkeleton columns={visibleColumns} />
        ) : rows.length === 0 ? (
          <EmptyState hasFilters={activeFilterCount > 0} onClear={clearFilters} />
        ) : (
          <div
            className={`vgrid ${isPlaceholderData ? 'is-stale' : ''}`}
            ref={gridRef}
            role="grid"
            aria-label="Claims"
            /**
             * aria-rowcount is the FULL logical count (+1 for the header row),
             * not the number of DOM nodes. Screen readers announce "row 7 of
             * 20,000" correctly even though only ~15 rows exist in the DOM.
             *
             * When the total is approximate we still publish it rather than the
             * spec's -1 ("unknown"). A screen reader announcing "row 7 of about
             * 6,700" is materially more useful than "row 7", and the live region
             * below states explicitly that the figure is approximate.
             */
            aria-rowcount={data ? data.approximateTotal + 1 : -1}
            aria-colcount={visibleColumns.length + 1}
            aria-busy={isFetching || undefined}
            onKeyDown={onGridKeyDown}
          >
            <div className="vgrid__head" role="row" aria-rowindex={1} hidden={isMobile}>
              {visibleColumns.map((col, ci) => {
                const sorted = state.sortField === col.key
                return (
                  <div
                    key={col.key}
                    role="columnheader"
                    aria-colindex={ci + 1}
                    aria-sort={
                      sorted ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none'
                    }
                    className={`vgrid__th ${col.align === 'right' ? 'is-right' : ''}`}
                    style={{ width: col.width, flex: `0 0 ${col.width}px` }}
                  >
                    {col.sortable ? (
                      <button
                        type="button"
                        className={`vgrid__sort ${sorted ? 'is-active' : ''}`}
                        onClick={() => toggleSort(col.key)}
                      >
                        {col.header}
                        <span className="vgrid__sorticon" aria-hidden="true">
                          {sorted ? <ChevronIcon dir={state.sortDir === 'asc' ? 'up' : 'down'} /> : null}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </div>
                )
              })}
              <div
                role="columnheader"
                aria-colindex={visibleColumns.length + 1}
                className="vgrid__th vgrid__th--actions"
              >
                Actions
              </div>
            </div>

            <div className="vgrid__scroll" ref={scrollRef}>
              <div className="vgrid__sizer" style={{ height: virtualizer.getTotalSize() }}>
                {virtualRows.map((v) => {
                  const claim = rows[v.index]
                  if (!claim) return null
                  return (
                    <ClaimRow
                      key={claim.id}
                      claim={claim}
                      columns={visibleColumns}
                      isMobile={isMobile}
                      rowHeight={rowHeight}
                      /* aria-rowindex is the row's position in the FULL set, so
                         the header is 1 and data rows start at 2, offset by the
                         current page. */
                      ariaRowIndex={(state.page - 1) * state.pageSize + v.index + 2}
                      rowIndex={v.index}
                      isActive={activeRow === v.index}
                      /* transform, not top: keeps the row on the compositor and
                         avoids a layout pass per scroll frame. */
                      translateY={v.start}
                      onFocusRow={setActiveRow}
                      onOpen={openClaim}
                      onPrefetch={prefetch}
                      onRequestAssign={setAssignFor}
                      onRequestDelete={setConfirmDelete}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* Pagination. Keeps the reference design's familiar numbered affordance,
            backed by cursors, with an approximate total. */}
        <Pagination
          page={state.page}
          pageCount={data?.pageCount ?? 1}
          hasNext={Boolean(data?.nextCursor)}
          hasPrev={state.page > 1}
          rangeStart={rows.length ? (state.page - 1) * state.pageSize + 1 : 0}
          rangeEnd={(state.page - 1) * state.pageSize + rows.length}
          total={totalLabel}
          exact={data?.exact ?? false}
          busy={isFetching}
          onPage={(p) => set({ page: p })}
        />
      </Card>

      {/* Live region: announces result-set changes to screen readers without
          stealing focus. Politeness is "polite" because filtering is
          user-initiated and not urgent. */}
      <div className="sr-only" role="status" aria-live="polite">
        {isFetching
          ? 'Loading claims'
          : data
            ? `${formatApprox(data.approximateTotal, data.exact)} claims match. Showing page ${data.page} of ${data.pageCount}.`
            : ''}
      </div>

      {/* --------------------------------------------------------- dialogs */}

      <Modal
        open={Boolean(assignFor)}
        onClose={() => setAssignFor(null)}
        title={`Assign ${assignFor?.claimNumber ?? ''}`}
        width={420}
      >
        <p className="dialog__lead">
          Assignment applies immediately and is reversible, so the change is shown
          optimistically and rolled back if the server rejects it.
        </p>
        <ul className="assignlist">
          <li>
            <button type="button" onClick={() => assignFor && onAssign(assignFor, null)}>
              <span className="assignlist__avatar assignlist__avatar--none" aria-hidden="true">
                —
              </span>
              Unassign
            </button>
          </li>
          {adjusters.data?.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => assignFor && onAssign(assignFor, a.id)}
                aria-current={assignFor?.assigneeId === a.id}
              >
                <span className="assignlist__avatar" aria-hidden="true">
                  {a.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')}
                </span>
                {a.name}
                {assignFor?.assigneeId === a.id ? (
                  <span className="assignlist__current">
                    <CheckIcon /> current
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Delete claim?"
        width={440}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => confirmDelete && onDelete(confirmDelete)}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        <p>
          <strong>{confirmDelete?.claimNumber}</strong> — {confirmDelete?.claimantName}
        </p>
        <p className="dialog__warn">
          This cannot be undone. Deletion is confirmed and applied pessimistically:
          the row is removed only after the server acknowledges it.
        </p>
      </Modal>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

const ROW_SCOPE_NOTE: Record<string, string> = {
  intake_clerk: 'Server restricts rows to inbound intake channels',
  claims_adjuster: 'Server restricts rows to your region',
  senior_adjuster: 'Server restricts rows to your region',
  supervisor: 'Full portfolio visibility',
  auditor: 'Full portfolio, read-only',
}

/* ---------------------------------------------------------------- ClaimRow */

interface ClaimRowProps {
  claim: Claim
  columns: Column[]
  isMobile: boolean
  rowHeight: number
  ariaRowIndex: number
  rowIndex: number
  isActive: boolean
  translateY: number
  onFocusRow: (i: number) => void
  onOpen: (c: Claim) => void
  onPrefetch: (c: Claim) => void
  onRequestAssign: (c: Claim) => void
  onRequestDelete: (c: Claim) => void
}

/**
 * Memoized row.
 *
 * Every prop is either a primitive or a stable identity (all callbacks are
 * useCallback'd or defined once in the parent's closure). That's what makes the
 * memo actually effective — passing an inline arrow here would defeat it and
 * re-render all ~15 rows on every parent state change, including each keystroke
 * in the search box.
 */
const ClaimRow = memo(function ClaimRow({
  claim,
  columns,
  isMobile,
  rowHeight,
  ariaRowIndex,
  rowIndex,
  isActive,
  translateY,
  onFocusRow,
  onOpen,
  onPrefetch,
  onRequestAssign,
  onRequestDelete,
}: ClaimRowProps): React.JSX.Element {
  return (
    <div
      role="row"
      aria-rowindex={ariaRowIndex}
      data-rowindex={rowIndex}
      className={`vgrid__row ${isActive ? 'is-active' : ''} ${isMobile ? 'vgrid__row--card' : ''}`}
      style={{ transform: `translateY(${translateY}px)`, height: rowHeight }}
      /* Roving tabindex: exactly one row is tabbable, so Tab moves past the
         grid rather than through 100 rows, while arrows navigate within it. */
      tabIndex={isActive ? 0 : -1}
      onFocus={() => onFocusRow(rowIndex)}
      onMouseEnter={() => onPrefetch(claim)}
      onDoubleClick={() => onOpen(claim)}
    >
      {isMobile ? (
        <ClaimCardBody
          claim={claim}
          onOpen={onOpen}
          onRequestAssign={onRequestAssign}
          onRequestDelete={onRequestDelete}
        />
      ) : (
        <>
          {columns.map((col, ci) => (
            <div
              key={col.key}
              role="gridcell"
              aria-colindex={ci + 1}
              className={`vgrid__td ${col.align === 'right' ? 'is-right' : ''}`}
              style={{ width: col.width, flex: `0 0 ${col.width}px` }}
            >
              <Cell claim={claim} col={col} onOpen={onOpen} />
            </div>
          ))}

          <div
            role="gridcell"
            aria-colindex={columns.length + 1}
            className="vgrid__td vgrid__td--actions"
          >
            <RowActions
              claim={claim}
              onOpen={onOpen}
              onRequestAssign={onRequestAssign}
              onRequestDelete={onRequestDelete}
            />
          </div>
        </>
      )}
    </div>
  )
})

/* --------------------------------------------------------- ClaimCardBody */

/**
 * Mobile card layout for a single claim. Shows the fields that matter for
 * triage — claim number, claimant, status, priority, SLA, assignee — with the
 * same actions menu as the desktop row.
 */
function ClaimCardBody({
  claim,
  onOpen,
  onRequestAssign,
  onRequestDelete,
}: {
  claim: Claim
  onOpen: (c: Claim) => void
  onRequestAssign: (c: Claim) => void
  onRequestDelete: (c: Claim) => void
}): React.JSX.Element {
  const delta = slaDelta(claim.dueAt)
  return (
    <div className="claimcard" role="gridcell" aria-colindex={1}>
      <div className="claimcard__top">
        <button type="button" className="celllink" onClick={() => onOpen(claim)}>
          {claim.claimNumber}
        </button>
        <RowActions
          claim={claim}
          onOpen={onOpen}
          onRequestAssign={onRequestAssign}
          onRequestDelete={onRequestDelete}
        />
      </div>

      <div className="claimcard__claimant">{claim.claimantName}</div>

      <div className="claimcard__pills">
        <Pill tone={STATUS_TONE[claim.status]}>{STATUS_LABEL[claim.status]}</Pill>
        <Pill
          tone={PRIORITY_TONE[claim.priority]}
          icon={claim.priority === 'critical' ? <WarningIcon /> : undefined}
        >
          {PRIORITY_LABEL[claim.priority]}
        </Pill>
        <Pill
          tone={SLA_TONE[claim.slaState]}
          icon={
            claim.slaState === 'breached' ? (
              <WarningIcon />
            ) : claim.slaState === 'at_risk' ? (
              <ClockIcon />
            ) : (
              <CheckIcon />
            )
          }
          title={`Due ${formatDate(claim.dueAt)} — ${delta.text}`}
        >
          {SLA_LABEL[claim.slaState]}
        </Pill>
      </div>

      <div className="claimcard__meta">
        <span>{claim.cedent}</span>
        <span aria-hidden="true">·</span>
        <span className="num">{formatMoney(claim.incurredAmount, claim.currency)}</span>
        <span aria-hidden="true">·</span>
        <span>
          {claim.assigneeName ? shortenName(claim.assigneeName) : 'Unassigned'}
        </span>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- Cell */

function Cell({
  claim,
  col,
  onOpen,
}: {
  claim: Claim
  col: Column
  onOpen: (c: Claim) => void
}): React.JSX.Element {
  switch (col.key) {
    case 'claimNumber':
      return (
        <button type="button" className="celllink" onClick={() => onOpen(claim)}>
          {claim.claimNumber}
        </button>
      )

    case 'status':
      return <Pill tone={STATUS_TONE[claim.status]}>{STATUS_LABEL[claim.status]}</Pill>

    case 'priority':
      return (
        <Pill
          tone={PRIORITY_TONE[claim.priority]}
          icon={claim.priority === 'critical' ? <WarningIcon /> : undefined}
        >
          {PRIORITY_LABEL[claim.priority]}
        </Pill>
      )

    case 'slaState': {
      const delta = slaDelta(claim.dueAt)
      return (
        <Pill
          tone={SLA_TONE[claim.slaState]}
          icon={
            claim.slaState === 'breached' ? (
              <WarningIcon />
            ) : claim.slaState === 'at_risk' ? (
              <ClockIcon />
            ) : (
              <CheckIcon />
            )
          }
          title={`Due ${formatDate(claim.dueAt)} — ${delta.text}`}
        >
          {SLA_LABEL[claim.slaState]}
        </Pill>
      )
    }

    case 'incurredAmount':
      return <span className="num">{formatMoney(claim.incurredAmount, claim.currency)}</span>

    case 'documentCount':
      return (
        <span className="docs" title={`${formatBytes(claim.documentBytes)} total`}>
          <span className="num">{claim.documentCount}</span>
          <small>{formatBytes(claim.documentBytes)}</small>
        </span>
      )

    case 'assigneeName':
      return claim.assigneeName ? (
        // Surname-initial form ("Henrik S.") keeps the column narrow while
        // staying unambiguous within a team; the full name is in the title.
        <span className="assignee" title={claim.assigneeName}>
          <span className="assignee__avatar" aria-hidden="true">
            {claim.assigneeName
              .split(' ')
              .map((n) => n[0])
              .join('')}
          </span>
          <span className="assignee__name">{shortenName(claim.assigneeName)}</span>
        </span>
      ) : (
        <span className="muted">Unassigned</span>
      )

    case 'receivedAt':
      return <span className="muted">{formatDate(claim.receivedAt)}</span>

    default: {
      const v = claim[col.key]
      return <span className="ellipsis">{v === null ? '—' : String(v)}</span>
    }
  }
}

/* -------------------------------------------------------------- RowActions */

/**
 * Row actions gated by server-supplied per-record permissions.
 *
 * Note what this component does NOT do: it never checks the user's role, never
 * compares ids, never encodes a rule. It reads decisions. That's the whole
 * discipline — policy in one place (the server), presentation here.
 */
function RowActions({
  claim,
  onOpen,
  onRequestAssign,
  onRequestDelete,
}: {
  claim: Claim
  onOpen: (c: Claim) => void
  onRequestAssign: (c: Claim) => void
  onRequestDelete: (c: Claim) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const perms: RecordPermissions = claim.permissions

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="rowactions" ref={ref}>
      <Can perms={perms} capability="claim:edit">
        {({ disabled }) => (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onOpen(claim)}
            aria-label={`Edit ${claim.claimNumber}`}
          >
            Edit
          </Button>
        )}
      </Can>

      <Can perms={perms} capability="claim:assign">
        {({ disabled }) => (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onRequestAssign(claim)}
            aria-label={`Assign ${claim.claimNumber}`}
          >
            Assign
          </Button>
        )}
      </Can>

      <Can perms={perms} capability="claim:delete">
        {({ disabled }) => (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            disabled={disabled}
            onClick={() => onRequestDelete(claim)}
            aria-label={`Delete ${claim.claimNumber}`}
          >
            <TrashIcon />
          </Button>
        )}
      </Can>

      <Button
        size="sm"
        variant="ghost"
        iconOnly
        onClick={() => setOpen(!open)}
        aria-label={`More actions for ${claim.claimNumber}`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <DotsIcon />
      </Button>

      {open ? (
        <div className="rowmenu" role="menu">
          <button role="menuitem" onClick={() => onOpen(claim)}>
            Open documents ({claim.documentCount})
          </button>
          <Can perms={perms} capability="claim:export">
            {({ disabled }) => (
              <button role="menuitem" disabled={disabled} onClick={() => setOpen(false)}>
                Export claim file
              </button>
            )}
          </Can>
          <button role="menuitem" onClick={() => setOpen(false)}>
            Copy claim number
          </button>
          <div className="rowmenu__meta">
            {claim.region} · {claim.lineOfBusiness}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- FacetMenu */

function FacetMenu({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: { value: string; label: string; count: number }[]
  selected: string[]
  onToggle: (v: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="facet" ref={ref}>
      <button
        type="button"
        className={`facet__btn ${selected.length ? 'is-on' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {label}
        {selected.length ? <span className="facet__badge">{selected.length}</span> : null}
        <ChevronIcon />
      </button>

      {open ? (
        <div className="facet__menu">
          {options.map((o) => (
            <label key={o.value} className={o.count === 0 ? 'is-empty' : ''}>
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => onToggle(o.value)}
              />
              <span className="facet__label">{o.label}</span>
              {/* Facet counts come from the server over the whole filtered set,
                  not from the current page. */}
              <span className="facet__count">{formatCount(o.count)}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- Pagination */

function Pagination({
  page,
  pageCount,
  hasNext,
  hasPrev,
  rangeStart,
  rangeEnd,
  total,
  exact,
  busy,
  onPage,
}: {
  page: number
  pageCount: number
  hasNext: boolean
  hasPrev: boolean
  rangeStart: number
  rangeEnd: number
  total: string
  exact: boolean
  busy: boolean
  onPage: (p: number) => void
}): React.JSX.Element {
  const pages = useMemo(() => windowedPages(page, pageCount), [page, pageCount])

  return (
    <div className="pager">
      <span className="pager__summary">
        Showing {formatCount(rangeStart)}–{formatCount(rangeEnd)} of {total}
        {!exact ? (
          <Tooltip content="An exact COUNT over a large filtered set is expensive to compute on every query. The API returns an approximate total instead and an exact one only below 2,000 matches.">
            <span className="pager__approx" tabIndex={0}>
              approx.
            </span>
          </Tooltip>
        ) : null}
        {busy ? <span className="pager__busy" aria-hidden="true" /> : null}
      </span>

      <nav className="pager__nav" aria-label="Pagination">
        <Button size="sm" iconOnly disabled={!hasPrev} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronIcon dir="left" />
        </Button>

        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`gap-${i}`} className="pager__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className={`pager__page ${p === page ? 'is-current' : ''}`}
              aria-current={p === page ? 'page' : undefined}
              onClick={() => onPage(p)}
            >
              {p}
            </button>
          ),
        )}

        <Button size="sm" iconOnly disabled={!hasNext} onClick={() => onPage(page + 1)} aria-label="Next page">
          <ChevronIcon dir="right" />
        </Button>
      </nav>
    </div>
  )
}

/** Truncated page window, matching the reference design's `1 2 3 4 … 40`. */
function windowedPages(page: number, pageCount: number): (number | '…')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1)
  const out: (number | '…')[] = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(pageCount - 1, page + 1)
  if (start > 2) out.push('…')
  for (let p = start; p <= end; p++) out.push(p)
  if (end < pageCount - 1) out.push('…')
  out.push(pageCount)
  return out
}

/* ------------------------------------------------------------------ states */

function GridSkeleton({ columns }: { columns: Column[] }): React.JSX.Element {
  return (
    <div className="vgrid vgrid--skeleton" aria-hidden="true">
      <div className="vgrid__head">
        {columns.map((c) => (
          <div key={c.key} className="vgrid__th" style={{ flex: `0 0 ${c.width}px` }}>
            {c.header}
          </div>
        ))}
        <div className="vgrid__th vgrid__th--actions">Actions</div>
      </div>
      <div className="vgrid__scroll">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="vgrid__row" style={{ height: ROW_HEIGHT }}>
            {columns.map((c) => (
              <div key={c.key} className="vgrid__td" style={{ flex: `0 0 ${c.width}px` }}>
                <Skeleton width={`${55 + ((i * 13 + c.width) % 35)}%`} height={10} />
              </div>
            ))}
            <div className="vgrid__td vgrid__td--actions">
              <Skeleton width={80} height={10} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyState({
  hasFilters,
  onClear,
}: {
  hasFilters: boolean
  onClear: () => void
}): React.JSX.Element {
  return (
    <div className="state">
      <div className="state__glyph" aria-hidden="true">
        <SearchGlyph />
      </div>
      <h3>No claims match</h3>
      <p>
        {hasFilters
          ? 'No claims in your visible scope match these filters. Row-level visibility is applied server-side before filtering, so some claims may exist outside your scope.'
          : 'There are no claims in your visible scope.'}
      </p>
      {hasFilters ? (
        <Button variant="primary" onClick={onClear}>
          Clear all filters
        </Button>
      ) : null}
    </div>
  )
}

function ErrorState({
  error,
  onRetry,
}: {
  error: ApiError
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="state state--error" role="alert">
      <div className="state__glyph state__glyph--error" aria-hidden="true">
        <WarningIcon />
      </div>
      <h3>Could not load claims</h3>
      <p>{error.message}</p>
      {/* Retry is offered only when the failure is actually retryable — a 403
          will fail identically forever and offering Retry is a lie. */}
      {error.retryable !== false ? (
        <Button variant="primary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

/* ----------------------------------------------------------------- helpers */

/** "Henrik Solberg" → "Henrik S." Fits a narrow column without an ellipsis. */
function shortenName(full: string): string {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2) return full
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }): React.JSX.Element {
  return (
    <span className="chip">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter ${label}`}>
        ×
      </button>
    </span>
  )
}

/**
 * Responsive column set.
 *
 * Columns drop out below breakpoints instead of the grid growing a horizontal
 * scrollbar. Uses a resize listener rather than CSS because the virtualizer
 * needs the real widths to compute layout.
 */
/** Tracks the viewport width once, shared by the column set and mobile switch. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1600 : window.innerWidth,
  )

  useEffect(() => {
    let frame = 0
    const onResize = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setWidth(window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(frame)
    }
  }, [])

  return width
}

/** Below this width the grid renders each claim as a stacked card, not a row. */
const MOBILE_BREAKPOINT = 700

function useVisibleColumns(width: number): Column[] {
  return useMemo(
    () => COLUMNS.filter((c) => !c.minViewport || width >= c.minViewport),
    [width],
  )
}

/* ------------------------------------------------------------------ glyphs */

function QueueGlyph(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 8.5h16M7.5 8.5V18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function PersonGlyph(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <circle cx="11" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 18.5c1.4-3 3.8-4.5 6.5-4.5s5.1 1.5 6.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function DocGlyph(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M6 3h6.5L17 7.5V19H6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12.5 3v4.5H17" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function SearchGlyph(): React.JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M17.5 17.5L24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 4h9M5.5 4V2.8h3V4M4 4l.6 7.2h4.8L10 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
