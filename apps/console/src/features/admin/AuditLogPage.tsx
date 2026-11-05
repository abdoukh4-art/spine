import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  EmptyState,
  LoadMore,
  PageHeader,
  QueryView,
  Table,
  TextInput,
} from '../../components';
import { queryKeys, useApi, type AuditListParams } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

/** `datetime-local` value (`2026-10-28T12:00`, read as UTC) → ISO string, or undefined. */
export function localInputToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}:00Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const FILTER_KEYS = ['actorId', 'action', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];

/** `/admin/audit-log`: the append-only audit trail (ADR-0016), filterable, newest first. */
export default function AuditLogPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const current = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<
    FilterKey,
    string
  >;
  const [draft, setDraft] = useState(current);
  const filters: AuditListParams = {};
  if (current.actorId) filters.actorId = current.actorId;
  if (current.action) filters.action = current.action;
  const from = localInputToIso(current.from);
  const to = localInputToIso(current.to);
  if (from) filters.from = from;
  if (to) filters.to = to;

  const query = useInfiniteQuery({
    queryKey: queryKeys.audit(filters),
    queryFn: ({ pageParam }) =>
      api.audit.list({ ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const key of FILTER_KEYS) if (draft[key].trim()) next.set(key, draft[key].trim());
    setParams(next);
  };
  const field = (key: FilterKey) => ({
    value: draft[key],
    onChange: (e: { target: { value: string } }) =>
      setDraft((d) => ({ ...d, [key]: e.target.value })),
  });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every mutating request and security event. Append-only."
      />
      <form className="sp-section sp-row" onSubmit={submit} aria-label="Audit log filters">
        <TextInput label="Action starts with" hint="e.g. auth. or approval." {...field('action')} />
        <TextInput label="Actor ID" hint="User UUID" {...field('actorId')} />
        <TextInput label="From (UTC)" type="datetime-local" {...field('from')} />
        <TextInput label="To (UTC)" type="datetime-local" {...field('to')} />
        <Button type="submit" variant="primary">
          Apply filters
        </Button>
      </form>
      <QueryView
        query={query}
        loadingLabel="Loading audit log"
        isEmpty={(data) => (data.pages[0]?.items.length ?? 0) === 0}
        empty={<EmptyState title="No audit entries match." />}
      >
        {(data) => {
          const entries = data.pages.flatMap((p) => p.items);
          return (
            <>
              <Table caption="Audit entries, newest first" captionHidden>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Action</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Target</th>
                    <th scope="col" className="sp-num">
                      Outcome
                    </th>
                    <th scope="col">Request</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDateTime(e.occurredAt)}</td>
                      <th scope="row" className="sp-mono" style={{ fontWeight: 'normal' }}>
                        {e.action}
                      </th>
                      <td className="sp-small">
                        {e.actorType}
                        {e.actorId ? <div className="sp-mono sp-muted">{e.actorId}</div> : null}
                      </td>
                      <td className="sp-small">
                        {e.targetType ?? '—'}{' '}
                        {e.targetId ? <div className="sp-mono sp-muted">{e.targetId}</div> : null}
                      </td>
                      <td className="sp-num">{e.outcomeStatus ?? '—'}</td>
                      <td className="sp-small sp-mono">
                        {e.requestId ?? '—'}
                        {e.ip ? <div className="sp-muted">{e.ip}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <LoadMore
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onLoadMore={() => void query.fetchNextPage()}
                shown={entries.length}
              />
            </>
          );
        }}
      </QueryView>
    </>
  );
}
