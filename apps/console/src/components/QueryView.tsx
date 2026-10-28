import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describeError } from '../lib/api/errors';
import { EmptyState, ErrorState, Spinner } from './Display';

/** Props for {@link QueryView}. */
export interface QueryViewProps<T> {
  query: Pick<UseQueryResult<T>, 'data' | 'error' | 'isPending' | 'refetch'>;
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
  if (query.error) {
    return <ErrorState message={describeError(query.error)} onRetry={() => void query.refetch()} />;
  }
  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty ?? <EmptyState title="Nothing here yet." />}</>;
  return <>{children(data)}</>;
}
