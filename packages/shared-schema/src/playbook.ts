import { z } from 'zod';
import { IndicatorTypeSchema } from './alert.js';
import { IdSchema, RoleSchema, TimestampSchema } from './common.js';
import { ConditionSchema } from './condition.js';

/**
 * Playbook DSL (ADR-0013). A playbook is a validated, versioned DAG of steps.
 * This file defines the *shape*; graph rules (acyclic, reachable, references exist)
 * are enforced by `@spine/playbook-engine`'s `validatePlaybook`.
 */

/** A step ID: lower-kebab-case, unique within its playbook, used in `next`/`branches` references. */
export const StepIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lower-kebab-case, ≤ 63 chars');
/** A playbook ID: same rules as a step ID; stable across versions. */
export const PlaybookIdSchema = StepIdSchema;

/** Per-step retries: up to `maxAttempts` tries in total, waiting `backoffMs` between them. */
export const RetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(1),
    backoffMs: z.number().int().min(0).max(600_000).default(1000),
  })
  .strict();
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

const stepCommon = {
  id: StepIdSchema,
  name: z.string().max(200).optional(),
  /** Per-attempt timeout. */
  timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
  retry: RetryPolicySchema.optional(),
  /** What happens when the step fails after all retries. */
  onFailure: z.enum(['fail', 'continue']).default('fail'),
};

/** Template strings may reference `{{path}}` lookups only — no expressions (ADR-0013). */
const TemplateString = z.string().min(1).max(2000);

/** `enrich`: (re-)run enrichment for the alert, optionally limited to some providers. */
export const EnrichStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('enrich'),
    with: z
      .object({ providers: z.array(z.string()).optional() })
      .strict()
      .default({}),
    next: StepIdSchema.optional(),
  })
  .strict();

/** `score`: (re-)score the alert with the active ruleset. */
export const ScoreStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('score'),
    with: z.object({}).strict().default({}),
    next: StepIdSchema.optional(),
  })
  .strict();

/** `branch`: go to the first branch whose condition matches (same predicate language as scoring rules). */
export const BranchStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('branch'),
    branches: z
      .array(z.object({ when: ConditionSchema, next: StepIdSchema }).strict())
      .min(1)
      .max(20),
    /** Taken when no branch matches. If omitted and nothing matches, the run ends successfully. */
    default: StepIdSchema.optional(),
  })
  .strict();

/** `notify`: post a templated message to a (simulated) chat channel. */
export const NotifyStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('notify'),
    with: z
      .object({
        channel: z.string().min(1).max(100),
        template: TemplateString,
      })
      .strict(),
    next: StepIdSchema.optional(),
  })
  .strict();

/** `create_ticket`: open a (simulated) ticket; compensated by closing it if the run is rolled back. */
export const CreateTicketStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('create_ticket'),
    with: z
      .object({
        queue: z.string().min(1).max(100),
        priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
        summaryTemplate: TemplateString.optional(),
      })
      .strict(),
    compensate: z
      .object({ type: z.literal('close_ticket') })
      .strict()
      .optional(),
    next: StepIdSchema.optional(),
  })
  .strict();

/**
 * `block_indicator`: block the alert's indicators of the given types on the (simulated) firewall
 * for `durationMinutes`, only when their verdict is at least `minVerdict`. Compensated by unblocking.
 */
export const BlockIndicatorStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('block_indicator'),
    with: z
      .object({
        indicatorTypes: z.array(IndicatorTypeSchema).min(1).default(['ipv4', 'domain']),
        durationMinutes: z.number().int().min(1).max(43_200).default(1440),
        /** Only indicators whose reputation verdict is at least this bad are blocked. */
        minVerdict: z.enum(['malicious', 'suspicious']).default('malicious'),
      })
      .strict(),
    compensate: z
      .object({ type: z.literal('unblock_indicator') })
      .strict()
      .optional(),
    next: StepIdSchema.optional(),
  })
  .strict();

