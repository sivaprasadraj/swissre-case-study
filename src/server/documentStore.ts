/**
 * SERVER-SIDE DOCUMENT STORE.
 *
 * Models the ingest pipeline's output: for every claim, a set of documents, and
 * for every document an immutable, versioned page manifest.
 *
 * The important architectural claim being demonstrated here is that a "1 GB
 * document" is delivered to the client as a manifest of a few KB plus N
 * independently-addressable page resources. The bytes never traverse the app.
 *
 * Mutating operations (split / merge / delete pages) produce a NEW version with
 * a new ETag rather than mutating in place. That is what makes concurrent
 * adjudication safe and what makes "consistent state after split/merge"
 * achievable rather than aspirational.
 */

import type {
  Annotation,
  DocumentManifest,
  DocumentSummary,
  Job,
  JobKind,
  PageComment,
  PageDescriptor,
} from '../domain/types'
import { getDataset } from './dataset'

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Monotonic counter instead of Date.now(), so fixtures stay deterministic. */
let versionCounter = 1000
function nextVersion(): string {
  return `v${++versionCounter}`
}

let etagCounter = 5000
function nextEtag(): string {
  return `"etag-${++etagCounter}"`
}

const DOC_KINDS = [
  { name: 'Claim Form', mime: 'application/pdf' },
  { name: 'Medical Records', mime: 'application/pdf' },
  { name: 'Attending Physician Statement', mime: 'application/pdf' },
  { name: 'Policy Schedule', mime: 'application/pdf' },
  { name: 'Correspondence Bundle', mime: 'application/pdf' },
  { name: 'Hospital Discharge Summary', mime: 'application/pdf' },
  { name: 'Death Certificate', mime: 'application/pdf' },
  { name: 'Underwriting File', mime: 'application/pdf' },
  { name: 'Beneficiary Declaration', mime: 'application/pdf' },
  { name: 'Loss Adjuster Report', mime: 'application/pdf' },
]

interface StoredDoc {
  summary: DocumentSummary
  manifest: DocumentManifest
  comments: PageComment[]
  annotations: Annotation[]
  /** Every published version, newest last. Enables the audit trail. */
  history: { version: string; note: string }[]
}

const docsByClaim = new Map<string, StoredDoc[]>()

/** Page dimensions in points; A4 and US Letter, some rotated. */
const PAGE_SIZES: [number, number][] = [
  [595, 842], // A4 portrait
  [612, 792], // Letter portrait
  [842, 595], // A4 landscape
]

function buildManifest(
  docId: string,
  fileName: string,
  byteSize: number,
  pageCount: number,
  rng: () => number,
): DocumentManifest {
  const pages: PageDescriptor[] = []
  const bytesPerPage = Math.floor(byteSize / pageCount)

  for (let i = 0; i < pageCount; i++) {
    const [w, h] = PAGE_SIZES[Math.floor(rng() * PAGE_SIZES.length)]!
    const start = i * bytesPerPage
    pages.push({
      // Stable identity, independent of position. Annotations anchor here.
      pageId: `${docId}-p${String(i + 1).padStart(4, '0')}`,
      index: i + 1,
      widthPt: w,
      heightPt: h,
      rotation: rng() > 0.96 ? 90 : 0,
      byteRange: [start, start + bytesPerPage - 1],
      thumbnailUrl: `/api/documents/${docId}/pages/${i + 1}/thumbnail`,
      // Scanned intake documents lack a text layer until OCR completes — this
      // is what forces the accessibility fallback discussed in the design doc.
      hasTextLayer: rng() > 0.22,
    })
  }

  const outline =
    pageCount > 12
      ? [
          { title: 'Cover & Submission', pageIndex: 1 },
          { title: 'Policy Details', pageIndex: Math.floor(pageCount * 0.12) + 1 },
          {
            title: 'Medical Evidence',
            pageIndex: Math.floor(pageCount * 0.3) + 1,
            children: [
              { title: 'Consultations', pageIndex: Math.floor(pageCount * 0.32) + 1 },
              { title: 'Lab Results', pageIndex: Math.floor(pageCount * 0.48) + 1 },
              { title: 'Imaging', pageIndex: Math.floor(pageCount * 0.6) + 1 },
            ],
          },
          { title: 'Correspondence', pageIndex: Math.floor(pageCount * 0.75) + 1 },
          { title: 'Adjuster Notes', pageIndex: Math.floor(pageCount * 0.92) + 1 },
        ]
      : [{ title: 'Document', pageIndex: 1 }]

  return {
    documentId: docId,
    version: nextVersion(),
    fileName,
    byteSize,
    pageCount,
    etag: nextEtag(),
    pages,
    outline,
  }
}

