import {
  NonRetryableError,
  type StepContext,
  type StepHandler,
  type StepHandlers,
} from '@spine/playbook-engine';
import {
  renderTemplate,
  type Alert,
  type EnrichmentResult,
  type Indicator,
  type Step,
} from '@spine/shared-schema';
import { approvalDeadline } from '../domain/approval.js';
import { selectIndicatorsToBlock } from '../domain/indicators.js';
import type {
  ActionOptions,
  ApprovalRepository,
  PlaybooksGateways,
  ResponseActions,
} from './ports.js';

/**
 * Step handlers: the bridge between the engine's step types and the outside world.
 * Read-only steps (`enrich`, `score`) call other modules through gateways; response
 * actions go through the simulated ports (ADR-0018) with the step's idempotency key.
 */

type StepOf<T extends Step['type']> = Extract<Step, { type: T }>;

/** Dependencies of the handlers. */
export interface StepHandlerDeps {
  gateways: Pick<PlaybooksGateways, 'enrichment' | 'scoring' | 'alertStatus'>;
  actions: ResponseActions;
  approvals: Pick<ApprovalRepository, 'createIfMissing'>;
  clock: { now(): Date };
  ids: { next(): string };
}

/** Builds the handler registry for the engine. */
export function createStepHandlers(deps: StepHandlerDeps): StepHandlers {
  return {
    enrich: typed('enrich', (step, ctx) => enrich(deps, step, ctx)),
    score: typed('score', (_step, ctx) => score(deps, ctx)),
    set_status: typed('set_status', (step, ctx) => setStatus(deps, step, ctx)),
    notify: typed('notify', (step, ctx) => notify(deps, step, ctx)),
    create_ticket: {
      ...typed('create_ticket', (step, ctx) => createTicket(deps, step, ctx)),
      compensate: (step, ctx, original) => closeTicket(deps, step, ctx, original),
    },
    block_indicator: {
      ...typed('block_indicator', (step, ctx) => blockIndicators(deps, step, ctx)),
      compensate: (step, ctx, original) => unblockIndicators(deps, step, ctx, original),
    },
    approval: typed('approval', (step, ctx) => requestApproval(deps, step, ctx)),
  };
}

/** Narrows the step type once, so each handler body is fully typed. */
function typed<T extends Step['type']>(
  type: T,
  fn: (step: StepOf<T>, ctx: StepContext) => Promise<unknown>,
): StepHandler {
  return {
    execute: (step, ctx) => {
      if (step.type !== type) {
        return Promise.reject(new NonRetryableError(`handler for ${type} got ${step.type}`));
      }
      return fn(step as StepOf<T>, ctx);
    },
  };
}

function requireAlert(ctx: StepContext): Alert {
  if (!ctx.alert) throw new NonRetryableError('run has no alert snapshot');
  return ctx.alert;
}

function actionOptions(stepId: string, ctx: StepContext): ActionOptions {
  return {
    idempotencyKey: ctx.idempotencyKey,
    runId: ctx.runId,
    stepId,
    dryRun: ctx.dryRun,
    signal: ctx.signal,
  };
}

async function enrich(
  deps: StepHandlerDeps,
  step: StepOf<'enrich'>,
  ctx: StepContext,
): Promise<{ enrichments: EnrichmentResult[]; refreshed: number }> {
  const alert = requireAlert(ctx);
  const fresh = await deps.gateways.enrichment.enrich(alert, {
    ...(step.with.providers ? { providers: step.with.providers } : {}),
    signal: ctx.signal,
  });
  // Fresh results replace older ones for the same (provider, indicator); others are kept.
  const key = (r: EnrichmentResult) => `${r.provider}|${r.indicator.type}|${r.indicator.value}`;
  const merged = new Map(ctx.input.enrichment.results.map((r) => [key(r), r]));
  for (const r of fresh) merged.set(key(r), r);
  return { enrichments: [...merged.values()], refreshed: fresh.length };
}

async function score(deps: StepHandlerDeps, ctx: StepContext): Promise<{ score: unknown }> {
  const alert = requireAlert(ctx);
  const result = await deps.gateways.scoring.score(alert, ctx.input.enrichment.results, {
    persist: !ctx.dryRun,
  });
  return { score: result ?? ctx.input.score };
}

