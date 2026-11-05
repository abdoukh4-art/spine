import type { RunEvent } from '@spine/shared-schema';
import type { TimelineItem } from '../../components';
import { formatDateTime } from '../../lib/format';

/** A run event in words: a short title, optional detail, and a tone for the timeline dot. */
export interface EventDescription {
  title: string;
  description?: string | undefined;
  tone: NonNullable<TimelineItem['tone']>;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;

/** Reads `obj[key]` when `obj` is a plain object (payloads nest, e.g. `output.taken`). */
const nested = (obj: unknown, key: string): unknown =>
  typeof obj === 'object' && obj !== null && !Array.isArray(obj)
    ? (obj as Record<string, unknown>)[key]
    : undefined;

/** `“comment”` when the decision carried a comment. */
const quoted = (value: unknown): string | undefined => {
  const text = str(value);
  return text ? `“${text}”` : undefined;
};

/**
 * Turns a run event (event-sourced log, ADR-0010) into a sentence an analyst can read.
 * Payloads are `Record<string, unknown>` in the contract, so every field is read defensively.
 */
export function describeRunEvent(event: RunEvent): EventDescription {
  const step = event.stepId ? `“${event.stepId}”` : '';
  const p = event.payload;
  const attempt = str(p.attempt);
  switch (event.type) {
    case 'run.started':
      return { title: p.dryRun === true ? 'Dry run started' : 'Run started', tone: 'neutral' };
    case 'step.started':
      return {
        title: `Step ${step} started`,
        ...(attempt && attempt !== '1' ? { description: `Attempt ${attempt}` } : {}),
        tone: 'neutral',
      };
    case 'step.succeeded': {
      // The engine records a branch decision as `output: {taken, matchedBranch}`.
      const taken = str(p.taken) ?? str(nested(p.output, 'taken'));
      return {
        title: `Step ${step} succeeded`,
        ...(taken ? { description: `Branch taken → ${taken}` } : {}),
        tone: 'success',
      };
    }
    case 'step.failed':
      return {
        title: `Step ${step} failed${attempt ? ` (attempt ${attempt})` : ''}`,
        description:
          [str(p.error), p.continued === true ? 'Continuing (onFailure: continue)' : undefined]
            .filter(Boolean)
            .join('. ') || 'No error message',
        tone: 'danger',
      };
    case 'step.retry_scheduled': {
      const delay = str(p.delayMs);
      return {
        title: `Retry of ${step} scheduled`,
        description: `Attempt ${attempt ?? '?'}${delay ? ` in ${delay} ms` : ''}`,
        tone: 'warning',
      };
    }
    case 'step.skipped':
      return { title: `Step ${step} skipped`, description: str(p.reason), tone: 'neutral' };
    case 'approval.requested':
      return {
        title: `Waiting for approval at ${step}`,
        description: str(p.prompt),
        tone: 'warning',
      };
    case 'approval.granted':
      return p.reason === 'timeout'
        ? { title: 'Approval expired: approved by the onTimeout rule', tone: 'warning' }
        : { title: 'Approved by an analyst', description: quoted(p.comment), tone: 'success' };
    case 'approval.rejected':
      return p.reason === 'timeout'
        ? { title: 'Approval expired: rejected by the onTimeout rule', tone: 'danger' }
        : { title: 'Rejected by an analyst', description: quoted(p.comment), tone: 'danger' };
    case 'compensation.started': {
      const failedStep = str(nested(p.failure, 'stepId'));
      const error = str(nested(p.failure, 'error'));
      return {
        title: 'Compensation started: undoing completed steps',
        description:
          str(p.reason) ??
          (failedStep ? `Step “${failedStep}” failed${error ? `: ${error}` : ''}` : undefined),
        tone: 'warning',
      };
    }
    case 'compensation.step_succeeded':
      return { title: `Undid step ${step}`, tone: 'success' };
    case 'compensation.step_failed':
      return {
        title: `Could not undo step ${step}`,
        description: str(p.error) ?? 'Manual clean-up needed',
        tone: 'danger',
      };
    case 'run.succeeded':
      return { title: 'Run succeeded', tone: 'success' };
    case 'run.failed':
      return { title: 'Run failed', description: str(p.error), tone: 'danger' };
    case 'run.compensated':
      return { title: 'Run compensated: completed steps were undone', tone: 'warning' };
    case 'run.cancelled':
      return {
        title: 'Run cancelled',
        description: str(p.previousStatus) ? `It was ${str(p.previousStatus) ?? ''}` : undefined,
        tone: 'neutral',
      };
  }
}

/** Maps a run's events onto timeline items. */
export function toTimeline(events: readonly RunEvent[]): TimelineItem[] {
  return events.map((event) => {
    const d = describeRunEvent(event);
    const item: TimelineItem = {
      id: String(event.seq),
      at: event.occurredAt,
      atLabel: formatDateTime(event.occurredAt),
      title: d.title,
      tone: d.tone,
    };
    if (d.description) item.description = d.description;
    return item;
  });
}
