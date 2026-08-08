/**
 * URL AS THE SOURCE OF TRUTH for grid view state.
 *
 * Filters, sort, page and selection live in the query string — not in a store.
 * That single decision buys a lot:
 *
 *   - A supervisor can paste a URL into Teams and a colleague sees the same
 *     filtered workqueue. In claims triage that happens constantly.
 *   - Back/forward work correctly without any custom history handling.
 *   - Reload restores the view. An adjuster who refreshes mid-triage doesn't
 *     lose their filters.
 *   - The query key derives from the URL, so caching and refetching fall out
 *     for free.
 *   - There is no store to keep in sync with the address bar — a class of bug
 *     that simply cannot occur.
 *
 * The cost is that state must be serialisable and the URL gets long. Both are
 * acceptable; see the design doc's trade-off table.
 */

import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  ClaimChannel,
  ClaimPriority,
  ClaimQuery,
  ClaimStatus,
  SlaState,
  SortDirection,
} from '../domain/types'

export const DEFAULT_PAGE_SIZE = 100

export interface GridState {
  q: string
  status: ClaimStatus[]
  channel: ClaimChannel[]
  priority: ClaimPriority[]
  slaState: SlaState[]
  assignee: 'me' | 'unassigned' | 'any'
  sortField: keyof import('../domain/types').Claim
  sortDir: SortDirection
  page: number
  pageSize: number
  /** Selected claim id — drives the detail peek panel. */
  selected: string | null
}

function csv<T extends string>(raw: string | null): T[] {
  return raw ? (raw.split(',').filter(Boolean) as T[]) : []
}

export function useGridState(): {
  state: GridState
  query: ClaimQuery
  activeFilterCount: number
  set: (patch: Partial<GridState>) => void
  toggleFacet: <K extends 'status' | 'channel' | 'priority' | 'slaState'>(
    key: K,
    value: GridState[K][number],
  ) => void
  toggleSort: (field: GridState['sortField']) => void
  clearFilters: () => void
} {
  const [params, setParams] = useSearchParams()

  const state = useMemo<GridState>(
    () => ({
      q: params.get('q') ?? '',
      status: csv<ClaimStatus>(params.get('status')),
      channel: csv<ClaimChannel>(params.get('channel')),
      priority: csv<ClaimPriority>(params.get('priority')),
      slaState: csv<SlaState>(params.get('sla')),
      assignee: (params.get('assignee') as GridState['assignee']) ?? 'any',
      sortField: (params.get('sortField') ?? 'receivedAt') as GridState['sortField'],
      sortDir: (params.get('sortDir') ?? 'desc') as SortDirection,
      page: Math.max(1, Number(params.get('page') ?? 1)),
      pageSize: Number(params.get('pageSize') ?? DEFAULT_PAGE_SIZE),
      selected: params.get('selected'),
    }),
    [params],
  )

  const set = useCallback(
    (patch: Partial<GridState>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)

          const write = (key: string, value: string | null | undefined): void => {
            if (!value) next.delete(key)
            else next.set(key, value)
          }

          if ('q' in patch) write('q', patch.q)
          if ('status' in patch) write('status', patch.status?.join(','))
          if ('channel' in patch) write('channel', patch.channel?.join(','))
          if ('priority' in patch) write('priority', patch.priority?.join(','))
          if ('slaState' in patch) write('sla', patch.slaState?.join(','))
          if ('assignee' in patch) {
            write('assignee', patch.assignee === 'any' ? null : patch.assignee)
          }
          if ('sortField' in patch) write('sortField', patch.sortField)
          if ('sortDir' in patch) write('sortDir', patch.sortDir)
          if ('pageSize' in patch) {
            write('pageSize', patch.pageSize === DEFAULT_PAGE_SIZE ? null : String(patch.pageSize))
          }
          if ('selected' in patch) write('selected', patch.selected)

          // Any change to filters or sort resets to page 1 — staying on page 12
          // of a result set that no longer has 12 pages is a classic grid bug.
          const changesResultSet =
            'q' in patch ||
            'status' in patch ||
            'channel' in patch ||
            'priority' in patch ||
            'slaState' in patch ||
            'assignee' in patch ||
            'sortField' in patch ||
            'sortDir' in patch ||
            'pageSize' in patch

          if ('page' in patch) {
            write('page', patch.page === 1 ? null : String(patch.page))
          } else if (changesResultSet) {
            next.delete('page')
          }

          return next
        },
        // replace: filter keystrokes shouldn't each become a history entry the
        // user has to press Back through.
        { replace: true },
      )
    },
    [setParams],
  )

  const toggleFacet = useCallback(
    <K extends 'status' | 'channel' | 'priority' | 'slaState'>(
      key: K,
      value: GridState[K][number],
    ): void => {
      const current = state[key] as string[]
      const next = current.includes(value as string)
        ? current.filter((v) => v !== value)
        : [...current, value as string]
      set({ [key]: next } as unknown as Partial<GridState>)
    },
    [state, set],
  )

  const toggleSort = useCallback(
    (field: GridState['sortField']): void => {
      if (state.sortField === field) {
        set({ sortDir: state.sortDir === 'asc' ? 'desc' : 'asc' })
      } else {
        // New column starts descending: for dates and amounts "biggest first"
        // is almost always what the user wants.
        set({ sortField: field, sortDir: 'desc' })
      }
    },
    [state.sortField, state.sortDir, set],
  )

  const clearFilters = useCallback(() => {
    set({
      q: '',
      status: [],
      channel: [],
      priority: [],
      slaState: [],
      assignee: 'any',
      page: 1,
    })
  }, [set])

  const activeFilterCount =
    (state.q ? 1 : 0) +
    state.status.length +
    state.channel.length +
    state.priority.length +
    state.slaState.length +
    (state.assignee !== 'any' ? 1 : 0)

  const query = useMemo<ClaimQuery>(
    () => ({
      q: state.q || undefined,
      status: state.status.length ? state.status : undefined,
      channel: state.channel.length ? state.channel : undefined,
      priority: state.priority.length ? state.priority : undefined,
      slaState: state.slaState.length ? state.slaState : undefined,
      assignee: state.assignee === 'any' ? undefined : state.assignee,
      sort: { field: state.sortField, direction: state.sortDir },
      limit: state.pageSize,
    }),
    [state],
  )

  return { state, query, activeFilterCount, set, toggleFacet, toggleSort, clearFilters }
}

/** Serialise a query into the API's search params. Also used as the cache key. */
export function toSearchParams(q: ClaimQuery, page: number): string {
  const p = new URLSearchParams()
  if (q.q) p.set('q', q.q)
  if (q.status?.length) p.set('status', q.status.join(','))
  if (q.channel?.length) p.set('channel', q.channel.join(','))
  if (q.priority?.length) p.set('priority', q.priority.join(','))
  if (q.slaState?.length) p.set('slaState', q.slaState.join(','))
  if (q.assignee) p.set('assignee', q.assignee)
  p.set('sortField', String(q.sort.field))
  p.set('sortDir', q.sort.direction)
  p.set('limit', String(q.limit))
  p.set('page', String(page))
  return p.toString()
}
