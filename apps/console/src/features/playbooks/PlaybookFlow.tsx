import type { Condition, PlaybookDefinition, Step } from '@spine/shared-schema';
import type { ReactNode } from 'react';
import { Badge } from '../../components';
import { humanize } from '../../lib/format';

const OP_TEXT: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'is one of',
  contains: 'contains',
  exists: 'exists',
  matches: 'matches',
};

/** Renders a predicate (ADR-0013) as readable text: `score.score ≥ 70`, `any of (…)`. */
export function conditionText(condition: Condition): string {
  if ('all' in condition) return `all of (${condition.all.map(conditionText).join('; ')})`;
  if ('any' in condition) return `any of (${condition.any.map(conditionText).join('; ')})`;
  if ('not' in condition) return `not (${conditionText(condition.not)})`;
  const op = OP_TEXT[condition.op] ?? condition.op;
  return condition.value === undefined
    ? `${condition.field} ${op}`
    : `${condition.field} ${op} ${JSON.stringify(condition.value)}`;
}

/** One line describing what a step does with its configuration. */
export function stepDetail(step: Step): string {
  switch (step.type) {
    case 'enrich':
      return step.with.providers ? `Providers: ${step.with.providers.join(', ')}` : 'All providers';
    case 'score':
      return 'Re-score with the active ruleset';
    case 'branch':
      return `${String(step.branches.length)} condition(s)`;
    case 'notify':
      return `Post to ${step.with.channel}`;
    case 'create_ticket':
      return `Queue ${step.with.queue}, priority ${step.with.priority}`;
    case 'block_indicator':
      return `Block ${step.with.indicatorTypes.join('/')} with verdict ≥ ${step.with.minVerdict} for ${String(step.with.durationMinutes)} min`;
    case 'set_status':
      return `Set alert status to ${humanize(step.with.status)}`;
    case 'approval':
      return `Needs ${step.with.approverRole}: “${step.with.prompt}”`;
  }
}

function Edge({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li>
      <p className="sp-flow__edge">{label}</p>
      <ol>{children}</ol>
    </li>
  );
}

/**
 * Builds the `<li>` chain starting at `stepId`, following `next` links. Branches and
 * approvals nest their outcomes in indented sub-lists. A step reached a second time
 * (paths that re-join) is shown once; later references point back to it.
 */
function sequence(
  definition: PlaybookDefinition,
  stepId: string | undefined,
  seen: Set<string>,
): ReactNode[] {
  const items: ReactNode[] = [];
  let current = stepId;
  for (;;) {
    if (current === undefined) {
      items.push(
        <li key="end" className="sp-flow__step sp-muted">
          End of run
        </li>,
      );
      return items;
    }
    if (seen.has(current)) {
      items.push(
        <li key={`ref-${current}`} className="sp-flow__step">
          Continues at <a href={`#step-${current}`}>{current}</a> (shown above)
        </li>,
      );
      return items;
    }
    const id = current;
    const step = definition.steps.find((s) => s.id === id);
    if (!step) return items;
    seen.add(step.id);
    items.push(
      <li key={step.id} id={`step-${step.id}`} className="sp-flow__step">
        <span className="sp-flow__card">
          <Badge tone="info">{humanize(step.type)}</Badge>
          <strong>{step.name ?? step.id}</strong>
          <code className="sp-muted">{step.id}</code>
          <span className="sp-small">{stepDetail(step)}</span>
          {step.retry ? (
            <span className="sp-small sp-muted">retries ×{step.retry.maxAttempts}</span>
          ) : null}
          {step.onFailure === 'continue' ? <Badge>continues on failure</Badge> : null}
          {'compensate' in step && step.compensate ? (
            <Badge tone="warning">undo: {humanize(step.compensate.type)}</Badge>
          ) : null}
        </span>
        {step.type === 'branch' ? (
          <ol>
            {step.branches.map((b) => (
              <Edge
                key={`${b.next}-${conditionText(b.when)}`}
                label={`If ${conditionText(b.when)} →`}
              >
                {sequence(definition, b.next, seen)}
              </Edge>
            ))}
            <Edge label="Otherwise →">{sequence(definition, step.default, seen)}</Edge>
          </ol>
        ) : null}
        {step.type === 'approval' ? (
          <ol>
            <Edge label="If approved →">{sequence(definition, step.next, seen)}</Edge>
            <Edge label={`If rejected (or expired with onTimeout: ${step.with.onTimeout}) →`}>
              {sequence(definition, step.onReject, seen)}
            </Edge>
          </ol>
        ) : null}
      </li>,
    );
    if (step.type === 'branch' || step.type === 'approval') return items;
    current = step.next;
  }
}

/** The playbook DAG as an ordered, indented list: readable by everyone, including screen readers. */
export function PlaybookFlow({ definition }: { definition: PlaybookDefinition }) {
  return (
    <ol
      className="sp-flow"
      aria-label={`Steps of ${definition.metadata.name}, starting at ${definition.start}`}
    >
      {sequence(definition, definition.start, new Set())}
    </ol>
  );
}
