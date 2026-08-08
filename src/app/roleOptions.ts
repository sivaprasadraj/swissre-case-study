/**
 * Role labels for the prototype's role switcher.
 *
 * Duplicated from the server's ROLES rather than imported, deliberately: the
 * client must not import anything from src/server/, because in production that
 * code is not in the browser bundle at all. Keeping the boundary honest here
 * means the import graph tells the truth about what ships.
 */

import type { RoleId } from '../domain/types'

export const ROLE_OPTIONS: { id: RoleId; label: string }[] = [
  { id: 'intake_clerk', label: 'Intake Clerk' },
  { id: 'claims_adjuster', label: 'Claims Adjuster' },
  { id: 'senior_adjuster', label: 'Senior Adjuster' },
  { id: 'supervisor', label: 'Supervisor' },
  { id: 'auditor', label: 'Auditor (read-only)' },
]
