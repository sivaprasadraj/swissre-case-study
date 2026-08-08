/**
 * PAGE WINDOW — the memory discipline for large documents.
 *
 * The naive viewer keeps every page it has rendered. Open a 4,000-page bundle,
 * scroll to the end, and the tab is holding thousands of rasterised pages. At
 * roughly 4 MB per rendered A4 page at 1.5× (595×842pt → ~1300×1840px × 4 bytes
 * RGBA ≈ 9.5 MB uncompressed, less as a decoded image), a few hundred pages is
 * enough to make a corporate laptop swap and eventually crash the tab.
 *
 * So the window is bounded by construction:
 *
 *   RENDER_AHEAD / RENDER_BEHIND   which pages we ask the network for
 *   RETAIN_LIMIT                   how many decoded pages we keep at all
 *
 * Eviction is least-recently-visible, not LRU-by-access: a page the user
 * scrolled past 200 pages ago is a better eviction candidate than one they
 * scrolled past 3 pages ago, regardless of when it was last touched in code.
 *
 * The visible-page set is tracked with IntersectionObserver rather than scroll
 * maths. Scroll handlers fire far more often than needed and force layout reads;
 * IO batches its callbacks off the main thread's critical path.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const RENDER_AHEAD = 3
export const RENDER_BEHIND = 2
/** Hard ceiling on decoded pages held in memory. ~15 × ~4 MB ≈ 60 MB worst case. */
export const RETAIN_LIMIT = 15

export interface PageWindow {
  /** Pages we should have loaded right now. */
  active: Set<number>
  /** Pages currently intersecting the viewport, in ascending order. */
  visible: number[]
  /** The page the UI should treat as "current" for the page indicator. */
  currentPage: number
  /** Register a page element for visibility tracking. */
  observe: (page: number, el: HTMLElement | null) => void
  /** Stats for the memory read-out in the UI. */
  stats: { retained: number; evicted: number; limit: number }
}

export function usePageWindow(pageCount: number, scrollRoot: HTMLElement | null): PageWindow {
  const [visible, setVisible] = useState<number[]>([1])
  const [dominant, setDominant] = useState(1)
  const [evicted, setEvicted] = useState(0)

  const observer = useRef<IntersectionObserver | null>(null)
  const elements = useRef(new Map<number, HTMLElement>())
  const visibleSet = useRef(new Set<number>([1]))
  /** Per-page share of the viewport, used to pick the page the user is reading. */
  const ratios = useRef(new Map<number, number>())

  /**
   * Insertion-ordered record of pages, used for least-recently-visible
   * eviction. A Set preserves insertion order, and re-inserting requires an
   * explicit delete-then-add — which is exactly the "touch" semantics we want.
   */
  const retained = useRef<Set<number>>(new Set([1]))

  useEffect(() => {
    if (!scrollRoot) return

    observer.current?.disconnect()
    observer.current = new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page)
          if (!page) continue

          ratios.current.set(page, entry.isIntersecting ? entry.intersectionRatio : 0)

          const was = visibleSet.current.has(page)
          if (entry.isIntersecting && !was) {
            visibleSet.current.add(page)
            changed = true
          } else if (!entry.isIntersecting && was) {
            visibleSet.current.delete(page)
            changed = true
          }
        }

        if (changed) {
          setVisible([...visibleSet.current].sort((a, b) => a - b))
        }

        /**
         * "Current page" is the one occupying the most viewport, NOT the lowest
         * intersecting index.
         *
         * The rootMargin below deliberately makes pages intersect ~200px before
         * they are on screen, so the naive "first visible" answer reports the
         * page above the one the user is actually reading — and the page
         * indicator then disagrees with the page on screen.
         */
        let best = -1
        let bestRatio = -1
        for (const [page, ratio] of ratios.current) {
          if (ratio > bestRatio || (ratio === bestRatio && page < best)) {
            best = page
            bestRatio = ratio
          }
        }
        if (best > 0 && bestRatio > 0) setDominant(best)
      },
      {
        root: scrollRoot,
        // Start loading slightly before a page enters the viewport so the render
        // has a head start; without this the top of each page flashes blank.
        rootMargin: '200px 0px',
        // Several thresholds so intersectionRatio updates as a page scrolls
        // through, rather than only at the boundary.
        threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.95],
      },
    )

    for (const el of elements.current.values()) observer.current.observe(el)
    return () => observer.current?.disconnect()
  }, [scrollRoot])

  const observe = useCallback((page: number, el: HTMLElement | null): void => {
    const existing = elements.current.get(page)
    if (existing && existing !== el) {
      observer.current?.unobserve(existing)
      elements.current.delete(page)
      // Drop the stale ratio too — an unobserved page never reports 0, so
      // leaving it would keep a scrolled-away page as the "dominant" one.
      ratios.current.delete(page)
      visibleSet.current.delete(page)
    }
    if (el) {
      el.dataset.page = String(page)
      elements.current.set(page, el)
      observer.current?.observe(el)
    }
  }, [])

  const currentPage = dominant

  /**
   * The active set: visible pages plus a small look-ahead/behind band, clamped
   * to the document and capped at RETAIN_LIMIT.
   */
  const active = useMemo(() => {
    const first = visible[0] ?? 1
    const last = visible[visible.length - 1] ?? first

    const from = Math.max(1, first - RENDER_BEHIND)
    const to = Math.min(pageCount, last + RENDER_AHEAD)

    const next = new Set<number>()
    for (let p = from; p <= to; p++) next.add(p)

    // Touch: re-insert visible pages at the end of the retention order so they
    // are the last to be evicted.
    for (const p of next) {
      retained.current.delete(p)
      retained.current.add(p)
    }

    // Evict from the front (least recently visible) until under the ceiling.
    let dropped = 0
    while (retained.current.size > RETAIN_LIMIT) {
      const oldest = retained.current.values().next().value as number | undefined
      if (oldest === undefined) break
      // Never evict something we need right now, even if it's oldest — that
      // would thrash. If everything retained is active, we're at the floor.
      if (next.has(oldest) && retained.current.size <= next.size) break
      retained.current.delete(oldest)
      dropped++
    }
    if (dropped > 0) setEvicted((e) => e + dropped)

    // The renderable set is the intersection of "wanted" and "retained".
    const renderable = new Set<number>()
    for (const p of next) if (retained.current.has(p)) renderable.add(p)
    return renderable
  }, [visible, pageCount])

  return {
    active,
    visible,
    currentPage,
    observe,
    stats: { retained: retained.current.size, evicted, limit: RETAIN_LIMIT },
  }
}
