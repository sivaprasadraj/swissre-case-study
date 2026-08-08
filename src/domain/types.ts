/**
 * Shared domain types. These mirror the API contract the BFF would expose,
 * so swapping MSW for a real backend changes no component code.
 */

export type ClaimStatus =
  | 'intake'
  | 'triage'
  | 'in_review'
  | 'pending_info'
  | 'approved'
  | 'denied'
  | 'closed'

export type ClaimChannel = 'email' | 'sftp' | 'portal' | 'api' | 'fax'

export type ClaimPriority = 'low' | 'medium' | 'high' | 'critical'

export type SlaState = 'on_track' | 'at_risk' | 'breached'

/** The capabilities a caller may hold. Named after actions, not roles. */
export type Capability =
  | 'claim:view'
  | 'claim:edit'
  | 'claim:delete'
  | 'claim:assign'
  | 'claim:export'
  | 'document:view'
  | 'document:comment'
  | 'document:annotate'
  | 'document:split'
  | 'document:merge'
  | 'document:delete'

export type RoleId =
  | 'intake_clerk'
  | 'claims_adjuster'
  | 'senior_adjuster'
  | 'supervisor'
  | 'auditor'

/**
 * Per-record authorization decision, computed server-side and attached to each
 * row. The client renders this; it never derives it.
 *
 * `allowed` drives enabled/disabled. `reason` is what we show in the tooltip
 * when a capability exists for the role but is denied on THIS record — that
 * distinction is what makes disabled states discoverable rather than confusing.
 */
export interface Decision {
  allowed: boolean
  /** Absent when allowed. Human-readable, safe to display. */
  reason?: string
  /**
   * True when the role never holds this capability at all, so the affordance
   * should be hidden rather than disabled. See design doc: show vs hide vs disable.
   */
  hidden?: boolean
}

export type RecordPermissions = Partial<Record<Capability, Decision>>

export interface Claim {
  id: string
  claimNumber: string
  claimantName: string
  policyNumber: string
  cedent: string
  treaty: string
  lineOfBusiness: string
  status: ClaimStatus
  channel: ClaimChannel
  priority: ClaimPriority
  slaState: SlaState
  /** ISO date string. */
  receivedAt: string
  /** ISO date string; SLA clock target. */
  dueAt: string
  incurredAmount: number
  currency: string
  assigneeId: string | null
  assigneeName: string | null
  documentCount: number
  /** Total bytes across all attached documents. */
  documentBytes: number
  region: string
  /** Server-computed authorization for THIS record and THIS caller. */
  permissions: RecordPermissions
}

export interface Session {
  userId: string
  displayName: string
  jobTitle: string
  role: RoleId
  roleLabel: string
  /** Capabilities held in principle. Per-record decisions still apply. */
  capabilities: Capability[]
  region: string
}

/* ---------------------------------------------------------------- queries */

export type SortDirection = 'asc' | 'desc'

export interface ClaimSort {
  field: keyof Claim
  direction: SortDirection
}

export interface ClaimFilters {
  q?: string
  status?: ClaimStatus[]
  channel?: ClaimChannel[]
  priority?: ClaimPriority[]
  slaState?: SlaState[]
  assignee?: 'me' | 'unassigned' | 'any'
}

export interface ClaimQuery extends ClaimFilters {
  sort: ClaimSort
  /** Opaque keyset cursor. Absent means "first page". */
  cursor?: string
  limit: number
}

export interface Facet<T extends string = string> {
  value: T
  label: string
  count: number
}

export interface ClaimQueryResult {
  rows: Claim[]
  /** Keyset cursors. Null when there is no page in that direction. */
  nextCursor: string | null
  prevCursor: string | null
  /**
   * Approximate; the API deliberately does NOT return an exact COUNT(*) over a
   * filtered 20k+ set. See design doc: the approximate-count strategy.
   */
  approximateTotal: number
  exact: boolean
  /** 1-based, for the paging affordance. */
  page: number
  pageCount: number
  facets: {
    status: Facet<ClaimStatus>[]
    channel: Facet<ClaimChannel>[]
    priority: Facet<ClaimPriority>[]
    slaState: Facet<SlaState>[]
  }
  /** Server processing time, surfaced in the UI to make the cost visible. */
  tookMs: number
}

/* -------------------------------------------------------------- documents */

export interface DocumentSummary {
  id: string
  claimId: string
  fileName: string
  mimeType: string
  byteSize: number
  pageCount: number
  channel: ClaimChannel
  receivedAt: string
  /** Immutable version id. Operations publish a NEW version. */
  version: string
  /** True once the ingest pipeline has produced page derivatives. */
  derivativesReady: boolean
  ocrStatus: 'none' | 'pending' | 'complete' | 'failed'
}

/**
 * The page-level manifest. This is the artefact that makes a 1 GB document
 * tractable: the client fetches this (a few KB) instead of the bytes.
 */
export interface DocumentManifest {
  documentId: string
  version: string
  fileName: string
  byteSize: number
  pageCount: number
  /** ETag for optimistic concurrency on mutating operations. */
  etag: string
  pages: PageDescriptor[]
  outline: OutlineNode[]
}

export interface PageDescriptor {
  /**
   * Stable identity that survives split/merge. Annotations anchor to this,
   * NOT to the ordinal index. See design doc: annotation anchoring.
   */
  pageId: string
  /** 1-based position in the CURRENT version. Changes when pages move. */
  index: number
  widthPt: number
  heightPt: number
  rotation: 0 | 90 | 180 | 270
  /** Byte range of this page's content within the source file. */
  byteRange: [number, number]
  thumbnailUrl: string
  /** True when a text layer exists (born-digital or OCR complete). */
  hasTextLayer: boolean
}

export interface OutlineNode {
  title: string
  pageIndex: number
  children?: OutlineNode[]
}

export interface PageComment {
  id: string
  documentId: string
  /** Anchored to page identity, not ordinal. */
  pageId: string
  authorId: string
  authorName: string
  body: string
  createdAt: string
  resolved: boolean
  /** Normalized 0..1 coordinates, so the anchor survives zoom and re-render. */
  anchor?: { x: number; y: number }
}

export interface Annotation {
  id: string
  documentId: string
  pageId: string
  kind: 'highlight' | 'redaction' | 'note'
  /** Normalized 0..1 rect. */
  rect: { x: number; y: number; w: number; h: number }
  color: string
  authorId: string
  authorName: string
  createdAt: string
  note?: string
}

/* ------------------------------------------------------------------- jobs */

export type JobKind = 'split' | 'merge' | 'delete_pages' | 'export' | 'ocr'

export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface Job {
  id: string
  kind: JobKind
  documentId: string
  documentName: string
  state: JobState
  /** 0..100 */
  progress: number
  message: string
  error?: string
  /** Set on success; the new immutable version produced by the operation. */
  resultVersion?: string
  startedAt: number
  endedAt?: number
  /** Which inputs failed, for partial-failure reporting on merge. */
  failedInputs?: string[]
  /** Where the work ran. Demonstrates the client/server split. */
  executor: 'server' | 'worker'
}
