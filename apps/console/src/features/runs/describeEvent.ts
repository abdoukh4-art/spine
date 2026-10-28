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
      const taken = str(p.taken);
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
      return {
        title: `Approved${str(p.decidedBy) ? ` by ${str(p.decidedBy) ?? ''}` : ''}`,
        tone: 'success',
      };
    case 'approval.rejected':
      return {
        title: `Rejected${str(p.decidedBy) ? ` by ${str(p.decidedBy) ?? ''}` : ''}`,
        tone: 'danger',
      };
    case 'compensation.started':
      return {
        title: 'Compensation started: undoing completed steps',
        description: str(p.reason),
        tone: 'warning',
      };
    case 'compensation.step_succeeded':
      return { title: `Undid step ${step}`, description: str(p.action), tone: 'success' };
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
        ...(str(p.by) ? { description: `By ${str(p.by) ?? ''}` } : {}),
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
