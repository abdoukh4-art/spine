import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ConditionSchema,
  collectPatterns,
  conditionDepth,
  evaluateCondition,
  getPath,
  isSafePattern,
  renderTemplate,
  UnsafePatternError,
  type Condition,
} from '../src/index.js';

const ctx = {
  alert: {
    category: 'malware',
    title: 'Mimikatz detected on FIN-WS-042',
    mitre: [
      { tacticId: 'TA0006', techniqueId: 'T1003.001' },
      { tacticId: 'TA0002', techniqueId: 'T1059' },
    ],
    host: { hostname: 'fin-ws-042', ips: ['10.0.4.42'] },
  },
  score: { value: 72 },
  enrichment: { verdicts: ['malicious', 'unknown'] },
};

describe('getPath', () => {
  it('resolves nested properties', () => {
    expect(getPath(ctx, 'alert.host.hostname')).toBe('fin-ws-042');
  });
  it('maps over arrays for non-numeric segments and flattens', () => {
    expect(getPath(ctx, 'alert.mitre.tacticId')).toEqual(['TA0006', 'TA0002']);
  });
  it('indexes arrays with numeric segments', () => {
    expect(getPath(ctx, 'alert.mitre.1.techniqueId')).toBe('T1059');
  });
  it('returns undefined for missing paths', () => {
    expect(getPath(ctx, 'alert.user.name')).toBeUndefined();
    expect(getPath(ctx, 'alert.mitre.nothing')).toBeUndefined();
  });
  it('never resolves prototype segments', () => {
    expect(getPath({}, '__proto__')).toBeUndefined();
    expect(getPath({ a: {} }, 'a.constructor')).toBeUndefined();
    expect(getPath({ a: 'x' }, 'a.length')).toBeUndefined();
  });
});

describe('evaluateCondition', () => {
  const cases: [string, Condition, boolean][] = [
    ['eq match', { field: 'alert.category', op: 'eq', value: 'malware' }, true],
    ['eq mismatch', { field: 'alert.category', op: 'eq', value: 'phishing' }, false],
    ['neq', { field: 'alert.category', op: 'neq', value: 'phishing' }, true],
    ['neq on missing field is false', { field: 'alert.nope', op: 'neq', value: 'x' }, false],
    ['gte', { field: 'score.value', op: 'gte', value: 72 }, true],
    ['gt', { field: 'score.value', op: 'gt', value: 72 }, false],
    ['lt', { field: 'score.value', op: 'lt', value: 80 }, true],
    ['lte', { field: 'score.value', op: 'lte', value: 71 }, false],
    ['numeric op on string is false', { field: 'alert.category', op: 'gt', value: 1 }, false],
    ['in', { field: 'alert.category', op: 'in', value: ['phishing', 'malware'] }, true],
    ['contains on array', { field: 'alert.mitre.tacticId', op: 'contains', value: 'TA0006' }, true],
    ['contains on string', { field: 'alert.title', op: 'contains', value: 'Mimikatz' }, true],
    ['contains miss', { field: 'enrichment.verdicts', op: 'contains', value: 'benign' }, false],
    ['exists', { field: 'alert.host.ips', op: 'exists' }, true],
    ['exists missing', { field: 'alert.user', op: 'exists' }, false],
    ['matches', { field: 'alert.host.hostname', op: 'matches', value: '^fin-' }, true],
    ['matches over array', { field: 'alert.host.ips', op: 'matches', value: '^10\\.' }, true],
    [
      'all',
      {
        all: [
          { field: 'alert.category', op: 'eq', value: 'malware' },
          { field: 'score.value', op: 'gte', value: 60 },
        ],
      },
      true,
    ],
    [
      'any',
      {
        any: [
          { field: 'alert.category', op: 'eq', value: 'phishing' },
          { field: 'score.value', op: 'gte', value: 90 },
        ],
      },
      false,
    ],
    ['not', { not: { field: 'alert.category', op: 'eq', value: 'phishing' } }, true],
  ];
  it.each(cases)('%s', (_name, condition, expected) => {
    expect(ConditionSchema.safeParse(condition).success).toBe(true);
    expect(evaluateCondition(condition, ctx)).toBe(expected);
  });

  it('throws on unsafe regex patterns', () => {
    expect(() =>
      evaluateCondition({ field: 'alert.title', op: 'matches', value: '(a+)+$' }, ctx),
    ).toThrow(UnsafePatternError);
  });

  it('rejects excessive nesting', () => {
    let c: Condition = { field: 'a', op: 'exists' };
    for (let i = 0; i < 20; i++) c = { not: c };
    expect(() => evaluateCondition(c, {})).toThrow(RangeError);
  });
});