export function getDocumentsForClaim(claimId: string): StoredDoc[] {
  const existing = docsByClaim.get(claimId)
  if (existing) return existing

  const claim = getDataset().find((c) => c.id === claimId)
  if (!claim) return []

  // Seed from the claim id so a given claim always yields the same documents.
  const seed = Array.from(claimId).reduce((a, ch) => a + ch.charCodeAt(0) * 31, 7)
  const rng = makeRng(seed)

  const docs: StoredDoc[] = []
  let remainingBytes = claim.documentBytes

  for (let i = 0; i < claim.documentCount; i++) {
    const isLast = i === claim.documentCount - 1
    const share = isLast ? remainingBytes : Math.floor(remainingBytes * (0.2 + rng() * 0.5))
    remainingBytes -= share
    const byteSize = Math.max(120_000, share)

    const kind = DOC_KINDS[Math.floor(rng() * DOC_KINDS.length)]!
    const docId = `doc-${claimId.replace('clm-', '')}-${i + 1}`

    // ~180 KB/page for a scanned bundle; clamped so page counts stay plausible.
    const pageCount = Math.max(1, Math.min(4200, Math.round(byteSize / 180_000)))

    const fileName = `${claim.claimNumber}_${kind.name.replace(/ /g, '_')}.pdf`
    const manifest = buildManifest(docId, fileName, byteSize, pageCount, rng)

    // Very large documents are still being processed — this is what drives the
    // "derivatives not ready" disabled states in the UI.
    const derivativesReady = byteSize < 600_000_000 || rng() > 0.5

    docs.push({
      summary: {
        id: docId,
        claimId,
        fileName,
        mimeType: kind.mime,
        byteSize,
        pageCount,
        channel: claim.channel,
        receivedAt: claim.receivedAt,
        version: manifest.version,
        derivativesReady,
        ocrStatus: derivativesReady
          ? rng() > 0.15
            ? 'complete'
            : 'pending'
          : 'pending',
      },
      manifest,
      comments: seedComments(docId, manifest, rng),
      annotations: seedAnnotations(docId, manifest, rng),
      history: [{ version: manifest.version, note: 'Ingested from source channel' }],
    })
  }

  docsByClaim.set(claimId, docs)
  return docs
}

const COMMENT_AUTHORS = [
  { id: 'u-1041', name: 'Evano Rijkaard' },
  { id: 'u-2277', name: 'Amara Diallo' },
  { id: 'u-3390', name: 'Henrik Solberg' },
]

const COMMENT_BODIES = [
  'Diagnosis code on this page conflicts with the APS. Querying the cedent.',
  'Signature block missing — requesting a re-signed copy.',
  'This page duplicates page 3 of the correspondence bundle. Candidate for removal.',
  'Treatment date falls outside the policy period. Flagging for senior review.',
  'Illegible scan. OCR confidence low; manual transcription needed.',
  'Confirmed against the treaty schedule. No further action.',
  'Redaction required before sharing with the retrocessionaire.',
]

function seedComments(
  docId: string,
  manifest: DocumentManifest,
  rng: () => number,
): PageComment[] {
  // Always seed 2-4 comments so the feature is visible on every document.
  const n = 2 + Math.floor(rng() * 3)
  const out: PageComment[] = []
  for (let i = 0; i < n; i++) {
    // Anchor to the first few pages, not a random page deep in a 100+ page
    // document. Otherwise the pins exist but are never on screen when the
    // viewer opens at page 1, and the feature looks broken.
    const pageIdx = Math.min(manifest.pages.length - 1, i)
    const page = manifest.pages[pageIdx]!
    const author = COMMENT_AUTHORS[Math.floor(rng() * COMMENT_AUTHORS.length)]!
    out.push({
      id: `cmt-${docId}-${i}`,
      documentId: docId,
      pageId: page.pageId,
      authorId: author.id,
      authorName: author.name,
      body: COMMENT_BODIES[Math.floor(rng() * COMMENT_BODIES.length)]!,
      createdAt: new Date(Date.UTC(2026, 0, 2 + i)).toISOString(),
      resolved: rng() > 0.7,
      anchor: { x: 0.15 + rng() * 0.5, y: 0.15 + rng() * 0.5 },
    })
  }
  return out
}