async function setStatus(
  deps: StepHandlerDeps,
  step: StepOf<'set_status'>,
  ctx: StepContext,
): Promise<Record<string, unknown>> {
  const alert = requireAlert(ctx);
  if (ctx.dryRun) {
    await deps.actions.statusPreview.record(
      { alertId: alert.id, status: step.with.status },
      actionOptions(step.id, ctx),
    );
    return { dryRun: true, wouldSetStatus: step.with.status };
  }
  const result = await deps.gateways.alertStatus.setStatus(alert.id, step.with.status);
  return { status: step.with.status, ...result };
}

async function notify(
  deps: StepHandlerDeps,
  step: StepOf<'notify'>,
  ctx: StepContext,
): Promise<Record<string, unknown>> {
  const message = renderTemplate(step.with.template, ctx.input);
  const result = await deps.actions.chat.post(
    { channel: step.with.channel, message },
    actionOptions(step.id, ctx),
  );
  return { ...result, channel: step.with.channel, message, dryRun: ctx.dryRun };
}

async function createTicket(
  deps: StepHandlerDeps,
  step: StepOf<'create_ticket'>,
  ctx: StepContext,
): Promise<Record<string, unknown>> {
  const alert = requireAlert(ctx);
  const summary = renderTemplate(
    step.with.summaryTemplate ?? '[{{alert.category}}] {{alert.title}}',
    ctx.input,
  );
  const result = await deps.actions.ticketing.create(
    { queue: step.with.queue, priority: step.with.priority, summary, alertId: alert.id },
    actionOptions(step.id, ctx),
  );
  return { ...result, queue: step.with.queue, summary, dryRun: ctx.dryRun };
}

async function closeTicket(
  deps: StepHandlerDeps,
  step: Step,
  ctx: StepContext,
  original: unknown,
): Promise<Record<string, unknown>> {
  const ticketId = readString(original, 'ticketId');
  if (ticketId === undefined) return { closed: false, reason: 'no ticket was created' };
  return deps.actions.ticketing.close(
    { ticketId, reason: `compensation of run ${ctx.runId}` },
    actionOptions(step.id, ctx),
  );
}

async function blockIndicators(
  deps: StepHandlerDeps,
  step: StepOf<'block_indicator'>,
  ctx: StepContext,
): Promise<Record<string, unknown>> {
  const alert = requireAlert(ctx);
  const selection = selectIndicatorsToBlock(alert.indicators, ctx.input.enrichment.results, {
    indicatorTypes: step.with.indicatorTypes,
    minVerdict: step.with.minVerdict,
  });
  if (selection.toBlock.length === 0) {
    return { blockId: null, blocked: [], skipped: selection.skipped, dryRun: ctx.dryRun };
  }
  const result = await deps.actions.firewall.block(
    {
      indicators: selection.toBlock,
      durationMinutes: step.with.durationMinutes,
      alertId: alert.id,
    },
    actionOptions(step.id, ctx),
  );
  return { ...result, skipped: selection.skipped, dryRun: ctx.dryRun };
}

async function unblockIndicators(
  deps: StepHandlerDeps,
  step: Step,
  ctx: StepContext,
  original: unknown,
): Promise<Record<string, unknown>> {
  const blockId = readString(original, 'blockId');
  if (blockId === undefined) return { unblocked: [], reason: 'nothing was blocked' };
  const indicators = readIndicators(original);
  return deps.actions.firewall.unblock({ blockId, indicators }, actionOptions(step.id, ctx));
}

async function requestApproval(
  deps: StepHandlerDeps,
  step: StepOf<'approval'>,
  ctx: StepContext,
): Promise<Record<string, unknown>> {
  const alert = requireAlert(ctx);
  const now = deps.clock.now();
  const approval = await deps.approvals.createIfMissing({
    id: deps.ids.next(),
    runId: ctx.runId,
    stepId: step.id,
    alertId: alert.id,
    playbookId: ctx.input.run.playbookId,
    approverRole: step.with.approverRole,
    prompt: renderTemplate(step.with.prompt, ctx.input),
    requestedAt: now.toISOString(),
    expiresAt: approvalDeadline(now, step.with.expiresInMs),
  });
  return {
    approvalId: approval.id,
    expiresAt: approval.expiresAt,
    prompt: approval.prompt,
    approverRole: approval.approverRole,
    onTimeout: step.with.onTimeout,
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

function readIndicators(value: unknown): Indicator[] {
  if (typeof value !== 'object' || value === null) return [];
  const blocked = (value as Record<string, unknown>).blocked;
  return Array.isArray(blocked) ? (blocked as Indicator[]) : [];
}
