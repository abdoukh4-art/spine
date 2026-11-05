import { roleSatisfies, type ApprovalStatus, type Role } from '@spine/shared-schema';

/**
 * Approval gate rules (human-in-the-loop, ADR-0013). Kept pure so every rule has a
 * millisecond unit test; the application layer turns the verdicts into HTTP problems.
 */

/** The parts of an approval the rules look at. */
export interface ApprovalFacts {
  status: ApprovalStatus;
  approverRole: Role;
  expiresAt: string;
}

/** Why a decision is not allowed, or `null` when it is. */
export type DecisionProblem =
  | { kind: 'already_decided'; status: ApprovalStatus }
  | { kind: 'expired' }
  | { kind: 'insufficient_role'; required: Role }
  | { kind: 'self_approval' };

/** Who wants to decide. */
export interface DeciderFacts {
  id: string;
  role: Role;
}

/**
 * Checks whether `actor` may decide this approval at `now`.
 * Order matters: a decided approval reports "already decided" even if it has also expired.
 *
 * **Four eyes** (ADR-0096, security review F7): whoever started the run manually can't approve
 * its actions. That's what keeps an AI analyst, which may *propose* runs, from also approving
 * them. Automatic runs (`runStartedBy` null) were started by no one, so any approver may decide.
 */
export function decisionProblem(
  approval: ApprovalFacts,
  actor: DeciderFacts,
  now: Date,
  runStartedBy: string | null,
): DecisionProblem | null {
  if (approval.status !== 'pending') return { kind: 'already_decided', status: approval.status };
  if (now.getTime() >= Date.parse(approval.expiresAt)) return { kind: 'expired' };
  if (!roleSatisfies(actor.role, approval.approverRole)) {
    return { kind: 'insufficient_role', required: approval.approverRole };
  }
  if (runStartedBy !== null && runStartedBy === actor.id) return { kind: 'self_approval' };
  return null;
}

/** The run event an expired approval turns into, per the step's `onTimeout`. */
export function timeoutOutcome(
  onTimeout: 'approve' | 'reject',
): 'approval.granted' | 'approval.rejected' {
  return onTimeout === 'approve' ? 'approval.granted' : 'approval.rejected';
}

/** `expiresAt` for an approval requested at `requestedAt`. */
export function approvalDeadline(requestedAt: Date, expiresInMs: number): string {
  return new Date(requestedAt.getTime() + expiresInMs).toISOString();
}
