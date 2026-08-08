/**
 * AUTHORIZATION POLICY — SERVER SIDE ONLY.
 *
 * This module lives under src/server/ and is imported exclusively by the mock
 * API handlers. No component imports it. That boundary is the point: in
 * production this code is a service, and the browser bundle contains none of it.
 *
 * The client receives only the *outcome* (a `Decision` per capability per
 * record) and renders it. It never evaluates policy, so a tampered client can
 * at most reveal a button that the API will then reject with 403.
 */

import type {
  Capability,
  Claim,
  Decision,
  RecordPermissions,
  RoleId,
  Session,
} from '../domain/types'

/** Capabilities held in principle, per role. */
const ROLE_CAPABILITIES: Record<RoleId, Capability[]> = {
  intake_clerk: ['claim:view', 'claim:edit', 'document:view', 'document:comment'],
  claims_adjuster: [
    'claim:view',
    'claim:edit',
    'claim:assign',
    'document:view',
    'document:comment',
    'document:annotate',
    'document:split',
  ],
  senior_adjuster: [
    'claim:view',
    'claim:edit',
    'claim:assign',
    'claim:export',
    'document:view',
    'document:comment',
    'document:annotate',
    'document:split',
    'document:merge',
  ],
  supervisor: [
    'claim:view',
    'claim:edit',
    'claim:delete',
    'claim:assign',
    'claim:export',
    'document:view',
    'document:comment',
    'document:annotate',
    'document:split',
    'document:merge',
    'document:delete',
  ],
  // Deliberately read-only. Every mutating affordance is hidden, not disabled:
  // an auditor should not be taught about actions they will never hold.
  auditor: ['claim:view', 'claim:export', 'document:view'],
}

export const ROLES: { id: RoleId; label: string; jobTitle: string }[] = [
  { id: 'intake_clerk', label: 'Intake Clerk', jobTitle: 'Claims Intake' },
  { id: 'claims_adjuster', label: 'Claims Adjuster', jobTitle: 'Adjudication' },
  { id: 'senior_adjuster', label: 'Senior Adjuster', jobTitle: 'Adjudication' },
  { id: 'supervisor', label: 'Supervisor', jobTitle: 'Claims Operations' },
  { id: 'auditor', label: 'Auditor (read-only)', jobTitle: 'Internal Audit' },
]

export function capabilitiesFor(role: RoleId): Capability[] {
  return ROLE_CAPABILITIES[role]
}

/**
 * Row-level visibility. Applied in the query itself, BEFORE pagination, so the
 * client can never receive a record it is not entitled to see.
 *
 * Intake clerks see only what arrived through their own intake channels;
 * adjusters see their region. Supervisors and auditors see everything.
 */
export function rowVisibilityPredicate(
  session: Session,
): (claim: Claim) => boolean {
  switch (session.role) {
    case 'intake_clerk':
      return (c) => c.channel === 'email' || c.channel === 'sftp' || c.channel === 'fax'
    case 'claims_adjuster':
      return (c) => c.region === session.region
    case 'senior_adjuster':
      return (c) => c.region === session.region
    case 'supervisor':
    case 'auditor':
      return () => true
  }
}

const ALLOW: Decision = { allowed: true }

function deny(reason: string): Decision {
  return { allowed: false, reason }
}

/** The role never holds this capability → hide the affordance entirely. */
function hide(reason: string): Decision {
  return { allowed: false, reason, hidden: true }
}

/**
 * Evaluate every claim-scoped capability for one record.
 *
 * Two distinct kinds of denial, and the difference drives the UI:
 *   - `hidden: true`  the role lacks the capability outright  → don't render it
 *   - `hidden: false` the role has it, but not on this record → render disabled
 *                                                                with the reason
 */
export function decideForClaim(
  session: Session,
  claim: Claim,
): RecordPermissions {
  const held = new Set(ROLE_CAPABILITIES[session.role])
  const perms: RecordPermissions = {}

  const evaluate = (cap: Capability, recordRule: () => Decision): void => {
    if (!held.has(cap)) {
      perms[cap] = hide(`Your role (${session.roleLabel}) does not include this action.`)
      return
    }
    perms[cap] = recordRule()
  }

  evaluate('claim:view', () => ALLOW)

  evaluate('claim:edit', () => {
    // Terminal claims are immutable — an audit-trail requirement, not a UI whim.
    if (claim.status === 'closed') return deny('Closed claims cannot be edited.')
    if (claim.status === 'approved' || claim.status === 'denied') {
      return session.role === 'supervisor'
        ? ALLOW
        : deny('Adjudicated claims can only be amended by a Supervisor.')
    }
    // An adjuster may not edit a claim assigned to someone else.
    if (
      session.role === 'claims_adjuster' &&
      claim.assigneeId !== null &&
      claim.assigneeId !== session.userId
    ) {
      return deny(`Assigned to ${claim.assigneeName}. Reassign it to yourself to edit.`)
    }
    return ALLOW
  })

  evaluate('claim:delete', () => {
    if (claim.status !== 'intake') {
      return deny('Only claims still in intake can be deleted. Close it instead.')
    }
    if (claim.documentCount > 0) {
      return deny(
        `${claim.documentCount} document(s) attached. Documents must be detached first.`,
      )
    }
    return ALLOW
  })

  evaluate('claim:assign', () => {
    if (claim.status === 'closed') return deny('Closed claims cannot be reassigned.')
    if (claim.priority === 'critical' && session.role === 'claims_adjuster') {
      return deny('Critical claims are assigned by a Senior Adjuster or Supervisor.')
    }
    return ALLOW
  })

  evaluate('claim:export', () => ALLOW)

  return perms
}

/** Document-scoped capabilities. Same two-kinds-of-denial model. */
export function decideForDocument(
  session: Session,
  doc: { derivativesReady: boolean; pageCount: number; byteSize: number },
): RecordPermissions {
  const held = new Set(ROLE_CAPABILITIES[session.role])
  const perms: RecordPermissions = {}

  const evaluate = (cap: Capability, recordRule: () => Decision): void => {
    if (!held.has(cap)) {
      perms[cap] = hide(`Your role (${session.roleLabel}) does not include this action.`)
      return
    }
    perms[cap] = recordRule()
  }

  evaluate('document:view', () => ALLOW)
  evaluate('document:comment', () => ALLOW)
  evaluate('document:annotate', () => ALLOW)

  evaluate('document:split', () => {
    if (!doc.derivativesReady) {
      return deny('Still being processed. Splitting is available once page indexing completes.')
    }
    if (doc.pageCount < 2) return deny('A single-page document cannot be split.')
    return ALLOW
  })

  evaluate('document:merge', () => {
    if (!doc.derivativesReady) {
      return deny('Still being processed. Merging is available once page indexing completes.')
    }
    return ALLOW
  })

  evaluate('document:delete', () => ALLOW)

  return perms
}

/**
 * The enforcement gate. Every mutating handler calls this BEFORE doing work.
 * The UI's disabled state is a courtesy; this is the actual control.
 */
export function assertAllowed(
  perms: RecordPermissions,
  cap: Capability,
): { ok: true } | { ok: false; status: 403; reason: string } {
  const decision = perms[cap]
  if (decision?.allowed) return { ok: true }
  return {
    ok: false,
    status: 403,
    reason: decision?.reason ?? 'Not permitted.',
  }
}
