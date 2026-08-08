/**
 * Deterministic 20,000-record claims dataset.
 *
 * Seeded PRNG rather than Math.random so the dataset is byte-identical across
 * reloads and across machines — which is what makes screenshots, tests and
 * cursor-based paging reproducible.
 */

import type {
  Claim,
  ClaimChannel,
  ClaimPriority,
  ClaimStatus,
  SlaState,
} from '../domain/types'

export const RECORD_COUNT = 20_000

/** mulberry32 — small, fast, good enough distribution for fixtures. */
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

const FIRST_NAMES = [
  'Jane', 'Floyd', 'Ronald', 'Marvin', 'Jerome', 'Kathryn', 'Jacob', 'Kristin',
  'Cameron', 'Esther', 'Darrell', 'Bessie', 'Wade', 'Annette', 'Guy', 'Nathan',
  'Priya', 'Wei', 'Ana', 'Tomas', 'Ingrid', 'Yusuf', 'Mei', 'Olu', 'Sofia',
  'Lars', 'Hana', 'Diego', 'Fatima', 'Noah', 'Aiko', 'Pieter', 'Rosa', 'Kwame',
]
const LAST_NAMES = [
  'Cooper', 'Miles', 'Richards', 'McKinney', 'Bell', 'Murphy', 'Jones', 'Watson',
  'Williamson', 'Howard', 'Steward', 'Cooper', 'Warren', 'Black', 'Hawkins',
  'Nguyen', 'Okafor', 'Silva', 'Muller', 'Larsen', 'Tanaka', 'Rossi', 'Haddad',
  'Novak', 'Andersson', 'Costa', 'Fischer', 'Ivanov', 'Sharma', 'Chen',
]

/** Ceding insurers — the counterparties a reinsurer actually deals with. */
const CEDENTS = [
  'Meridian Mutual', 'Northwind Assurance', 'Atlas Life', 'Cascade Health',
  'Pinnacle Indemnity', 'Harbour Life', 'Solstice Insurance', 'Redwood Mutual',
  'Kestrel Assurance', 'Beacon Life', 'Aurora Health', 'Granite Indemnity',
]

const TREATIES = [
  'QS-2019-004', 'SL-2021-011', 'XL-2020-007', 'QS-2022-002', 'SL-2018-019',
  'XL-2023-001', 'QS-2020-015', 'SL-2023-008', 'XL-2021-012', 'QS-2024-003',
]

const LINES_OF_BUSINESS = [
  'Individual Life', 'Group Life', 'Critical Illness', 'Disability Income',
  'Long-Term Care', 'Medical Expense', 'Accidental Death',
]

const REGIONS = ['EMEA', 'AMER', 'APAC']

const ADJUSTERS = [
  { id: 'u-1041', name: 'Evano Rijkaard' },
  { id: 'u-2277', name: 'Amara Diallo' },
  { id: 'u-3390', name: 'Henrik Solberg' },
  { id: 'u-4102', name: 'Lucia Ferrari' },
  { id: 'u-5518', name: 'Rajesh Iyer' },
  { id: 'u-6634', name: 'Grace Okonjo' },
  { id: 'u-7720', name: 'Tobias Klein' },
]

const STATUSES: ClaimStatus[] = [
  'intake', 'triage', 'in_review', 'pending_info', 'approved', 'denied', 'closed',
]
// Weighted so the workqueue looks like a real one: most claims mid-pipeline.
const STATUS_WEIGHTS = [12, 18, 26, 14, 12, 8, 10]

const CHANNELS: ClaimChannel[] = ['email', 'sftp', 'portal', 'api', 'fax']
const CHANNEL_WEIGHTS = [34, 28, 20, 14, 4]

const PRIORITIES: ClaimPriority[] = ['low', 'medium', 'high', 'critical']
const PRIORITY_WEIGHTS = [30, 40, 22, 8]

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF', 'JPY']

function weightedPick<T>(rng: () => number, items: T[], weights: number[]): T {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!
    if (r <= 0) return items[i]!
  }
  return items[items.length - 1]!
}

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)]!
}

/** Fixed epoch — no Date.now(), so the fixture never drifts. */
const EPOCH = Date.UTC(2026, 0, 5)
const DAY_MS = 86_400_000