function seedAnnotations(
  docId: string,
  manifest: DocumentManifest,
  rng: () => number,
): Annotation[] {
  // Always seed 2-3 so the feature is visible, and anchor them to the first
  // pages rather than a random page deep in a long document.
  const n = 2 + Math.floor(rng() * 2)
  const kinds: Annotation['kind'][] = ['highlight', 'redaction', 'note']
  const out: Annotation[] = []
  for (let i = 0; i < n; i++) {
    const page = manifest.pages[Math.min(manifest.pages.length - 1, i)]!
    const author = COMMENT_AUTHORS[Math.floor(rng() * COMMENT_AUTHORS.length)]!
    const kind = kinds[Math.floor(rng() * kinds.length)]!
    out.push({
      id: `ann-${docId}-${i}`,
      documentId: docId,
      pageId: page.pageId,
      kind,
      rect: {
        x: 0.08 + rng() * 0.5,
        y: 0.08 + rng() * 0.7,
        w: 0.18 + rng() * 0.3,
        h: 0.02 + rng() * 0.05,
      },
      color:
        kind === 'redaction' ? '#16171b' : kind === 'highlight' ? '#f0a22e' : '#5932ea',
      authorId: author.id,
      authorName: author.name,
      createdAt: new Date(Date.UTC(2026, 0, 3 + i)).toISOString(),
      note: kind === 'note' ? 'Cross-reference with the underwriting file.' : undefined,
    })
  }
  return out
}

export function findDoc(docId: string): StoredDoc | undefined {
  // Recover the claim id from the document id, then materialize that claim's set.
  const m = /^doc-(\d+)-\d+$/.exec(docId)
  if (!m) return undefined
  const docs = getDocumentsForClaim(`clm-${m[1]}`)
  return docs.find((d) => d.summary.id === docId)
}

/* ------------------------------------------------------------------- writes */

export interface OpResult {
  ok: boolean
  status: number
  version?: string
  etag?: string
  error?: string
  failedInputs?: string[]
}

/**
 * Publish a new version after a structural operation.
 *
 * `ifMatch` implements optimistic concurrency: if another adjudicator published
 * a version since this client last read, we reject with 412 rather than
 * silently clobbering their work. The UI turns that into a reconciliation
 * prompt, never a silent overwrite.
 */
export function applySplit(
  docId: string,
  afterIndex: number,
  ifMatch: string | null,
): OpResult {
  const doc = findDoc(docId)
  if (!doc) return { ok: false, status: 404, error: 'Document not found' }
  if (ifMatch && ifMatch !== doc.manifest.etag) {
    return {
      ok: false,
      status: 412,
      error: 'This document changed since you opened it. Reload to see the latest version.',
    }
  }
  if (afterIndex < 1 || afterIndex >= doc.manifest.pageCount) {
    return { ok: false, status: 422, error: 'Split point is outside the document.' }
  }

  // Pages keep their pageId — only `index` changes. This is precisely why
  // annotations anchor to pageId: they survive the operation untouched.
  const kept = doc.manifest.pages.slice(0, afterIndex)
  doc.manifest = {
    ...doc.manifest,
    version: nextVersion(),
    etag: nextEtag(),
    pageCount: kept.length,
    pages: kept.map((p, i) => ({ ...p, index: i + 1 })),
  }
  doc.summary = { ...doc.summary, version: doc.manifest.version, pageCount: kept.length }
  doc.history.push({
    version: doc.manifest.version,
    note: `Split after page ${afterIndex}; ${kept.length} pages retained`,
  })
  return { ok: true, status: 200, version: doc.manifest.version, etag: doc.manifest.etag }
}

export function applyDeletePages(
  docId: string,
  pageIds: string[],
  ifMatch: string | null,
): OpResult {
  const doc = findDoc(docId)
  if (!doc) return { ok: false, status: 404, error: 'Document not found' }
  if (ifMatch && ifMatch !== doc.manifest.etag) {
    return {
      ok: false,
      status: 412,
      error: 'This document changed since you opened it. Reload to see the latest version.',
    }
  }
  const remove = new Set(pageIds)
  const kept = doc.manifest.pages.filter((p) => !remove.has(p.pageId))
  if (kept.length === 0) {
    return { ok: false, status: 422, error: 'A document must retain at least one page.' }
  }

  doc.manifest = {
    ...doc.manifest,
    version: nextVersion(),
    etag: nextEtag(),
    pageCount: kept.length,
    pages: kept.map((p, i) => ({ ...p, index: i + 1 })),
  }
  doc.summary = { ...doc.summary, version: doc.manifest.version, pageCount: kept.length }

  // Comments and annotations on deleted pages are ORPHANED, not destroyed.
  // Retention rules in claims work generally forbid hard-deleting adjudication
  // commentary; the UI surfaces them in an "orphaned" list instead.
  doc.history.push({
    version: doc.manifest.version,
    note: `Deleted ${remove.size} page(s)`,
  })
  return { ok: true, status: 200, version: doc.manifest.version, etag: doc.manifest.etag }
}

