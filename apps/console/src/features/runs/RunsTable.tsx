import type { RunSummary } from '@spine/shared-schema';
import { Link } from 'react-router';
import { Badge, StatusBadge, Table } from '../../components';
import { formatDateTime, formatDuration } from '../../lib/format';

/** Wall-clock duration of a run in seconds, or null while it hasn't both started and finished. */
export function runDurationSeconds(
  run: Pick<RunSummary, 'startedAt' | 'finishedAt'>,
): number | null {
  if (!run.startedAt || !run.finishedAt) return null;
  return (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
}

/** A table of run summaries; used by the runs list and the alert detail page. */
export function RunsTable({
  runs,
  caption,
  showAlert = true,
}: {
  runs: readonly RunSummary[];
  caption: string;
  showAlert?: boolean;
}) {
  return (
    <Table caption={caption} captionHidden>
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Playbook</th>
          {showAlert ? <th scope="col">Alert</th> : null}
          <th scope="col">Status</th>
          <th scope="col">Mode</th>
          <th scope="col">Started</th>
          <th scope="col" className="sp-num">
            Duration
          </th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <th scope="row" style={{ fontWeight: 'normal' }}>
              <Link to={`/runs/${run.id}`} className="sp-mono">
                {run.id.slice(-8)}
              </Link>
            </th>
            <td>
              <Link to={`/playbooks/${run.playbookId}`}>{run.playbookId}</Link>{' '}
              <span className="sp-muted sp-small">v{run.playbookVersion}</span>
            </td>
            {showAlert ? (
              <td>
                <Link to={`/alerts/${run.alertId}`} className="sp-mono">
                  {run.alertId.slice(-8)}
                </Link>
              </td>
            ) : null}
            <td>
              <StatusBadge status={run.status} />
            </td>
            <td>
              {run.dryRun ? <Badge tone="warning">Dry run</Badge> : null}{' '}
              {run.trigger === 'auto' ? 'Automatic' : 'Manual'}
            </td>
            <td>{formatDateTime(run.startedAt ?? run.createdAt)}</td>
            <td className="sp-num">{formatDuration(runDurationSeconds(run))}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
