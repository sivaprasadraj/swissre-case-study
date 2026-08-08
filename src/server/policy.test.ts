/**
 * RBAC MATRIX TESTS.
 *
 * The whole role × capability matrix is asserted as a parameterized table. This
 * is the test that matters most in an RBAC system: it's the one that catches a
 * policy change silently widening access, and it's the one most codebases don't
 * have because writing it by hand per case is tedious.
 *
 * Note what is asserted: not just allowed/denied, but allowed / disabled /
 * HIDDEN. The three-way distinction is the contract the UI depends on.
 */

import { describe, expect, it } from 'vitest'
import type { Capability, Claim, RoleId, Session } from '../domain/types'
import { capabilitiesFor, decideForClaim, decideForDocument, rowVisibilityPredicate } from './policy'
import { getDataset } from './dataset'

function sessionFor(role: RoleId): Session {
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

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'clm-100000',
    claimNumber: 'CLM-2026-100000',
    claimantName: 'Jane Cooper',
    policyNumber: 'POL-1234567',
    cedent: 'Meridian Mutual',
    treaty: 'QS-2019-004',
    lineOfBusiness: 'Individual Life',
    status: 'triage',
    channel: 'email',
    priority: 'medium',
    slaState: 'on_track',
    receivedAt: '2025-11-14T00:00:00.000Z',
    dueAt: '2025-12-05T00:00:00.000Z',
    incurredAmount: 42_000,
    currency: 'USD',
    assigneeId: 'u-1041',
    assigneeName: 'Test User',
    documentCount: 0,
    documentBytes: 0,
    region: 'EMEA',
    permissions: {},
    ...overrides,
  }
}

type Outcome = 'allowed' | 'disabled' | 'hidden'

function outcome(role: RoleId, cap: Capability, c: Claim): Outcome {
  const d = decideForClaim(sessionFor(role), c)[cap]
  if (!d) return 'hidden'
  if (d.allowed) return 'allowed'
  return d.hidden ? 'hidden' : 'disabled'
}

describe('RBAC — role × capability matrix', () => {
  /**
   * Baseline: an open, self-assigned, document-free claim. Any denial here is a
   * property of the ROLE, not of the record.
   */
  const cases: { role: RoleId; cap: Capability; expected: Outcome }[] = [
    // Intake clerk: can create/edit intake, cannot assign, delete or export.
    { role: 'intake_clerk', cap: 'claim:view', expected: 'allowed' },
    { role: 'intake_clerk', cap: 'claim:edit', expected: 'allowed' },
    { role: 'intake_clerk', cap: 'claim:assign', expected: 'hidden' },
    { role: 'intake_clerk', cap: 'claim:delete', expected: 'hidden' },
    { role: 'intake_clerk', cap: 'claim:export', expected: 'hidden' },

    // Claims adjuster: the everyday role.
    { role: 'claims_adjuster', cap: 'claim:view', expected: 'allowed' },
    { role: 'claims_adjuster', cap: 'claim:edit', expected: 'allowed' },
    { role: 'claims_adjuster', cap: 'claim:assign', expected: 'allowed' },
    { role: 'claims_adjuster', cap: 'claim:delete', expected: 'hidden' },
    { role: 'claims_adjuster', cap: 'claim:export', expected: 'hidden' },

    // Senior adjuster: adds export and merge authority.
    { role: 'senior_adjuster', cap: 'claim:export', expected: 'allowed' },
    { role: 'senior_adjuster', cap: 'claim:delete', expected: 'hidden' },

    // Supervisor: full authority.
    { role: 'supervisor', cap: 'claim:delete', expected: 'disabled' }, // status is triage, not intake
    { role: 'supervisor', cap: 'claim:assign', expected: 'allowed' },
    { role: 'supervisor', cap: 'claim:export', expected: 'allowed' },

    // Auditor: read-only. Every mutation is HIDDEN, not disabled — an auditor
    // should never be shown an action they will never hold.
    { role: 'auditor', cap: 'claim:view', expected: 'allowed' },
    { role: 'auditor', cap: 'claim:export', expected: 'allowed' },
    { role: 'auditor', cap: 'claim:edit', expected: 'hidden' },
    { role: 'auditor', cap: 'claim:assign', expected: 'hidden' },
    { role: 'auditor', cap: 'claim:delete', expected: 'hidden' },
  ]

  it.each(cases)('$role → $cap is $expected', ({ role, cap, expected }) => {
    expect(outcome(role, cap, claim())).toBe(expected)
  })
})

