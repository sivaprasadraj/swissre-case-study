/**
 * SERVER-SIDE QUERY ENGINE.
 *
 * This is the piece that makes the mock architecturally faithful. It performs
 * filtering, sorting, faceting and keyset pagination the way a SQL backend
 * would — the client receives one page of rows and never sees the other 19,900.
 *
 * If this logic lived in the browser (fetch 20k rows, then `array.sort()`), the
 * component code would look almost identical but the architecture would be
 * wrong, and it would fall over at 200k records. Swapping this module for a
 * real BFF changes no component code.
 *
 * Order of operations matters and mirrors production:
 *   1. RBAC row visibility   (never paginate before authorizing)
 *   2. Filters
 *   3. Facet counts          (computed on the filtered-but-unpaginated set)
 *   4. Sort  (+ stable tie-breaker on id, required for keyset correctness)
 *   5. Keyset slice
 *   6. Per-record policy decisions attached to the returned page only
 */

import type {
  Claim,
  ClaimQuery,
  ClaimQueryResult,
  Facet,
  Session,
  SortDirection,
} from '../domain/types'
import { getDataset, CHANNEL_LABELS, PRIORITY_LABELS, SLA_LABELS, STATUS_LABELS } from './dataset'
import { decideForClaim, rowVisibilityPredicate } from './policy'

/* ------------------------------------------------------------------ cursor */

/**
 * Opaque keyset cursor. Encodes the sort key of the boundary row plus its id as
 * a tie-breaker, so paging is stable even when the sort field has duplicates.
 *
 * This is what avoids `OFFSET 19900` — we resume from a value, not a count.
 */
interface Cursor {
  /** Sort field value of the boundary row, as a comparable primitive. */
  v: string | number
  /** Boundary row id — the tie-breaker. */
  id: string
  /** Direction of travel, so we know whether to look forward or backward. */
  dir: 'next' | 'prev'
  /** Page number carried along purely to render the paging affordance. */
  page: number
}

export function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/=+$/, '')
}

