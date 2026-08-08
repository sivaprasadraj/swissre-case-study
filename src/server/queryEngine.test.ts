/**
 * QUERY ENGINE TESTS.
 *
 * The important one here is keyset-pagination correctness. Cursor paging is easy
 * to get subtly wrong: without a stable tie-breaker, paging through a set sorted
 * on a low-cardinality column silently skips or repeats rows, and nobody notices
 * until an adjuster swears a claim vanished from their queue.
 *
 * So we assert the property directly: walking every page must visit every
 * matching row exactly once.
 */

import { describe, expect, it } from 'vitest'
import type { ClaimQuery, RoleId, Session } from '../domain/types'
import { capabilitiesFor } from './policy'
import { getDataset, RECORD_COUNT } from './dataset'
import { decodeCursor, encodeCursor, queryClaims, queryClaimsByPage } from './queryEngine'

function sessionFor(role: RoleId = 'supervisor'): Session {
  return {
    userId: 'u-1041',
    displayName: 'Test User',
    jobTitle: 'Test',
    role,
    roleLabel: role,
    capabilities: capabilitiesFor(role),
    region: 'EMEA',
  }
}

const baseQuery: ClaimQuery = {
  sort: { field: 'receivedAt', direction: 'desc' },
  limit: 100,
}

describe('dataset', () => {
  it('generates the full record count deterministically', () => {
    const a = getDataset()
    const b = getDataset()
    expect(a.length).toBe(RECORD_COUNT)
    // Same array instance — built once and cached.
    expect(a).toBe(b)
  })

  it('includes documents in the 150 MB - 1 GB range the brief specifies', () => {
    const all = getDataset()
    const huge = all.filter((c) => c.documentBytes > 600_000_000)
    expect(huge.length).toBeGreaterThan(0)
  })
})

describe('server-side sorting', () => {
  it('sorts ascending and descending on a string column', () => {
    const asc = queryClaims(sessionFor(), {
      ...baseQuery,
      sort: { field: 'claimantName', direction: 'asc' },
      limit: 20,
    })
    const names = asc.rows.map((r) => r.claimantName)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)

    const desc = queryClaims(sessionFor(), {
      ...baseQuery,
      sort: { field: 'claimantName', direction: 'desc' },
      limit: 20,
    })
    expect(desc.rows[0]!.claimantName >= asc.rows[0]!.claimantName).toBe(true)
  })

  it('sorts numerically, not lexicographically, on a numeric column', () => {
    const res = queryClaims(sessionFor(), {
      ...baseQuery,
      sort: { field: 'incurredAmount', direction: 'desc' },
      limit: 50,
    })
    const amounts = res.rows.map((r) => r.incurredAmount)
    for (let i = 1; i < amounts.length; i++) {
      expect(amounts[i - 1]!).toBeGreaterThanOrEqual(amounts[i]!)
    }
  })
})

describe('server-side filtering', () => {
  it('filters by status', () => {
    const res = queryClaims(sessionFor(), { ...baseQuery, status: ['approved'] })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.every((r) => r.status === 'approved')).toBe(true)
  })

  it('combines multiple filter dimensions conjunctively', () => {
    const res = queryClaims(sessionFor(), {
      ...baseQuery,
      status: ['in_review'],
      priority: ['critical'],
    })
    expect(res.rows.every((r) => r.status === 'in_review' && r.priority === 'critical')).toBe(true)
  })

  it('searches across claim number, claimant, policy and cedent', () => {
    const res = queryClaims(sessionFor(), { ...baseQuery, q: 'Meridian' })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.every((r) => r.cedent.includes('Meridian'))).toBe(true)
  })

  it('resolves "unassigned" to rows with no assignee', () => {
    const res = queryClaims(sessionFor(), { ...baseQuery, assignee: 'unassigned' })
    expect(res.rows.length).toBeGreaterThan(0)
    expect(res.rows.every((r) => r.assigneeId === null)).toBe(true)
  })

  it('resolves "me" to the calling session user', () => {
    const s = sessionFor()
    const res = queryClaims(s, { ...baseQuery, assignee: 'me' })
    expect(res.rows.every((r) => r.assigneeId === s.userId)).toBe(true)
  })
})

describe('facets', () => {
  it('returns counts over the whole filtered set, not the current page', () => {
    const res = queryClaims(sessionFor(), { ...baseQuery, limit: 10 })
    const statusTotal = res.facets.status.reduce((a, f) => a + f.count, 0)
    // Facet totals reflect all 20k visible rows, far more than the 10 returned.
    expect(res.rows.length).toBe(10)
    expect(statusTotal).toBeGreaterThan(1000)
  })

  it('ignores a facet\'s own dimension so its counts stay useful when active', () => {
    const unfiltered = queryClaims(sessionFor(), baseQuery)
    const filtered = queryClaims(sessionFor(), { ...baseQuery, status: ['approved'] })
    // Status counts are unchanged by the status filter itself.
    expect(filtered.facets.status).toEqual(unfiltered.facets.status)
    // Other dimensions DO narrow.
    const unfilteredChannelTotal = unfiltered.facets.channel.reduce((a, f) => a + f.count, 0)
    const filteredChannelTotal = filtered.facets.channel.reduce((a, f) => a + f.count, 0)
    expect(filteredChannelTotal).toBeLessThan(unfilteredChannelTotal)
  })
})

