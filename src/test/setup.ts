import '@testing-library/dom'

/**
 * jsdom implements neither IntersectionObserver nor ResizeObserver. The page
 * window and the responsive column hook both depend on them, so they get
 * minimal stubs here rather than being mocked per test.
 */
class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds: ReadonlyArray<number> = []
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver

globalThis.ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

// The virtualizer measures the scroll element; jsdom reports 0 for everything,
// which would render zero rows. Give elements a plausible box.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
}
