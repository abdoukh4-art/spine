import type {
  PlaybookDefinition,
  RunDetail,
  RunEvent,
  RunEventType,
  RunStatus,
  SimulatedAction,
  Step,
  StepState,
} from '@spine/shared-schema';

/** An event the fake executor will append later (one per poll, to animate the demo). */
export interface PlannedEvent {
  type: RunEventType;
  stepId: string | null;
  payload: Record<string, unknown>;
}

/** A run as the fake server stores it: the public detail plus its not-yet-emitted events. */
export interface StoredRun {
  run: RunDetail;
  definition: PlaybookDefinition;
  planned: PlannedEvent[];
}

const STEP_SUCCESS_OUTPUT: Partial<Record<Step['type'], Record<string, unknown>>> = {
  enrich: { lookups: 4, failed: 0 },
  score: { score: 87 },
  block_indicator: { blocked: ['185.220.101.47'] },
  create_ticket: { ticketId: 'SOC-4821' },
  notify: { delivered: true },
};

/**
 * Walks a playbook from `fromStepId` and returns the events a successful execution would
 * produce, stopping at an approval gate (which needs a human) or at the end of the run.
 * Branches take their first branch. This is a demo animation, not the real engine.
 */
export function planFrom(
  definition: PlaybookDefinition,
  fromStepId: string | undefined,
): PlannedEvent[] {
  const events: PlannedEvent[] = [];
  const seen = new Set<string>();
  let stepId = fromStepId;
  while (stepId !== undefined && !seen.has(stepId)) {
    seen.add(stepId);
    const step = definition.steps.find((s) => s.id === stepId);
    if (!step) break;
    if (step.type === 'approval') {
      events.push({ type: 'step.started', stepId: step.id, payload: { attempt: 1 } });
      events.push({
        type: 'approval.requested',
        stepId: step.id,
        payload: { prompt: step.with.prompt },
      });
      return events;
    }
    events.push({ type: 'step.started', stepId: step.id, payload: { attempt: 1 } });
    if (step.type === 'branch') {
      const matched = step.branches[0] ? 0 : null;
      const taken = step.branches[0]?.next ?? step.default;
      events.push({
        type: 'step.succeeded',
        stepId: step.id,
        payload: { attempt: 1, output: { taken: taken ?? null, matchedBranch: matched } },
      });
      stepId = taken;
      continue;
    }
    events.push({
      type: 'step.succeeded',
      stepId: step.id,
      payload: { output: STEP_SUCCESS_OUTPUT[step.type] ?? {} },
    });
    stepId = step.next;
  }
  events.push({ type: 'run.succeeded', stepId: null, payload: {} });
  return events;
}

const TERMINAL_EVENT_STATUS: Partial<Record<RunEventType, RunStatus>> = {
  'run.succeeded': 'succeeded',
  'run.failed': 'failed',
  'run.compensated': 'compensated',
  'run.cancelled': 'cancelled',
};

/** Appends one event to a run and updates its status, current step and step states. */
export function applyEvent(stored: StoredRun, planned: PlannedEvent, occurredAt: string): RunEvent {
  const run = stored.run;
  const event: RunEvent = {
    runId: run.id,
    seq: run.events.length + 1,
    type: planned.type,
    stepId: planned.stepId,
    payload: planned.payload,
    occurredAt,
  };
  run.events.push(event);
  if (planned.type === 'run.started') {
    run.status = 'running';
    run.startedAt = occurredAt;
  }
  if (planned.type === 'approval.requested') run.status = 'waiting_approval';
  if (planned.type === 'approval.granted' || planned.type === 'approval.rejected')
    run.status = 'running';
  if (planned.type === 'compensation.started') run.status = 'compensating';
  const terminal = TERMINAL_EVENT_STATUS[planned.type];
  if (terminal) {
    run.status = terminal;
    run.finishedAt = occurredAt;
    run.currentStepId = null;
  } else if (planned.stepId) {
    run.currentStepId = planned.stepId;
  }
  run.steps = deriveSteps(stored.definition, run.events);
  return event;
}

const EVENT_STEP_STATUS: Partial<Record<RunEventType, StepState['status']>> = {
  'step.started': 'running',
  'step.succeeded': 'succeeded',
  'step.failed': 'failed',
  'step.retry_scheduled': 'running',
  'step.skipped': 'skipped',
  'approval.requested': 'waiting',
  'approval.granted': 'succeeded',
  'approval.rejected': 'failed',
  'compensation.step_succeeded': 'compensated',
};

/** Folds the event log into per-step state, as the real `GET /runs/:id` does (ADR-0010). */
export function deriveSteps(
  definition: PlaybookDefinition,
  events: readonly RunEvent[],
): StepState[] {
  return definition.steps.map((step) => {
    const own = events.filter((e) => e.stepId === step.id);
    let status: StepState['status'] = 'pending';
    let startedAt: string | null = null;
    let finishedAt: string | null = null;
    let error: string | undefined;
    let output: unknown;
    for (const event of own) {
      status = EVENT_STEP_STATUS[event.type] ?? status;
      if (event.type === 'step.started' && startedAt === null) startedAt = event.occurredAt;
      if (status === 'succeeded' || status === 'failed' || status === 'skipped')
        finishedAt = event.occurredAt;
      if (typeof event.payload.error === 'string') error = event.payload.error;
      if (event.payload.output !== undefined) output = event.payload.output;
    }
    const state: StepState = {
      stepId: step.id,
      type: step.type,
      status,
      attempts: own.filter((e) => e.type === 'step.started').length,
      startedAt,
      finishedAt,
    };
    if (error !== undefined) state.error = error;
    if (output !== undefined) state.output = output;
    return state;
  });
}

/** Which simulated adapter call a succeeded step stands for (ADR-0018). */
export function simulatedKindFor(stepType: string): SimulatedAction['kind'] | null {
  switch (stepType) {
    case 'block_indicator':
      return 'firewall.block';
    case 'create_ticket':
      return 'ticket.create';
    case 'notify':
      return 'chat.post';
    case 'set_status':
      return 'alert.set_status';
    default:
      return null;
  }
}
