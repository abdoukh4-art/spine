import {
  CLOSED_ALERT_STATUSES,
  isAllowedAlertTransition,
  type AlertStatus,
} from '@spine/shared-schema';

/**
 * Alert lifecycle rules (ADR-0036), as a pure function the use case consults before writing.
 *
 *     new → triaged → in_progress → resolved | false_positive   (any open state may close directly)
 *     resolved | false_positive → in_progress                   (reopen)
 *
 * `resolvedAt` is the instant of the **first** close and is never moved or cleared afterwards,
 * not by a reopen and not by a later re-close. That is exactly ADR-0026's definition
 * ("the first transition to resolved or false_positive"), so MTTR can't be gamed by reopening
 * and re-closing an old alert.
 */
export interface LifecycleState {
  status: AlertStatus;
  /** ISO timestamp of the first close, or null if the alert was never closed. */
  resolvedAt: string | null;
}

export type StatusChangePlan =
  /** Already in the requested status: nothing to write, no event (idempotent retries). */
  | { kind: 'noop' }
  /** Not allowed by the state machine (maps to HTTP 409). */
  | { kind: 'illegal'; from: AlertStatus; to: AlertStatus }
  | {
      kind: 'change';
      from: AlertStatus;
      to: AlertStatus;
      resolvedAt: string | null;
      reopens: boolean;
    };

/** True for `resolved` and `false_positive`. */
export function isClosed(status: AlertStatus): boolean {
  return CLOSED_ALERT_STATUSES.includes(status);
}

/** Decides what a status change means for an alert in `current` state, at instant `at`. */
export function planStatusChange(
  current: LifecycleState,
  to: AlertStatus,
  at: string,
): StatusChangePlan {
  const from = current.status;
  if (from === to) return { kind: 'noop' };
  if (!isAllowedAlertTransition(from, to)) return { kind: 'illegal', from, to };
  const resolvedAt = isClosed(to) && current.resolvedAt === null ? at : current.resolvedAt;
  return { kind: 'change', from, to, resolvedAt, reopens: isClosed(from) && !isClosed(to) };
}