export function decodeCursor(s: string): Cursor | null {
  try {
    return JSON.parse(atob(s)) as Cursor
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ compare */

function sortValue(claim: Claim, field: keyof Claim): string | number {
  const v = claim[field]
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return v
  if (typeof v === 'string') return v
  return String(v)
}

function compare(
  a: Claim,
  b: Claim,
  field: keyof Claim,
  dir: SortDirection,
): number {
  const av = sortValue(a, field)
  const bv = sortValue(b, field)
  let r: number
  if (typeof av === 'number' && typeof bv === 'number') {
    r = av - bv
  } else {
    r = String(av).localeCompare(String(bv), 'en', { numeric: true })
  }
  // Stable tie-breaker. Without this, keyset pagination can skip or repeat rows.
  if (r === 0) r = a.id.localeCompare(b.id)
  return dir === 'asc' ? r : -r
}

/* ------------------------------------------------------------------ filters */

function matchesFilters(claim: Claim, q: ClaimQuery, session: Session): boolean {
  if (q.status?.length && !q.status.includes(claim.status)) return false
  if (q.channel?.length && !q.channel.includes(claim.channel)) return false
  if (q.priority?.length && !q.priority.includes(claim.priority)) return false
  if (q.slaState?.length && !q.slaState.includes(claim.slaState)) return false

  if (q.assignee === 'me' && claim.assigneeId !== session.userId) return false
  if (q.assignee === 'unassigned' && claim.assigneeId !== null) return false

  if (q.q) {
    // Stands in for a search-index lookup (Elasticsearch/OpenSearch). In
    // production this is a separate hop, not a substring scan.
    const needle = q.q.toLowerCase()
    const haystack = `${claim.claimNumber} ${claim.claimantName} ${claim.policyNumber} ${claim.cedent} ${claim.treaty} ${claim.assigneeName ?? ''}`
    if (!haystack.toLowerCase().includes(needle)) return false
  }
  return true
}

/** Facets are computed ignoring the facet's own dimension, so counts stay useful
 *  while that filter is active (the standard faceted-search behaviour). */
function buildFacets(
  visible: Claim[],
  q: ClaimQuery,
  session: Session,
): ClaimQueryResult['facets'] {
  const count = <K extends keyof Claim>(
    field: K,
    omit: keyof ClaimQuery,
  ): Map<string, number> => {
    const partial = { ...q, [omit]: undefined } as ClaimQuery
    const m = new Map<string, number>()
    for (const c of visible) {
      if (!matchesFilters(c, partial, session)) continue
      const key = String(c[field])
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  }

  const toFacets = <T extends string>(
    m: Map<string, number>,
    labels: Record<T, string>,
  ): Facet<T>[] =>
    (Object.keys(labels) as T[]).map((value) => ({
      value,
      label: labels[value],
      count: m.get(value) ?? 0,
    }))

  return {
    status: toFacets(count('status', 'status'), STATUS_LABELS),
    channel: toFacets(count('channel', 'channel'), CHANNEL_LABELS),
    priority: toFacets(count('priority', 'priority'), PRIORITY_LABELS),
    slaState: toFacets(count('slaState', 'slaState'), SLA_LABELS),
  }
}

/* -------------------------------------------------------------------- query */

/**
 * Above this many matches we stop reporting an exact total and report an
 * approximate one instead. Mirrors the production reality that `COUNT(*)` over
 * a large filtered set is too expensive to run on every keystroke.
 */
const EXACT_COUNT_CEILING = 2_000

export function queryClaims(
  session: Session,
  q: ClaimQuery,
): ClaimQueryResult {
  const t0 = performance.now()
  const all = getDataset()

  // 1. RBAC row visibility FIRST. Authorize, then paginate — never the reverse.
  const canSee = rowVisibilityPredicate(session)

  // 2. Filters
  const matched: Claim[] = []
  for (const c of all) {
    if (!canSee(c)) continue
    if (!matchesFilters(c, q, session)) continue
    matched.push(c)
  }

  // 3. Facets over the filtered-but-unpaginated set
  const visibleForFacets = all.filter(canSee)
  const facets = buildFacets(visibleForFacets, q, session)

  // 4. Sort with stable tie-breaker
  matched.sort((a, b) => compare(a, b, q.sort.field, q.sort.direction))

  // 5. Keyset slice
  const cursor = q.cursor ? decodeCursor(q.cursor) : null
  let startIndex = 0
  let page = 1

  if (cursor) {
    // Resume from the boundary row rather than counting off an offset.
    const boundary = matched.findIndex((c) => c.id === cursor.id)
    if (boundary >= 0) {
      startIndex = cursor.dir === 'next' ? boundary + 1 : Math.max(0, boundary - q.limit)
      page = cursor.page
    } else {
      // The boundary row no longer matches (someone else changed it, or a filter
      // moved underneath us). Degrade to the first page rather than guessing.
      startIndex = 0
      page = 1
    }
  }

  const rows = matched.slice(startIndex, startIndex + q.limit)
  const first = rows[0]
  const last = rows[rows.length - 1]

  const hasNext = startIndex + q.limit < matched.length
  const hasPrev = startIndex > 0

  const total = matched.length
  const exact = total <= EXACT_COUNT_CEILING
  // Rounded down to 2 significant figures — honest imprecision beats a fake
  // exact number. The UI renders "~12,000" for this.
  const approximateTotal = exact
    ? total
    : Math.floor(total / 10 ** (String(total).length - 2)) *
      10 ** (String(total).length - 2)

  // 6. Attach per-record authorization to the RETURNED PAGE ONLY.
  //    Evaluating policy for all 20k rows would be wasted work.
  const withPerms = rows.map((c) => ({
    ...c,
    permissions: decideForClaim(session, c),
  }))

  return {
    rows: withPerms,
    nextCursor:
      hasNext && last
        ? encodeCursor({
            v: sortValue(last, q.sort.field),
            id: last.id,
            dir: 'next',
            page: page + 1,
          })
        : null,
    prevCursor:
      hasPrev && first
        ? encodeCursor({
            v: sortValue(first, q.sort.field),
            id: first.id,
            dir: 'prev',
            page: Math.max(1, page - 1),
          })
        : null,
    approximateTotal,
    exact,
    page,
    pageCount: Math.max(1, Math.ceil(total / q.limit)),
    facets,
    tookMs: Math.round((performance.now() - t0) * 10) / 10,
  }
}

/**
 * Offset-based jump, used ONLY by the numbered page buttons.
 *
 * Kept deliberately separate from the cursor path so the cost is visible: this
 * is the expensive access pattern the design doc argues against, retained
 * because an adjudication workqueue genuinely benefits from "jump to page 12".
 */
export function queryClaimsByPage(
  session: Session,
  q: ClaimQuery,
  page: number,
): ClaimQueryResult {
  const base = queryClaims(session, { ...q, cursor: undefined })
  const all = getDataset()
  const canSee = rowVisibilityPredicate(session)
  const matched = all
    .filter((c) => canSee(c) && matchesFilters(c, q, session))
    .sort((a, b) => compare(a, b, q.sort.field, q.sort.direction))

  const safePage = Math.min(Math.max(1, page), Math.max(1, Math.ceil(matched.length / q.limit)))
  const startIndex = (safePage - 1) * q.limit
  const rows = matched.slice(startIndex, startIndex + q.limit)
  const first = rows[0]
  const last = rows[rows.length - 1]

  return {
    ...base,
    rows: rows.map((c) => ({ ...c, permissions: decideForClaim(session, c) })),
    page: safePage,
    nextCursor:
      startIndex + q.limit < matched.length && last
        ? encodeCursor({
            v: sortValue(last, q.sort.field),
            id: last.id,
            dir: 'next',
            page: safePage + 1,
          })
        : null,
    prevCursor:
      startIndex > 0 && first
        ? encodeCursor({
            v: sortValue(first, q.sort.field),
            id: first.id,
            dir: 'prev',
            page: Math.max(1, safePage - 1),
          })
        : null,
  }
}