/** `set_status`: move the alert to a new status (subject to the allowed transitions). */
export const SetStatusStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('set_status'),
    with: z
      .object({ status: z.enum(['triaged', 'in_progress', 'resolved', 'false_positive']) })
      .strict(),
    next: StepIdSchema.optional(),
  })
  .strict();

/**
 * `approval`: pause the run until a human with `approverRole` decides, or until `expiresInMs`
 * elapses and `onTimeout` applies. Approved → `next`; rejected → `onReject`.
 */
export const ApprovalStepSchema = z
  .object({
    ...stepCommon,
    type: z.literal('approval'),
    with: z
      .object({
        approverRole: RoleSchema.exclude(['viewer']).default('analyst'),
        prompt: TemplateString,
        /** How long to wait for a human before applying `onTimeout`. */
        expiresInMs: z
          .number()
          .int()
          .min(60_000)
          .max(7 * 24 * 3_600_000)
          .default(3_600_000),
        onTimeout: z.enum(['reject', 'approve']).default('reject'),
      })
      .strict(),
    /** Step to go to when approved. If omitted, the run ends successfully. */
    next: StepIdSchema.optional(),
    /** Step to go to when rejected/expired-as-reject. If omitted, the run ends successfully. */
    onReject: StepIdSchema.optional(),
  })
  .strict();

