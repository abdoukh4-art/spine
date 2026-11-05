import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_BYTES, parsePlaybook } from '../src/parse.js';
import { formatPath, validatePlaybook } from '../src/validate.js';

const base = {
  apiVersion: 'spine/v1',
  kind: 'Playbook',
  metadata: { id: 'demo', name: 'Demo', version: 1 },
};

function playbook(steps: unknown[], start = 'a', extra: Record<string, unknown> = {}): unknown {
  return { ...base, start, steps, ...extra };
}

const notify = (id: string, next?: string) => ({
  id,
  type: 'notify',
  with: { channel: '#soc', template: 'hi' },
  ...(next ? { next } : {}),
});

function errorsOf(value: unknown): { path: string; message: string }[] {
  const result = validatePlaybook(value);
  return result.valid ? [] : result.errors;
}

describe('validatePlaybook', () => {
  it('accepts a valid DAG and applies schema defaults', () => {
    const result = validatePlaybook(playbook([notify('a', 'b'), notify('b')]));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.definition.steps[0]?.timeoutMs).toBe(30_000);
  });

  it('reports schema errors with bracketed paths', () => {
    const errors = errorsOf(
      playbook([
        { id: 'a', type: 'nope' },
        { id: 'b', type: 'notify', with: {} },
      ]),
    );
    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['steps[0].type', 'steps[1].with.channel', 'steps[1].with.template']),
    );
  });

  it('rejects duplicate step ids', () => {
    const errors = errorsOf(playbook([notify('a', 'b'), notify('b'), notify('b')]));
    expect(errors).toContainEqual({
      path: 'steps[2].id',
      message: 'duplicate step id "b" (first defined at steps[1])',
    });
  });

  it('rejects a missing start step', () => {
    expect(errorsOf(playbook([notify('a')], 'zzz'))).toContainEqual({
      path: 'start',
      message: 'start step "zzz" does not exist',
    });
  });

  it('rejects dangling next, onReject, branch and default references', () => {
    const errors = errorsOf(
      playbook([
        notify('a', 'missing-1'),
        {
          id: 'b',
          type: 'branch',
          branches: [{ when: { field: 'alert.x', op: 'exists' }, next: 'missing-2' }],
          default: 'missing-3',
        },
        { id: 'c', type: 'approval', with: { prompt: 'ok?' }, onReject: 'missing-4' },
      ]),
    );
    const paths = errors
      .filter((e) => e.message.startsWith('references unknown'))
      .map((e) => e.path);
    expect(paths).toEqual([
      'steps[0].next',
      'steps[1].branches[0].next',
      'steps[1].default',
      'steps[2].onReject',
    ]);
  });

  it('rejects a playbook whose graph has a cycle and reports the cycle path', () => {
    const errors = errorsOf(playbook([notify('a', 'b'), notify('b', 'c'), notify('c', 'a')]));
    expect(errors).toContainEqual({
      path: 'steps[2].next',
      message: 'cycle detected: a → b → c → a',
    });
  });

  it('rejects a self-loop', () => {
    expect(errorsOf(playbook([notify('a', 'a')]))).toContainEqual({
      path: 'steps[0].next',
      message: 'cycle detected: a → a',
    });
  });

  it('rejects steps that are unreachable from start', () => {
    expect(errorsOf(playbook([notify('a'), notify('orphan')]))).toContainEqual({
      path: 'steps[1]',
      message: 'step "orphan" is unreachable from start "a"',
    });
  });

  it('rejects unsafe regular expressions and overly deep conditions', () => {
    let deep: unknown = { field: 'alert.title', op: 'exists' };
    for (let i = 0; i < 17; i += 1) deep = { not: deep };
    const errors = errorsOf(
      playbook(
        [
          {
            id: 'a',
            type: 'branch',
            branches: [
              { when: { field: 'alert.title', op: 'matches', value: '(a+)+$' }, next: 'b' },
              { when: deep, next: 'b' },
            ],
          },
          notify('b'),
        ],
        'a',
        {
          trigger: {
            event: 'alert.scored',
            when: { field: 'alert.title', op: 'matches', value: '([' },
          },
        },
      ),
    );
    expect(errors.map((e) => e.path)).toEqual([
      'trigger.when',
      'steps[0].branches[0].when',
      'steps[0].branches[1].when',
    ]);
    expect(errors[2]?.message).toMatch(/nested 18 levels/);
  });

  it('returns every graph error at once, not just the first', () => {
    const errors = errorsOf(playbook([notify('a', 'a'), notify('b', 'nowhere'), notify('b')], 'x'));
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe('formatPath', () => {
  it('formats nested paths and the root', () => {
    expect(formatPath(['steps', 3, 'branches', 0, 'next'])).toBe('steps[3].branches[0].next');
    expect(formatPath([])).toBe('(root)');
  });
});

describe('parsePlaybook', () => {
  const yaml = `
apiVersion: spine/v1
kind: Playbook
metadata: { id: demo, name: Demo, version: 1 }
start: a
steps:
  - id: a
    type: notify
    with: { channel: '#soc', template: 'Alert {{alert.title}}' }
`;

  it('parses valid YAML', () => {
    const result = parsePlaybook(yaml, 'yaml');
    expect(result.valid).toBe(true);
  });

  it('parses valid JSON', () => {
    const result = parsePlaybook(JSON.stringify(playbook([notify('a')])), 'json');
    expect(result.valid).toBe(true);
  });

  it('reports invalid JSON', () => {
    const result = parsePlaybook('{"apiVersion":', 'json');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.message).toMatch(/^invalid JSON/);
  });

  it('reports YAML syntax errors with a line and column', () => {
    const result = parsePlaybook('a: [1, 2\n', 'yaml');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.path).toMatch(/^\(source\):\d+:\d+$/);
  });

  it('rejects duplicate YAML keys', () => {
    const result = parsePlaybook(`${yaml}start: b\n`, 'yaml');
    expect(result.valid).toBe(false);
  });

  it('rejects YAML tags, including built-in ones like !!binary', () => {
    for (const tagged of ['x: !!binary aGVsbG8=\n', 'x: !custom value\n', 'x: !!str 12\n']) {
      const result = parsePlaybook(tagged, 'yaml');
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.errors.some((e) => e.message.includes('tag'))).toBe(true);
    }
  });

  it('rejects a billion-laughs alias bomb', () => {
    const bomb = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
    ].join('\n');
    const result = parsePlaybook(bomb, 'yaml');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.message).toMatch(/alias/i);
  });

  it('rejects oversized sources before parsing', () => {
    const result = parsePlaybook(`# ${'x'.repeat(MAX_SOURCE_BYTES)}`, 'yaml');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.message).toMatch(/maximum/);
  });

  it('reports pathologically deep documents instead of crashing', () => {
    const depth = 20_000;
    const source = `${'{"not":'.repeat(depth)}{"field":"a","op":"exists"}${'}'.repeat(depth)}`;
    const result = parsePlaybook(
      JSON.stringify({ ...base, start: 'a', steps: [] }).replace('[]', `[${source}]`),
      'json',
    );
    expect(result.valid).toBe(false);
  });
});
