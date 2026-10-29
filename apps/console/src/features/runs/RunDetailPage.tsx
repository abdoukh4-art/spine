import { TERMINAL_RUN_STATUSES, type RunDetail } from '@spine/shared-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  Badge,
  Button,
  KeyValue,
  PageHeader,
  QueryView,
  StatusBadge,
  Table,
  Timeline,
  useToast,
} from '../../components';
import { describeError, queryKeys, useApi } from '../../lib/api';
import { useCan } from '../../lib/auth/AuthProvider';
import { formatDateTime, formatDuration, humanize } from '../../lib/format';
import { toTimeline } from './describeEvent';
import { runDurationSeconds } from './RunsTable';

/** Poll interval while a run is still moving (ADR-0074). */
export const RUN_REFRESH_MS = 3_000;

/** True once a run can no longer change. */
export function isTerminal(run: Pick<RunDetail, 'status'>): boolean {
  return TERMINAL_RUN_STATUSES.includes(run.status);
}

function RunBody({ run }: { run: RunDetail }) {
  const api = useApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canCancel = useCan('analyst') && !isTerminal(run);
  const cancel = useMutation({
    mutationFn: () => api.runs.cancel(run.id),
    onSuccess: () => toast.show('Cancellation requested.', 'success'),
    onError: (error) => toast.show(describeError(error), 'error'),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs }),
  });
  return (
    <>
      <div className="sp-grid sp-grid--wide">
        <section className="sp-section" aria-labelledby="run-summary-h">
          <h2 id="run-summary-h">Summary</h2>
          <KeyValue
            items={[
              { label: 'Status', value: <StatusBadge status={run.status} /> },
              {
                label: 'Playbook',
                value: (
                  <Link
                    to={`/playbooks/${run.playbookId}`}
                  >{`${run.playbookId} v${String(run.playbookVersion)}`}</Link>
                ),
              },
              { label: 'Alert', value: <Link to={`/alerts/${run.alertId}`}>{run.alertId}</Link> },
              {
                label: 'Mode',
                value: run.dryRun ? (
                  <Badge tone="warning">Dry run: no actions taken</Badge>
                ) : (
                  'Live'
                ),
              },
              {
                label: 'Trigger',
                value: run.trigger === 'auto' ? 'Automatic (alert scored)' : 'Manual',
              },
              { label: 'Current step', value: run.currentStepId },
              { label: 'Created', value: formatDateTime(run.createdAt) },
              { label: 'Finished', value: run.finishedAt ? formatDateTime(run.finishedAt) : null },
              { label: 'Duration', value: formatDuration(runDurationSeconds(run)) },
            ]}
          />
          {canCancel ? (
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Button variant="danger" busy={cancel.isPending} onClick={() => cancel.mutate()}>
                Cancel run
              </Button>
            </div>
          ) : null}
        </section>
        <section className="sp-section" aria-labelledby="timeline-h">
          <h2 id="timeline-h">Timeline</h2>
          <Timeline items={toTimeline(run.events)} label="Run events, oldest first" />
        </section>
      </div>
      <section className="sp-section" aria-labelledby="steps-h">
        <h2 id="steps-h">Steps</h2>
        <Table caption="Steps in definition order" captionHidden>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Type</th>
              <th scope="col">State</th>
              <th scope="col" className="sp-num">
                Attempts
              </th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {run.steps.map((step) => (
              <tr key={step.stepId}>
                <th scope="row" className="sp-mono" style={{ fontWeight: 'normal' }}>
                  {step.stepId}
                </th>
                <td>{humanize(step.type)}</td>
                <td>
                  <StatusBadge status={step.status} />
                </td>
                <td className="sp-num">{step.attempts}</td>
                <td className="sp-break sp-small">
                  {step.error ??
                    (step.output === undefined ? '—' : <code>{JSON.stringify(step.output)}</code>)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>
    </>
  );
}

/** `/runs/:id`: a run's steps and event timeline, polling until the run is terminal. */
export default function RunDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => api.runs.get(id),
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data) ? false : RUN_REFRESH_MS),
    refetchIntervalInBackground: false,
  });
  const run = query.data;
  return (
    <>
      <PageHeader
        title={run ? `Run of ${run.playbookId}` : 'Playbook run'}
        description={
          run && !isTerminal(run) ? (
            `Live: refreshing every ${String(RUN_REFRESH_MS / 1000)} s until the run finishes.`
          ) : (
            <Link to="/runs">← All runs</Link>
          )
        }
      />
      <QueryView query={query} loadingLabel="Loading run">
        {(data) => <RunBody run={data} />}
      </QueryView>
    </>
  );
}
