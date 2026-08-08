/**
 * Formatters.
 *
 * Intl objects are constructed ONCE at module scope, not per render. Building an
 * Intl.NumberFormat is surprisingly expensive (~10-40µs); doing it inside a cell
 * renderer for 100 visible rows × 12 columns on every scroll frame is a
 * measurable source of dropped frames.
 */

import type { ClaimPriority, ClaimStatus, SlaState } from '../../domain/types'

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const currencyCache = new Map<string, Intl.NumberFormat>()

function currencyFormatter(code: string): Intl.NumberFormat {
  let f = currencyCache.get(code)
  if (!f) {
    f = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    })
    currencyCache.set(code, f)
  }
  return f
}

const compactFmt = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 })
const plainFmt = new Intl.NumberFormat('en-GB')

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso))
}

export function formatMoney(amount: number, currency: string): string {
  return currencyFormatter(currency).format(amount)
}

export function formatCount(n: number): string {
  return plainFmt.format(n)
}

export function formatApprox(n: number, exact: boolean): string {
  return exact ? plainFmt.format(n) : `~${compactFmt.format(n)}`
}

/** Human-readable byte size. Uses binary units, labelled decimally as users expect. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Days until/since the SLA target, relative to the dataset's fixed epoch.
 * Using a fixed reference keeps the fixture stable rather than drifting daily.
 */
const NOW = Date.UTC(2026, 0, 5)

export function slaDelta(dueAtIso: string): { days: number; text: string } {
  const days = Math.round((new Date(dueAtIso).getTime() - NOW) / 86_400_000)
  if (days < 0) return { days, text: `${Math.abs(days)}d overdue` }
  if (days === 0) return { days, text: 'due today' }
  return { days, text: `${days}d left` }
}

export const STATUS_TONE: Record<ClaimStatus, 'success' | 'danger' | 'warning' | 'neutral' | 'brand'> = {
  intake: 'neutral',
  triage: 'brand',
  in_review: 'brand',
  pending_info: 'warning',
  approved: 'success',
  denied: 'danger',
  closed: 'neutral',
}

export const PRIORITY_TONE: Record<ClaimPriority, 'success' | 'danger' | 'warning' | 'neutral' | 'brand'> = {
  low: 'neutral',
  medium: 'brand',
  high: 'warning',
  critical: 'danger',
}

export const SLA_TONE: Record<SlaState, 'success' | 'danger' | 'warning'> = {
  on_track: 'success',
  at_risk: 'warning',
  breached: 'danger',
}

export const STATUS_LABEL: Record<ClaimStatus, string> = {
  intake: 'Intake',
  triage: 'Triage',
  in_review: 'In Review',
  pending_info: 'Pending Info',
  approved: 'Approved',
  denied: 'Denied',
  closed: 'Closed',
}

export const CHANNEL_LABEL: Record<string, string> = {
  email: 'Email',
  sftp: 'SFTP',
  portal: 'Portal',
  api: 'API',
  fax: 'Fax',
}

export const PRIORITY_LABEL: Record<ClaimPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
}

export const SLA_LABEL: Record<SlaState, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  breached: 'Breached',
}
