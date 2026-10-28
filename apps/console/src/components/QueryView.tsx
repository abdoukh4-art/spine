import type { ReactNode } from 'react';
import { describeError } from '../lib/api/errors';
import { EmptyState, ErrorState, Spinner } from './Display';

/** Props for {@link QueryView}. */
export interface QueryViewProps<T> {
  /** The parts of a TanStack query result we need (works for `useQuery` and `useInfiniteQuery`). */
  query: {
    data: T | undefined;
    error: unknown;
    isPending: boolean;
    refetch: () => Promise<unknown>;
  };
  /** Accessible label of the loading spinner, e.g. "Loading alerts". */
  loadingLabel: string;
  /** Returns true when the loaded data should show the empty state instead. */
  isEmpty?: (data: T) => boolean;
  /** Rendered when `isEmpty` returns true. */
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

/**
 * Renders the four states every data view has (loading, error with retry, empty,
 * success) the same way everywhere, so no page forgets one of them.
 */
export function QueryView<T>({ query, loadingLabel, isEmpty, empty, children }: QueryViewProps<T>) {
  if (query.isPending) return <Spinner label={loadingLabel} />;
  const retry = () => void query.refetch();
  if (query.data === undefined) {
    return <ErrorState message={describeError(query.error)} onRetry={retry} />;
  }
  const data = query.data;
  // A failed *background* refresh keeps showing the last good data, with a notice:
  // a network blip must not wipe an analyst's queue.
  const staleNotice = query.error ? (
    <ErrorState
      title="Could not refresh; showing the last data received"
      message={describeError(query.error)}
      onRetry={retry}
    />
  ) : null;
  if (isEmpty?.(data)) {
    return (
      <>
        {staleNotice}
        {empty ?? <EmptyState title="Nothing here yet." />}
      </>
    );
  }
  return (
    <>
      {staleNotice}
      {children(data)}
    </>
  );
}