/**
 * Merge is atomic: either every input is appended and a new version published,
 * or nothing is. A half-merged version is never visible.
 *
 * `simulateFailureFor` lets the prototype demonstrate the partial-failure path
 * that the case study explicitly asks about.
 */
export function applyMerge(
  targetId: string,
  sourceIds: string[],
  ifMatch: string | null,
  simulateFailureFor?: string,
): OpResult {
  const target = findDoc(targetId)
  if (!target) return { ok: false, status: 404, error: 'Target document not found' }
  if (ifMatch && ifMatch !== target.manifest.etag) {
    return {
      ok: false,
      status: 412,
      error: 'This document changed since you opened it. Reload to see the latest version.',
    }
  }

  const sources = sourceIds.map((id) => ({ id, doc: findDoc(id) }))
  const missing = sources.filter((s) => !s.doc).map((s) => s.id)
  const failing = simulateFailureFor ? [simulateFailureFor] : []
  const failed = [...missing, ...failing]

  if (failed.length > 0) {
    // Atomic: nothing was published. The UI offers retry-excluding-the-failure.
    return {
      ok: false,
      status: 409,
      error: `${failed.length} input document(s) could not be merged. No changes were published.`,
      failedInputs: failed,
    }
  }

  const appended: PageDescriptor[] = []
  for (const s of sources) {
    for (const p of s.doc!.manifest.pages) {
      // Fresh pageId: the merged copy is a distinct page from the original.
      appended.push({ ...p, pageId: `${p.pageId}-m${versionCounter}` })
    }
  }

  const combined = [...target.manifest.pages, ...appended]
  target.manifest = {
    ...target.manifest,
    version: nextVersion(),
    etag: nextEtag(),
    pageCount: combined.length,
    byteSize:
      target.manifest.byteSize +
      sources.reduce((a, s) => a + s.doc!.manifest.byteSize, 0),
    pages: combined.map((p, i) => ({ ...p, index: i + 1 })),
  }
  target.summary = {
    ...target.summary,
    version: target.manifest.version,
    pageCount: combined.length,
    byteSize: target.manifest.byteSize,
  }
  target.history.push({
    version: target.manifest.version,
    note: `Merged ${sources.length} document(s); ${appended.length} pages appended`,
  })
  return { ok: true, status: 200, version: target.manifest.version, etag: target.manifest.etag }
}

export function addComment(
  docId: string,
  pageId: string,
  body: string,
  author: { id: string; name: string },
  anchor?: { x: number; y: number },
): PageComment | null {
  const doc = findDoc(docId)
  if (!doc) return null
  const comment: PageComment = {
    id: `cmt-${docId}-${doc.comments.length}-${++etagCounter}`,
    documentId: docId,
    pageId,
    authorId: author.id,
    authorName: author.name,
    body,
    createdAt: new Date(Date.UTC(2026, 0, 6)).toISOString(),
    resolved: false,
    anchor,
  }
  doc.comments.push(comment)
  return comment
}

export function addAnnotation(
  docId: string,
  ann: Omit<Annotation, 'id' | 'createdAt'>,
): Annotation | null {
  const doc = findDoc(docId)
  if (!doc) return null
  const created: Annotation = {
    ...ann,
    id: `ann-${docId}-${doc.annotations.length}-${++etagCounter}`,
    createdAt: new Date(Date.UTC(2026, 0, 6)).toISOString(),
  }
  doc.annotations.push(created)
  return created
}

export function removeAnnotation(docId: string, annotationId: string): boolean {
  const doc = findDoc(docId)
  if (!doc) return false
  const before = doc.annotations.length
  doc.annotations = doc.annotations.filter((a) => a.id !== annotationId)
  return doc.annotations.length < before
}

/* -------------------------------------------------------------------- jobs */

const jobs = new Map<string, Job>()
let jobCounter = 0

export function createJob(
  kind: JobKind,
  documentId: string,
  documentName: string,
  executor: 'server' | 'worker',
): Job {
  const job: Job = {
    id: `job-${++jobCounter}`,
    kind,
    documentId,
    documentName,
    state: 'queued',
    progress: 0,
    message: 'Queued',
    startedAt: jobCounter, // logical clock; avoids Date.now() in fixtures
    executor,
  }
  jobs.set(job.id, job)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  const next = { ...job, ...patch }
  jobs.set(id, next)
  return next
}

export function documentHistory(docId: string): { version: string; note: string }[] {
  return findDoc(docId)?.history ?? []
}