/**
 * Built once, lazily, and cached. 20k records is ~8 MB of objects; generating
 * it per request would swamp the very thing we're trying to measure.
 */
let cache: Claim[] | null = null

export function getDataset(): Claim[] {
  if (cache) return cache

  const rng = makeRng(0xc1a1_0042)
  const rows: Claim[] = new Array(RECORD_COUNT)

  for (let i = 0; i < RECORD_COUNT; i++) {
    const status = weightedPick(rng, STATUSES, STATUS_WEIGHTS)
    const channel = weightedPick(rng, CHANNELS, CHANNEL_WEIGHTS)
    const priority = weightedPick(rng, PRIORITIES, PRIORITY_WEIGHTS)

    const receivedOffset = Math.floor(rng() * 240) // spread over ~8 months
    const receivedAt = EPOCH - receivedOffset * DAY_MS

    // SLA target depends on priority — critical claims get a tight clock.
    const slaDays = priority === 'critical' ? 3 : priority === 'high' ? 7 : 21
    const dueAt = receivedAt + slaDays * DAY_MS

    // Terminal claims are never "breached"; they're done.
    let slaState: SlaState
    if (status === 'closed' || status === 'approved' || status === 'denied') {
      slaState = 'on_track'
    } else {
      const remaining = (dueAt - EPOCH) / DAY_MS
      slaState = remaining < 0 ? 'breached' : remaining < 2 ? 'at_risk' : 'on_track'
    }

    // Unassigned is a real and important state — it drives the triage queue.
    const assigned = status === 'intake' ? rng() < 0.15 : rng() < 0.86
    const adjuster = assigned ? pick(rng, ADJUSTERS) : null

    const documentCount =
      status === 'intake' ? Math.floor(rng() * 3) : 1 + Math.floor(rng() * 8)

    // Realistic heavy-tail size distribution: most documents are modest, a few
    // are enormous. The p99 is what the architecture has to survive.
    let documentBytes = 0
    for (let d = 0; d < documentCount; d++) {
      const roll = rng()
      const bytes =
        roll > 0.985
          ? 620_000_000 + rng() * 400_000_000 // 620 MB - 1.02 GB
          : roll > 0.93
            ? 150_000_000 + rng() * 300_000_000 // 150 - 450 MB
            : roll > 0.7
              ? 8_000_000 + rng() * 60_000_000 // 8 - 68 MB
              : 120_000 + rng() * 4_000_000 // 120 KB - 4 MB
      documentBytes += Math.round(bytes)
    }

    const first = pick(rng, FIRST_NAMES)
    const last = pick(rng, LAST_NAMES)
    const seq = 100_000 + i

    rows[i] = {
      id: `clm-${seq}`,
      claimNumber: `CLM-2026-${seq}`,
      claimantName: `${first} ${last}`,
      policyNumber: `POL-${Math.floor(rng() * 9_000_000 + 1_000_000)}`,
      cedent: pick(rng, CEDENTS),
      treaty: pick(rng, TREATIES),
      lineOfBusiness: pick(rng, LINES_OF_BUSINESS),
      status,
      channel,
      priority,
      slaState,
      receivedAt: new Date(receivedAt).toISOString(),
      dueAt: new Date(dueAt).toISOString(),
      incurredAmount: Math.round((rng() * 2_400_000 + 1_500) * 100) / 100,
      currency: pick(rng, CURRENCIES),
      assigneeId: adjuster?.id ?? null,
      assigneeName: adjuster?.name ?? null,
      documentCount,
      documentBytes,
      region: pick(rng, REGIONS),
      permissions: {}, // filled per-request by the policy layer
    }
  }

  cache = rows
  return rows
}

export const KNOWN_ADJUSTERS = ADJUSTERS

export const STATUS_LABELS: Record<ClaimStatus, string> = {
  intake: 'Intake',
  triage: 'Triage',
  in_review: 'In Review',
  pending_info: 'Pending Info',
  approved: 'Approved',
  denied: 'Denied',
  closed: 'Closed',
}

export const CHANNEL_LABELS: Record<ClaimChannel, string> = {
  email: 'Email',
  sftp: 'SFTP',
  portal: 'Portal',
  api: 'API',
  fax: 'Fax',
}

export const PRIORITY_LABELS: Record<ClaimPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}

export const SLA_LABELS: Record<SlaState, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  breached: 'Breached',
}
