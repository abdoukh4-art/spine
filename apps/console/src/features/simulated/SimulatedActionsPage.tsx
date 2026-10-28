import { SIMULATED_ACTION_KINDS, type SimulatedAction } from '@spine/shared-schema';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  Badge,
  Callout,
  EmptyState,
  LoadMore,
  PageHeader,
  QueryView,
  Select,
  Table,
} from '../../components';
import { queryKeys, useApi } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

const KIND_LABEL: Record<SimulatedAction['kind'], string> = {
  'firewall.block': 'Firewall: block',
  'firewall.unblock': 'Firewall: unblock',
  'ticket.create': 'Ticket: create',
  'ticket.close': 'Ticket: close',
  'chat.post': 'Chat: post message',
  'alert.set_status': 'Alert: set status',
};

/** `key=value` pairs of a small JSON object, for a compact table cell. */
export function compactJson(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
}

/** `/simulated-actions`: what the mock firewall, ticketing and chat adapters "did" (ADR-0018). */
export default function SimulatedActionsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const query = useInfiniteQuery({
    queryKey: queryKeys.simulatedActions(kind),
    queryFn: ({ pageParam }) =>
      api.simulatedActions.list({
        ...(kind ? { kind } : {}),
        limit: 50,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader
        title="Simulated actions"
        description="The response actions playbooks requested."
      />
      <Callout tone="warning" title="SIMULATED: nothing here touched a real system">
        <p>
          Spine ships only simulated adapters. Every “block”, “ticket” and “chat message” below was
          recorded, not performed. Dry-run actions are marked as such.
        </p>
      </Callout>
      <div className="sp-row" style={{ marginBottom: 'var(--space-4)' }}>
        <Select
          label="Action type"
          value={kind}
          options={[
            { value: '', label: 'All types' },
            ...SIMULATED_ACTION_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
          ]}
          onChange={(event) =>
            setParams(event.target.value ? { kind: event.target.value } : {}, { replace: true })
          }
        />
      </div>
      <QueryView
        query={query}
        loadingLabel="Loading simulated actions"
        isEmpty={(data) => (data.pages[0]?.items.length ?? 0) === 0}
        empty={<EmptyState title="No simulated actions yet." />}
      >
        {(data) => {
          const actions = data.pages.flatMap((p) => p.items);
          return (
            <>
              <Table caption="Simulated actions, newest first" captionHidden>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">Run</th>
                    <th scope="col">Request</th>
                    <th scope="col">Simulated response</th>
                  </tr>
                </thead>
                <tbody>
                  {actions.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.createdAt)}</td>
                      <th scope="row" style={{ fontWeight: 'normal' }}>
                        {KIND_LABEL[a.kind]}{' '}
                        {a.dryRun ? (
                          <Badge tone="warning">Dry run</Badge>
                        ) : (
                          <Badge>Simulated</Badge>
                        )}
                      </th>
                      <td>
                        {a.runId ? (
                          <Link to={`/runs/${a.runId}`} className="sp-mono">
                            {a.runId.slice(-8)}
                          </Link>
                        ) : (
                          '—'
                        )}
                        {a.stepId ? <div className="sp-small sp-muted">step {a.stepId}</div> : null}
                      </td>
                      <td className="sp-mono sp-break">{compactJson(a.request)}</td>
                      <td className="sp-mono sp-break">{compactJson(a.response)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <LoadMore
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
                shown={actions.length}
              />
            </>
          );
        }}
      </QueryView>
    </>
  );
}