describe('RBAC — record-level rules produce DISABLED, not hidden', () => {
  it('closed claims cannot be edited, and the reason is displayable', () => {
    const d = decideForClaim(sessionFor('supervisor'), claim({ status: 'closed' }))['claim:edit']
    expect(d?.allowed).toBe(false)
    expect(d?.hidden).toBeFalsy()
    expect(d?.reason).toMatch(/closed/i)
  })

  it('an adjuster cannot edit a claim assigned to someone else', () => {
    const d = decideForClaim(
      sessionFor('claims_adjuster'),
      claim({ assigneeId: 'u-9999', assigneeName: 'Someone Else' }),
    )['claim:edit']
    expect(d?.allowed).toBe(false)
    expect(d?.hidden).toBeFalsy()
    expect(d?.reason).toContain('Someone Else')
  })

  it('a supervisor CAN amend an adjudicated claim where an adjuster cannot', () => {
    expect(outcome('supervisor', 'claim:edit', claim({ status: 'approved' }))).toBe('allowed')
    expect(outcome('claims_adjuster', 'claim:edit', claim({ status: 'approved' }))).toBe('disabled')
  })

  it('critical claims cannot be assigned by a regular adjuster', () => {
    expect(outcome('claims_adjuster', 'claim:assign', claim({ priority: 'critical' }))).toBe('disabled')
    expect(outcome('senior_adjuster', 'claim:assign', claim({ priority: 'critical' }))).toBe('allowed')
  })

  it('a claim with attached documents cannot be deleted', () => {
    const d = decideForClaim(
      sessionFor('supervisor'),
      claim({ status: 'intake', documentCount: 3 }),
    )['claim:delete']
    expect(d?.allowed).toBe(false)
    expect(d?.reason).toContain('3 document')
  })

  it('an intake-status, document-free claim CAN be deleted by a supervisor', () => {
    expect(outcome('supervisor', 'claim:delete', claim({ status: 'intake', documentCount: 0 }))).toBe(
      'allowed',
    )
  })
})

describe('RBAC — document capabilities gate on pipeline readiness', () => {
  const ready = { derivativesReady: true, pageCount: 40, byteSize: 10_000_000 }
  const notReady = { derivativesReady: false, pageCount: 40, byteSize: 900_000_000 }

  it('split is disabled while derivatives are still being produced', () => {
    const d = decideForDocument(sessionFor('senior_adjuster'), notReady)['document:split']
    expect(d?.allowed).toBe(false)
    expect(d?.hidden).toBeFalsy()
    expect(d?.reason).toMatch(/processed|indexing/i)
  })

  it('split is allowed once the page index exists', () => {
    expect(decideForDocument(sessionFor('senior_adjuster'), ready)['document:split']?.allowed).toBe(true)
  })

  it('a single-page document cannot be split', () => {
    const d = decideForDocument(sessionFor('senior_adjuster'), {
      ...ready,
      pageCount: 1,
    })['document:split']
    expect(d?.allowed).toBe(false)
    expect(d?.reason).toMatch(/single-page/i)
  })

  it('merge is held entirely by senior roles and hidden from adjusters', () => {
    expect(decideForDocument(sessionFor('claims_adjuster'), ready)['document:merge']?.hidden).toBe(true)
    expect(decideForDocument(sessionFor('senior_adjuster'), ready)['document:merge']?.allowed).toBe(true)
  })

  it('an auditor can view but never annotate or comment', () => {
    const perms = decideForDocument(sessionFor('auditor'), ready)
    expect(perms['document:view']?.allowed).toBe(true)
    expect(perms['document:annotate']?.hidden).toBe(true)
    expect(perms['document:comment']?.hidden).toBe(true)
    expect(perms['document:delete']?.hidden).toBe(true)
  })
})

describe('row-level visibility is applied before pagination', () => {
  const all = getDataset()

  it('an intake clerk sees only inbound intake channels', () => {
    const visible = all.filter(rowVisibilityPredicate(sessionFor('intake_clerk')))
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(all.length)
    expect(visible.every((c) => ['email', 'sftp', 'fax'].includes(c.channel))).toBe(true)
  })

  it('an adjuster sees only their own region', () => {
    const visible = all.filter(rowVisibilityPredicate(sessionFor('claims_adjuster')))
    expect(visible.every((c) => c.region === 'EMEA')).toBe(true)
    expect(visible.length).toBeLessThan(all.length)
  })

  it('a supervisor and an auditor both see the full portfolio', () => {
    expect(all.filter(rowVisibilityPredicate(sessionFor('supervisor'))).length).toBe(all.length)
    expect(all.filter(rowVisibilityPredicate(sessionFor('auditor'))).length).toBe(all.length)
  })
})

describe('fail-closed behaviour', () => {
  it('every capability a role does not hold is marked hidden with a reason', () => {
    const roles: RoleId[] = ['intake_clerk', 'claims_adjuster', 'senior_adjuster', 'supervisor', 'auditor']
    const claimCaps: Capability[] = [
      'claim:view',
      'claim:edit',
      'claim:delete',
      'claim:assign',
      'claim:export',
    ]

    for (const role of roles) {
      const held = new Set(capabilitiesFor(role))
      const perms = decideForClaim(sessionFor(role), claim())
      for (const cap of claimCaps) {
        const d = perms[cap]
        expect(d, `${role}/${cap} must have an explicit decision`).toBeDefined()
        if (!held.has(cap)) {
          expect(d?.hidden, `${role}/${cap} not held → must be hidden`).toBe(true)
          expect(d?.reason).toBeTruthy()
        }
      }
    }
  })
})