describe('condition schema', () => {
  it('requires a value for non-exists operators', () => {
    expect(ConditionSchema.safeParse({ field: 'a', op: 'eq' }).success).toBe(false);
  });
  it('requires an array for "in"', () => {
    expect(ConditionSchema.safeParse({ field: 'a', op: 'in', value: 'x' }).success).toBe(false);
  });
  it('rejects unknown keys and bad paths', () => {
    expect(ConditionSchema.safeParse({ field: 'a', op: 'eq', value: 1, extra: 1 }).success).toBe(
      false,
    );
    expect(ConditionSchema.safeParse({ field: 'a..b', op: 'exists' }).success).toBe(false);
  });
});

describe('isSafePattern', () => {
  it.each(['(a+)+', '(a*)*b', '(a|aa)+', '(.*a){10}', '(\\w+\\s?)*$', '(a)\\1'])(
    'rejects %s',
    (p) => expect(isSafePattern(p)).toBe(false),
  );
  it.each(['^fin-', '^10\\.', 'evil\\.example$', '^[a-z0-9-]+$', '(foo|bar)'])('accepts %s', (p) =>
    expect(isSafePattern(p)).toBe(true),
  );
  it('rejects invalid syntax', () => expect(isSafePattern('(')).toBe(false));
});

describe('helpers', () => {
  it('collects patterns and computes depth', () => {
    const c: Condition = {
      all: [{ field: 'a', op: 'matches', value: 'x' }, { not: { field: 'b', op: 'exists' } }],
    };
    expect(collectPatterns(c)).toEqual(['x']);
    expect(conditionDepth(c)).toBe(3);
  });
  it('renders templates by path lookup only', () => {
    expect(
      renderTemplate('Host {{ alert.host.hostname }} tactics {{alert.mitre.tacticId}}', ctx),
    ).toBe('Host fin-ws-042 tactics TA0006, TA0002');
    expect(renderTemplate('{{missing}}|{{score}}|{{score.value}}', ctx)).toBe('|{"value":72}|72');
    expect(renderTemplate('{{ constructor.name }}', ctx)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Property-based tests: algebraic laws the interpreter must obey for ANY input.
// ---------------------------------------------------------------------------

const scalar = fc.oneof(fc.string({ maxLength: 5 }), fc.integer({ min: -5, max: 5 }), fc.boolean());
const fieldName = fc.constantFrom('a', 'b', 'c');
const leaf: fc.Arbitrary<Condition> = fc.oneof(
  fc.record({
    field: fieldName,
    op: fc.constantFrom('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains' as const),
    value: scalar,
  }),
  fc.record({ field: fieldName, op: fc.constant('exists' as const) }),
  fc.record({
    field: fieldName,
    op: fc.constant('in' as const),
    value: fc.array(scalar, { maxLength: 3 }),
  }),
);
const condition: fc.Arbitrary<Condition> = fc.letrec<{ c: Condition }>((tie) => ({
  c: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc.record({ all: fc.array(tie('c'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ any: fc.array(tie('c'), { minLength: 1, maxLength: 3 }) }),
    fc.record({ not: tie('c') }),
  ),
})).c;
const context = fc.record(
  {
    a: fc.oneof(scalar, fc.array(scalar, { maxLength: 3 }), fc.constant(null)),
    b: scalar,
    c: fc.anything(),
  },
  { requiredKeys: [] },
);

describe('condition laws (property-based)', () => {
  it('never throws on arbitrary contexts', () => {
    fc.assert(
      fc.property(condition, fc.anything(), (c, x) => typeof evaluateCondition(c, x) === 'boolean'),
    );
  });
  it('double negation is identity', () => {
    fc.assert(
      fc.property(
        condition,
        context,
        (c, x) => evaluateCondition({ not: { not: c } }, x) === evaluateCondition(c, x),
      ),
    );
  });
  it('De Morgan: not(all(a,b)) == any(not a, not b)', () => {
    fc.assert(
      fc.property(
        condition,
        condition,
        context,
        (a, b, x) =>
          evaluateCondition({ not: { all: [a, b] } }, x) ===
          evaluateCondition({ any: [{ not: a }, { not: b }] }, x),
      ),
    );
  });
  it('all([c]) == any([c]) == c', () => {
    fc.assert(
      fc.property(condition, context, (c, x) => {
        const v = evaluateCondition(c, x);
        return evaluateCondition({ all: [c] }, x) === v && evaluateCondition({ any: [c] }, x) === v;
      }),
    );
  });
  it('generated conditions are accepted by the schema', () => {
    fc.assert(fc.property(condition, (c) => ConditionSchema.safeParse(c).success));
  });
});
