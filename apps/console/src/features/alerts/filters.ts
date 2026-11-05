import {
  ALERT_CATEGORIES,
  ALERT_STATUSES,
  SEVERITIES,
  type AlertCategory,
  type AlertStatus,
  type Severity,
} from '@spine/shared-schema';
import type { AlertListParams } from '../../lib/api';

/**
 * The alert queue's filter state. It lives in the URL search params (not in React state
 * or a store), so a filtered view is bookmarkable, shareable and survives a reload, and
 * the Back button undoes a filter change (ADR-0023).
 */
export interface AlertFilters {
  status: AlertStatus[];
  severity: Severity[];
  minScore: number | null;
  category: AlertCategory | null;
  q: string;
  technique: string;
  sort: 'receivedAt' | 'score';
  order: 'asc' | 'desc';
}

/** Filters when the URL has none: the open work, newest first. */
export const DEFAULT_ALERT_FILTERS: AlertFilters = {
  status: [],
  severity: [],
  minScore: null,
  category: null,
  q: '',
  technique: '',
  sort: 'receivedAt',
  order: 'desc',
};

const oneOf = <T extends string>(allowed: readonly T[], value: string | null): T | null =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;

/** Reads filters from search params, silently dropping values that aren't valid. */
export function parseAlertFilters(params: URLSearchParams): AlertFilters {
  const minScoreRaw = params.get('minScore');
  const minScore = minScoreRaw === null || minScoreRaw === '' ? null : Number(minScoreRaw);
  return {
    status: params
      .getAll('status')
      .filter((s): s is AlertStatus => oneOf(ALERT_STATUSES, s) !== null),
    severity: params.getAll('severity').filter((s): s is Severity => oneOf(SEVERITIES, s) !== null),
    minScore:
      minScore !== null && Number.isInteger(minScore) && minScore >= 0 && minScore <= 100
        ? minScore
        : null,
    category: oneOf(ALERT_CATEGORIES, params.get('category')),
    q: (params.get('q') ?? '').slice(0, 200),
    technique: (params.get('technique') ?? '').slice(0, 20),
    sort: params.get('sort') === 'score' ? 'score' : 'receivedAt',
    order: params.get('order') === 'asc' ? 'asc' : 'desc',
  };
}

/** Writes filters to search params, omitting defaults so URLs stay short. */
export function alertFiltersToParams(filters: AlertFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const s of filters.status) params.append('status', s);
  for (const s of filters.severity) params.append('severity', s);
  if (filters.minScore !== null) params.set('minScore', String(filters.minScore));
  if (filters.category) params.set('category', filters.category);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.technique.trim()) params.set('technique', filters.technique.trim().toUpperCase());
  if (filters.sort !== 'receivedAt') params.set('sort', filters.sort);
  if (filters.order !== 'desc') params.set('order', filters.order);
  return params;
}

/** Maps filters onto the `GET /alerts` query. */
export function toAlertListParams(filters: AlertFilters): AlertListParams {
  const params: AlertListParams = { sort: filters.sort, order: filters.order };
  if (filters.status.length > 0) params.status = filters.status;
  if (filters.severity.length > 0) params.severity = filters.severity;
  if (filters.minScore !== null) params.minScore = filters.minScore;
  if (filters.category) params.category = filters.category;
  if (filters.q.trim()) params.q = filters.q.trim();
  if (filters.technique.trim()) params.technique = filters.technique.trim().toUpperCase();
  return params;
}
