import type { ScoreExplanation } from '@spine/shared-schema';
import { describe, expect, it } from 'vitest';
import type {
  ScoreRepository,
  ScoringTransaction,
} from '../../../src/modules/scoring/application/ports.js';
import { ScoringApplication } from '../../../src/modules/scoring/application/scoring-app.js';
import { ManualClock } from '../../../src/platform/runtime.js';
import { results, smallRuleset, testAlert } from './fixtures.js';

/** In-memory twin of the Postgres adapter's rules (ADR-0042). */
class InMemoryScores implements ScoreRepository {
  readonly rows = new Map<string, { explanation: ScoreExplanation; at: number }>();
  readonly published: string[] = [];

  transaction<T>(work: (tx: ScoringTransaction) => Promise<T>): Promise<T> {
    return work({
      saveIfChanged: (alertId, explanation, at) => {
        const key = `${alertId}|${explanation.rulesetVersion}`;
        const old = this.rows.get(key);
        if (old && at.getTime() < old.at) return Promise.resolve(false);
        const strip = ({ computedAt: _c, ...rest }: ScoreExplanation) => JSON.stringify(rest);
        const changed = !old || strip(old.explanation) !== strip(explanation);
        this.rows.set(key, {
          explanation: changed ? explanation : old.explanation,
          at: at.getTime(),
        });
        return Promise.resolve(changed);
      },
      publish: (events) => {
        this.published.push(...events.map((e) => e.type));
        return Promise.resolve();
      },
    });
  }
  latestForAlert(alertId: string): Promise<ScoreExplanation | null> {
    const row = [...this.rows.entries()].find(([k]) => k.startsWith(`${alertId}|`));
    return Promise.resolve(row ? row[1].explanation : null);
  }
}

function setup() {
  const clock = new ManualClock('2026-10-28T10:00:00Z');
  const repository = new InMemoryScores();
  const app = new ScoringApplication({ ruleset: smallRuleset, repository, clock });
  return { app, repository, clock };
}

describe('ScoringApplication', () => {
  it('stores and publishes a new score once; a redelivery publishes nothing', async () => {
    const { app, repository, clock } = setup();
    const snapshotAt = new Date('2026-10-28T09:59:59Z');
    const first = await app.scoreSnapshot(testAlert(), [results.malicious()], snapshotAt);
    clock.advance(5000);
    const again = await app.scoreSnapshot(testAlert(), [results.malicious()], snapshotAt);
    expect(first).toMatchObject({ published: true, explanation: { score: 70 } });
    expect(again.published).toBe(false);
    expect(repository.published).toEqual(['alert.scored']);
  });

  it('publishes again when a newer snapshot changes the score, never for a stale one', async () => {
    const { app, repository } = setup();
    const t = (s: number) => new Date(Date.parse('2026-10-28T10:00:00Z') + s * 1000);
    await app.scoreSnapshot(testAlert(), [], t(1));
    await app.scoreSnapshot(testAlert(), [results.malicious()], t(3));
    const stale = await app.scoreSnapshot(testAlert(), [], t(2));
    expect(stale.published).toBe(false);
    expect(repository.published).toHaveLength(2);
    expect((await app.getForAlert(testAlert().id))?.score).toBe(70);
  });

  it('previews without storing, and scoreAndStore stores', async () => {
    const { app, repository } = setup();
    expect(app.preview(testAlert(), []).score).toBe(40);
    expect(repository.rows.size).toBe(0);
    expect((await app.scoreAndStore(testAlert(), [results.asset('critical')])).score).toBe(60);
    expect(repository.published).toEqual(['alert.scored']);
    expect(app.activeRuleset().version).toBe(7);
    expect(await app.getForAlert('00000000-0000-7000-8000-00000000ffff')).toBeNull();
  });
});