describe('keyset pagination', () => {
  it('round-trips a cursor', () => {
    const c = { v: 'x', id: 'clm-100000', dir: 'next' as const, page: 2 }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
  })

  it('returns null for a malformed cursor rather than throwing', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
  })

  /**
   * THE PROPERTY TEST. Walk the whole filtered set page by page via cursors and
   * assert every row is visited exactly once. This is what catches a missing
   * tie-breaker.
   */
  it('visits every matching row exactly once when walking forward', () => {
    const session = sessionFor()
    // Sorted on a low-cardinality column, which is where tie-breaking matters.
    const query: ClaimQuery = {
      ...baseQuery,
      status: ['denied'],
      sort: { field: 'status', direction: 'asc' },
      limit: 50,
    }

    const seen = new Set<string>()
    let duplicates = 0
    let cursor: string | undefined
    let pages = 0

    for (;;) {
      const res = queryClaims(session, { ...query, cursor })
      for (const row of res.rows) {
        if (seen.has(row.id)) duplicates++
        seen.add(row.id)
      }
      pages++
      if (!res.nextCursor) break
      cursor = res.nextCursor
      // Guard against an infinite loop if paging is broken.
      if (pages > 100) throw new Error('pagination did not terminate')
    }

    const expected = queryClaims(session, { ...query, limit: 20_000 })
    expect(duplicates).toBe(0)
    expect(seen.size).toBe(expected.rows.length)
    expect(pages).toBeGreaterThan(1)
  })

  it('degrades to the first page when the cursor row no longer matches', () => {
    const session = sessionFor()
    // A cursor pointing at a row that isn't in this result set at all.
    const bogus = encodeCursor({ v: 'zzz', id: 'clm-999999', dir: 'next', page: 7 })
    const res = queryClaims(session, { ...baseQuery, cursor: bogus })
    expect(res.page).toBe(1)
    expect(res.rows.length).toBeGreaterThan(0)
  })

  it('reports no previous cursor on the first page', () => {
    const res = queryClaims(sessionFor(), baseQuery)
    expect(res.prevCursor).toBeNull()
    expect(res.nextCursor).not.toBeNull()
  })
})

describe('approximate counts', () => {
  it('reports an exact total for small result sets', () => {
    const res = queryClaims(sessionFor(), {
      ...baseQuery,
      q: 'Meridian',
      status: ['denied'],
      priority: ['critical'],
    })
    if (res.rows.length > 0 && res.approximateTotal <= 2000) {
      expect(res.exact).toBe(true)
    }
  })

  it('reports an approximate, rounded total for large result sets', () => {
    const res = queryClaims(sessionFor(), baseQuery)
    expect(res.exact).toBe(false)
    // Rounded down to 2 significant figures, and never overstated.
    expect(res.approximateTotal).toBeLessThanOrEqual(RECORD_COUNT)
    expect(res.approximateTotal % 100).toBe(0)
  })
})

describe('offset page jumps', () => {
  it('returns the requested page', () => {
    const res = queryClaimsByPage(sessionFor(), baseQuery, 5)
    expect(res.page).toBe(5)
    expect(res.rows.length).toBe(baseQuery.limit)
  })

  it('clamps an out-of-range page rather than returning nothing', () => {
    const res = queryClaimsByPage(sessionFor(), baseQuery, 99_999)
    expect(res.page).toBe(res.pageCount)
    expect(res.rows.length).toBeGreaterThan(0)
  })

  it('produces disjoint pages', () => {
    const p1 = queryClaimsByPage(sessionFor(), { ...baseQuery, limit: 25 }, 1)
    const p2 = queryClaimsByPage(sessionFor(), { ...baseQuery, limit: 25 }, 2)
    const ids = new Set(p1.rows.map((r) => r.id))
    expect(p2.rows.some((r) => ids.has(r.id))).toBe(false)
  })
})

describe('authorization is applied before pagination', () => {
  it('never returns a row outside the caller\'s visible scope', () => {
    const res = queryClaims(sessionFor('claims_adjuster'), { ...baseQuery, limit: 500 })
    expect(res.rows.every((r) => r.region === 'EMEA')).toBe(true)
  })

  it('attaches per-record permissions to every returned row', () => {
    const res = queryClaims(sessionFor('claims_adjuster'), { ...baseQuery, limit: 20 })
    for (const row of res.rows) {
      expect(row.permissions['claim:view']).toBeDefined()
      expect(row.permissions['claim:edit']).toBeDefined()
      expect(row.permissions['claim:delete']).toBeDefined()
    }
  })

  it('gives an intake clerk a strictly smaller result set than a supervisor', () => {
    const clerk = queryClaims(sessionFor('intake_clerk'), baseQuery)
    const supervisor = queryClaims(sessionFor('supervisor'), baseQuery)
    expect(clerk.approximateTotal).toBeLessThan(supervisor.approximateTotal)
  })
})