/** Any step, discriminated by `type`. Unknown fields are rejected (`.strict()`), so typos fail validation. */
export const StepSchema = z.discriminatedUnion('type', [
  EnrichStepSchema,
  ScoreStepSchema,
  BranchStepSchema,
  NotifyStepSchema,
  CreateTicketStepSchema,
  BlockIndicatorStepSchema,
  SetStatusStepSchema,
  ApprovalStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;
/** The `type` of a step, e.g. `notify`. */
export type StepType = Step['type'];
/** Every step type, checked against {@link StepType} at compile time. */
export const STEP_TYPES = [
  'enrich',
  'score',
  'branch',
  'notify',
  'create_ticket',
  'block_indicator',
  'set_status',
  'approval',
] as const satisfies readonly StepType[];

/** When a playbook runs automatically: on `alert.scored`, if the optional condition matches. */
export const PlaybookTriggerSchema = z
  .object({
    event: z.literal('alert.scored'),
    when: ConditionSchema.optional(),
  })
  .strict();

/**
 * A complete playbook document (`apiVersion: spine/v1`, `kind: Playbook`): metadata, optional
 * trigger, the start step and the steps. Shape only; `validatePlaybook` checks the graph.
 */
export const PlaybookDefinitionSchema = z
  .object({
    apiVersion: z.literal('spine/v1'),
    kind: z.literal('Playbook'),
    metadata: z
      .object({
        id: PlaybookIdSchema,
        name: z.string().min(1).max(200),
        version: z.number().int().min(1),
        description: z.string().max(2000).optional(),
        tags: z.array(z.string().max(50)).max(20).default([]),
      })
      .strict(),
    trigger: PlaybookTriggerSchema.optional(),
    start: StepIdSchema,
    steps: z.array(StepSchema).min(1).max(100),
  })
  .strict();
export type PlaybookDefinition = z.infer<typeof PlaybookDefinitionSchema>;
/** A playbook as written (defaults not yet applied), e.g. parsed YAML before validation. */
export type PlaybookDefinitionInput = z.input<typeof PlaybookDefinitionSchema>;

// ---------------------------------------------------------------------------
// Runs (event-sourced, ADR-0010)
// ---------------------------------------------------------------------------

/** Lifecycle of a playbook run, derived from its event stream (ADR-0010). */
export const RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'compensating',
  'succeeded',
  'failed',
  'compensated',
  'cancelled',
] as const;
/** Validates a {@link RUN_STATUSES} value. */
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;
/** Statuses a run never leaves. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'compensated',
  'cancelled',
];

/** Events in a run's append-only stream; the run's state is a fold over them (ADR-0010). */
export const RUN_EVENT_TYPES = [
  'run.started',
  'step.started',
  'step.succeeded',
  'step.failed',
  'step.retry_scheduled',
  'step.skipped',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'compensation.started',
  'compensation.step_succeeded',
  'compensation.step_failed',
  'run.succeeded',
  'run.failed',
  'run.compensated',
  'run.cancelled',
] as const;
/** Validates a {@link RUN_EVENT_TYPES} value. */
export const RunEventTypeSchema = z.enum(RUN_EVENT_TYPES);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

/** One event in a run's stream, ordered by `seq` (unique per run). */
export const RunEventSchema = z.object({
  runId: IdSchema,
  seq: z.number().int().min(1),
  type: RunEventTypeSchema,
  stepId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: TimestampSchema,
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/** A run as listed: which playbook version, which alert, its status and where it is now. */
export const RunSummarySchema = z.object({
  id: IdSchema,
  playbookId: z.string(),
  playbookVersion: z.number().int(),
  alertId: IdSchema,
  status: RunStatusSchema,
  dryRun: z.boolean(),
  trigger: z.enum(['auto', 'manual']),
  currentStepId: z.string().nullable(),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/** Per-step state shown in the run timeline, derived from the run's events. */
export const STEP_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'waiting',
  'compensated',
] as const;
/** One step's derived state: status, attempts, output or error, and timing. */
export const StepStateSchema = z.object({
  stepId: z.string(),
  type: z.string(),
  status: z.enum(STEP_STATES),
  attempts: z.number().int().min(0),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
});
export type StepState = z.infer<typeof StepStateSchema>;

/** `GET /runs/:id`: the summary plus the full event stream and per-step state. */
export const RunDetailSchema = RunSummarySchema.extend({
  events: z.array(RunEventSchema),
  steps: z.array(StepStateSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** One stored, immutable playbook version with its original source text. */
export const PlaybookRecordSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  definition: PlaybookDefinitionSchema,
  source: z.string(),
  createdAt: TimestampSchema,
});
export type PlaybookRecord = z.infer<typeof PlaybookRecordSchema>;

/** A playbook as listed: latest version, whether automatic triggering is enabled, size and tags. */
export const PlaybookSummarySchema = z.object({
  id: z.string(),
  latestVersion: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  stepCount: z.number().int(),
  tags: z.array(z.string()),
});
export type PlaybookSummary = z.infer<typeof PlaybookSummarySchema>;

/** Lifecycle of an approval request created by an `approval` step. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
/** Validates an {@link APPROVAL_STATUSES} value. */
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** A pending or decided approval: the prompt, who may decide, the deadline and the decision. */
export const ApprovalSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  stepId: z.string(),
  alertId: IdSchema,
  playbookId: z.string(),
  status: ApprovalStatusSchema,
  approverRole: RoleSchema,
  prompt: z.string(),
  requestedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
  decidedBy: IdSchema.nullable(),
  comment: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** Body of an approval decision (analyst): approve or reject, with an optional comment (audited). */
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().max(2000).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Response actions Spine can perform. All are SIMULATED: nothing real is blocked or sent (ADR-0018). */
export const SIMULATED_ACTION_KINDS = [
  'firewall.block',
  'firewall.unblock',
  'ticket.create',
  'ticket.close',
  'chat.post',
  'alert.set_status',
] as const;
/** A recorded simulated action: what was requested, what the fake integration answered, and by which run. */
export const SimulatedActionSchema = z.object({
  id: IdSchema,
  kind: z.enum(SIMULATED_ACTION_KINDS),
  runId: IdSchema.nullable(),
  stepId: z.string().nullable(),
  dryRun: z.boolean(),
  request: z.record(z.string(), z.unknown()),
  response: z.record(z.string(), z.unknown()),
  createdAt: TimestampSchema,
});
export type SimulatedAction = z.infer<typeof SimulatedActionSchema>;
