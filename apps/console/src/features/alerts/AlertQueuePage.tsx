import {
  ALERT_CATEGORIES,
  ALERT_STATUSES,
  SEVERITIES,
  type AlertSummary,
} from '@spine/shared-schema';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Button,
  CheckboxGroup,
  EmptyState,
  LoadMore,
  PageHeader,
  QueryView,
  ScoreBar,
  Select,
  SeverityBadge,
  SortableHeader,
  StatusBadge,
  Table,
  TextInput,
} from '../../components';
import { queryKeys, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth/AuthProvider';
import { formatDateTime, humanize } from '../../lib/format';
import {
  alertFiltersToParams,
  DEFAULT_ALERT_FILTERS,
  parseAlertFilters,
  toAlertListParams,
  type AlertFilters,
} from './filters';

/** How often the queue polls for new alerts (paused while the tab is hidden, ADR-0074). */
export const QUEUE_REFRESH_MS = 15_000;
const PAGE_SIZE = 25;

/** The filter form. Its draft state is local; "Apply" writes it to the URL. */
function FilterForm({
  initial,
  onApply,
}: {
  initial: AlertFilters;
  onApply: (f: AlertFilters) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const update = (patch: Partial<AlertFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(draft);
  };
  return (
    <form className="sp-section sp-filters" onSubmit={submit} aria-label="Alert filters">
      <div className="sp-row">
        <TextInput
          label="Search"
          hint="Part of the alert title"
          type="search"
          value={draft.q}
          maxLength={200}
          onChange={(e) => update({ q: e.target.value })}
        />
        <Select
          label="Category"
          value={draft.category ?? ''}
          options={[
            { value: '', label: 'Any category' },
            ...ALERT_CATEGORIES.map((c) => ({ value: c, label: humanize(c) })),
          ]}
          onChange={(e) =>
            update({ category: (e.target.value || null) as AlertFilters['category'] })
          }
        />
        <TextInput
          label="Minimum score"
          hint="0–100"
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          value={draft.minScore ?? ''}
          onChange={(e) =>
            update({ minScore: e.target.value === '' ? null : Number(e.target.value) })
          }
        />
        <TextInput
          label="MITRE technique"
          hint="e.g. T1059"
          value={draft.technique}
          maxLength={20}
          onChange={(e) => update({ technique: e.target.value })}
        />
      </div>
      <CheckboxGroup
        legend="Status"
        options={ALERT_STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
        value={draft.status}
        onChange={(status) => update({ status })}
      />
      <CheckboxGroup
        legend="Severity"
        options={[...SEVERITIES].reverse().map((s) => ({ value: s, label: humanize(s) }))}
        value={draft.severity}
        onChange={(severity) => update({ severity })}
      />
      <div className="sp-row">
        <Button type="submit" variant="primary">
          Apply filters
        </Button>
        <Button
          onClick={() => {
            setDraft(DEFAULT_ALERT_FILTERS);
            onApply(DEFAULT_ALERT_FILTERS);
          }}
        >
          Reset
        </Button>
      </div>
    </form>
  );
}

function AlertRow({ alert, myId }: { alert: AlertSummary; myId: string | undefined }) {
  return (
    <tr>
      <td>
        <SeverityBadge severity={alert.severity} />
      </td>
      <td>
        <ScoreBar score={alert.score} label={`Score of ${alert.title}`} />
      </td>
      <th scope="row" style={{ fontWeight: 'normal' }}>
        <Link to={`/alerts/${alert.id}`}>{alert.title}</Link>
        <div className="sp-muted sp-small">
          {alert.source.vendor} {alert.source.product}
          {alert.mitre[0] ? ` · ${alert.mitre[0].techniqueId}` : ''}
        </div>
      </th>
      <td>
        <StatusBadge status={alert.status} />
      </td>
      <td>{humanize(alert.category)}</td>
      <td className="sp-num">{alert.duplicateCount}</td>
      <td>{alert.assigneeId === null ? '—' : alert.assigneeId === myId ? 'You' : 'Assigned'}</td>
      <td>
        <time dateTime={alert.receivedAt}>{formatDateTime(alert.receivedAt)}</time>
      </td>
    </tr>
  );
}

/** `/alerts`: the triage queue. Filters and sort live in the URL; the list polls every 15 s. */
export default function AlertQueuePage() {
  const api = useApi();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = parseAlertFilters(searchParams);
  const apply = (next: AlertFilters) => setSearchParams(alertFiltersToParams(next));

  const query = useInfiniteQuery({
    queryKey: queryKeys.alertList(filters),
    queryFn: ({ pageParam }) =>
      api.alerts.list({
        ...toAlertListParams(filters),
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: QUEUE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  const sortDirection = (column: AlertFilters['sort']) =>
    filters.sort === column ? filters.order : null;
  const sortBy = (column: AlertFilters['sort']) => (order: AlertFilters['order']) =>
    apply({ ...filters, sort: column, order });

  return (
    <>
      <PageHeader
        title="Alert queue"
        description={
          <>
            Updates automatically every {QUEUE_REFRESH_MS / 1000} s while this tab is visible.
            {query.dataUpdatedAt > 0
              ? ` Last updated ${formatDateTime(new Date(query.dataUpdatedAt).toISOString())}.`
              : ''}
          </>
        }
        actions={
          <Button onClick={() => void query.refetch()} busy={query.isRefetching}>
            Refresh now
          </Button>
        }
      />
      <FilterForm key={searchParams.toString()} initial={filters} onApply={apply} />
      <QueryView
        query={query}
        loadingLabel="Loading alerts"
        isEmpty={(data) => (data.pages[0]?.items.length ?? 0) === 0}
        empty={
          <EmptyState title="No alerts match these filters.">
            <p>Try removing a filter, or reset them all.</p>
          </EmptyState>
        }
      >
        {(data) => {
          const alerts = data.pages.flatMap((p) => p.items);
          return (
            <>
              <Table caption={`Alerts (${String(alerts.length)} shown)`} captionHidden>
                <thead>
                  <tr>
                    <th scope="col">Severity</th>
                    <SortableHeader
                      label="Score"
                      direction={sortDirection('score')}
                      onSort={sortBy('score')}
                    />
                    <th scope="col">Alert</th>
                    <th scope="col">Status</th>
                    <th scope="col">Category</th>
                    <th scope="col" className="sp-num">
                      Duplicates
                    </th>
                    <th scope="col">Assignee</th>
                    <SortableHeader
                      label="Received"
                      direction={sortDirection('receivedAt')}
                      onSort={sortBy('receivedAt')}
                    />
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((alert) => (
                    <AlertRow key={alert.id} alert={alert} myId={user?.id} />
                  ))}
                </tbody>
              </Table>
              <LoadMore
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
                shown={alerts.length}
              />
            </>
          );
        }}
      </QueryView>
    </>
  );
}
