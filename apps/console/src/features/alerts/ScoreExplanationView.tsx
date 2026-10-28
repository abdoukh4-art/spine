import type { ScoreExplanation } from '@spine/shared-schema';
import { Callout, ScoreBar, SeverityBadge, Table } from '../../components';
import { formatDateTime } from '../../lib/format';

/** `+25` / `−10` / `0`, with a real minus sign so screen readers say "minus". */
export function formatPoints(points: number): string {
  if (points > 0) return `+${String(points)}`;
  if (points < 0) return `−${String(Math.abs(points))}`;
  return '0';
}

/**
 * The "why" behind a score (ADR-0015): every factor with its points and evidence, the
 * raw sum and the clamp to 0–100, and — called out loudly — the providers that failed,
 * because a low score might be low only because data was missing.
 */
export function ScoreExplanationView({ score }: { score: ScoreExplanation | null }) {
  if (score === null) {
    return (
      <p>
        This alert has not been scored yet. Scoring runs after enrichment; this page refreshes when
        it completes.
      </p>
    );
  }
  const clamped = score.rawScore !== score.score;
  return (
    <>
      <div className="sp-row" style={{ alignItems: 'center', marginBottom: 'var(--space-3)' }}>
        <span className="sp-score--large">
          <ScoreBar score={score.score} label="Alert score" />
        </span>
        <SeverityBadge severity={score.severity} />
        <span className="sp-muted sp-small">
          Ruleset v{score.rulesetVersion} · computed {formatDateTime(score.computedAt)}
        </span>
      </div>
      {score.dataGaps.length > 0 ? (
        <Callout tone="warning" title="Data gaps: this score may be too low">
          <p>
            These enrichment providers failed for this alert, so rules that depend on them could not
            match: <strong>{score.dataGaps.join(', ')}</strong>. Re-run enrichment once they
            recover.
          </p>
        </Callout>
      ) : null}
      <Table caption="Score factors">
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Why it matched</th>
            <th scope="col">Evidence</th>
            <th scope="col" className="sp-num">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {score.factors.map((factor) => (
            <tr key={factor.ruleId}>
              <th scope="row" className="sp-mono" style={{ fontWeight: 'normal' }}>
                {factor.ruleId}
              </th>
              <td>{factor.description}</td>
              <td className="sp-break">{factor.evidence ?? '—'}</td>
              <td className="sp-num">{formatPoints(factor.points)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3} style={{ textAlign: 'right' }}>
              {clamped ? 'Raw total (clamped to 0–100)' : 'Total'}
            </th>
            <td className="sp-num">
              <strong>
                {score.rawScore}
                {clamped ? ` → ${String(score.score)}` : ''}
              </strong>
            </td>
          </tr>
        </tfoot>
      </Table>
    </>
  );
}
