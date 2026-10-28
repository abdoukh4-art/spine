import { RUN_STATUSES } from '@spine/shared-schema';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { EmptyState, LoadMore, PageHeader, QueryView, Select } from '../../components';
import { queryKeys, useApi, type RunListParams } from '../../lib/api';
import { humanize } from '../../lib/format';
import { RunsTable } from './RunsTable';

/** `/runs`: every playbook run, newest first, filterable by status (kept in the URL). */
export default function RunsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const playbookId = params.get('playbookId') ?? '';
  const filters: RunListParams = {
    ...(status ? { status } : {}),
    ...(playbookId ? { playbookId } : {}),
  };
  const query = useInfiniteQuery({
    queryKey: queryKeys.runList(filters),
    queryFn: ({ pageParam }) =>
      api.runs.list({ ...filters, limit: 25, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <PageHeader title="Playbook runs" description="Automatic and manual runs, newest first." />
      <div className="sp-row" style={{ marginBottom: 'var(--space-4)' }}>
        <Select
          label="Status"
          value={status}
          options={[
            { value: '', label: 'Any status' },
            ...RUN_STATUSES.map((s) => ({ value: s, label: humanize(s) })),
          ]}
          onChange={(event) => setFilter('status', event.target.value)}
        />
      </div>
      <QueryView
        query={query}
        loadingLabel="Loading runs"
        isEmpty={(data) => (data.pages[0]?.items.length ?? 0) === 0}
        empty={<EmptyState title="No runs match." />}
      >
        {(data) => {
          const runs = data.pages.flatMap((p) => p.items);
          return (
            <>
              <RunsTable runs={runs} caption="Playbook runs" />
              <LoadMore
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
                shown={runs.length}
              />
            </>
          );
        }}
      </QueryView>
    </>
  );
}
