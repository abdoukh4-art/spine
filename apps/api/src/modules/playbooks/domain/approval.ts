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
  | { kind: 'insufficient_role'; required: Role };

/**
 * Checks whether `actorRole` may decide this approval at `now`.
 * Order matters: a decided approval reports "already decided" even if it has also expired.
 */
export function decisionProblem(
  approval: ApprovalFacts,
  actorRole: Role,
  now: Date,
): DecisionProblem | null {
  if (approval.status !== 'pending') return { kind: 'already_decided', status: approval.status };
  if (now.getTime() >= Date.parse(approval.expiresAt)) return { kind: 'expired' };
  if (!roleSatisfies(actorRole, approval.approverRole)) {
    return { kind: 'insufficient_role', required: approval.approverRole };
  }
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
