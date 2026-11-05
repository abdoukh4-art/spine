import { ALERT_STATUSES, isAllowedAlertTransition, type AlertStatus } from '@spine/shared-schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { likePattern, tacticFilterIds, techniqueFilterIds } from './mitre-index.js';
import { isClosed, planStatusChange } from './status-change.js';

const T1 = '2026-10-28T10:00:00.000Z';
const T2 = '2026-10-28T11:00:00.000Z';
const T3 = '2026-10-28T12:00:00.000Z';

describe('planStatusChange (ADR-0036)', () => {
  it('is a no-op when the alert already has the requested status', () => {
    expect(planStatusChange({ status: 'triaged', resolvedAt: null }, 'triaged', T1)).toEqual({
      kind: 'noop',
    });
  });

  it('refuses transitions outside the state machine', () => {
    expect(planStatusChange({ status: 'resolved', resolvedAt: T1 }, 'new', T2)).toEqual({
      kind: 'illegal',
      from: 'resolved',
      to: 'new',
    });
  });

  it('sets resolvedAt on the first close only, and keeps it across reopen and re-close', () => {
    const close = planStatusChange({ status: 'in_progress', resolvedAt: null }, 'resolved', T1);
    expect(close).toMatchObject({ kind: 'change', resolvedAt: T1, reopens: false });
    const reopen = planStatusChange({ status: 'resolved', resolvedAt: T1 }, 'in_progress', T2);
    expect(reopen).toMatchObject({ kind: 'change', resolvedAt: T1, reopens: true });
    const reclose = planStatusChange(
      { status: 'in_progress', resolvedAt: T1 },
      'false_positive',
      T3,
    );
    expect(reclose).toMatchObject({ kind: 'change', resolvedAt: T1 });
  });

  it('leaves resolvedAt null for open-to-open moves', () => {
    expect(planStatusChange({ status: 'new', resolvedAt: null }, 'triaged', T1)).toMatchObject({
      kind: 'change',
      resolvedAt: null,
    });
  });

  it('property: agrees with the shared transition table and never moves resolvedAt once set', () => {
    const status = fc.constantFrom(...ALERT_STATUSES);
    fc.assert(
      fc.property(status, status, fc.option(fc.constant(T1)), (from, to, resolvedAt) => {
        const plan = planStatusChange({ status: from, resolvedAt }, to, T2);
        if (from === to) expect(plan.kind).toBe('noop');
        else expect(plan.kind === 'change').toBe(isAllowedAlertTransition(from, to));
        if (plan.kind === 'change' && resolvedAt !== null) expect(plan.resolvedAt).toBe(T1);
        if (plan.kind === 'change' && isClosed(to)) expect(plan.resolvedAt).not.toBeNull();
      }),
    );
  });

  it('classifies closed statuses', () => {
    const closed = ALERT_STATUSES.filter((s: AlertStatus) => isClosed(s));
    expect(closed).toEqual(['resolved', 'false_positive']);
  });
});

describe('MITRE filter ids (ADR-0037)', () => {
  it('indexes sub-techniques under their parent too', () => {
    expect(
      techniqueFilterIds([
        { techniqueId: 'T1059.001', tacticId: 'TA0002' },
        { techniqueId: 'T1003' },
        { techniqueId: 'T1059.003', tacticId: 'TA0002' },
      ]),
    ).toEqual(['T1003', 'T1059', 'T1059.001', 'T1059.003']);
    expect(
      tacticFilterIds([{ techniqueId: 'T1003' }, { techniqueId: 'T1059', tacticId: 'TA0002' }]),
    ).toEqual(['TA0002']);
  });

  it('escapes LIKE wildcards in search text', () => {
    expect(likePattern('100%_done\\')).toBe('%100\\%\\_done\\\\%');
  });
});
