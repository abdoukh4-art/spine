import type { ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './cx';

/**
 * A loading indicator with an accessible label. `role="status"` makes screen readers
 * announce the label politely; the spinning ring itself is decorative.
 */
export function Spinner({
  label = 'Loading',
  inline = false,
}: {
  label?: string;
  inline?: boolean;
}) {
  return (
    <span role="status" className={cx('sp-spinner-wrap', inline && 'sp-spinner-wrap--inline')}>
      <span className="sp-spinner" aria-hidden="true" />
      <span className="sp-spinner__label">{label}…</span>
    </span>
  );
}

/** Shown when a list or query has no data. Says what's missing and, ideally, what to do. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sp-empty">
      <p className="sp-empty__title">{title}</p>
      {children ? <div className="sp-empty__body">{children}</div> : null}
    </div>
  );
}

/** An error message (`role="alert"`, announced immediately) with an optional retry button. */
export function ErrorState({
  title = 'Could not load this data',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="sp-error" role="alert">
      <p className="sp-error__title">{title}</p>
      <p>{message}</p>
      {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/** A callout box for notices (e.g. "SIMULATED", "data gaps"). Not a live region. */
export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning';
  title: string;
  children: ReactNode;
}) {
  return (
    <aside className={cx('sp-callout', `sp-callout--${tone}`)} aria-label={title}>
      <p className="sp-callout__title">
        <span aria-hidden="true">{tone === 'warning' ? '⚠ ' : 'ℹ '}</span>
        {title}
      </p>
      <div>{children}</div>
    </aside>
  );
}

/** One row of a {@link KeyValue} list. */
export interface KeyValueItem {
  label: string;
  value: ReactNode;
}

/** A description list (`<dl>`) of label/value pairs. Empty values render as an em dash. */
export function KeyValue({
  items,
  className,
}: {
  items: readonly KeyValueItem[];
  className?: string;
}) {
  return (
    <dl className={cx('sp-kv', className)}>
      {items.map((item) => (
        <div key={item.label} className="sp-kv__row">
          <dt>{item.label}</dt>
          <dd>
            {item.value === null || item.value === undefined || item.value === ''
              ? '—'
              : item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A 0–100 score with `role="meter"` semantics **and** the number as visible text, so the
 * value never depends on reading the bar's length or colour.
 */
export function ScoreBar({ score, label = 'Score' }: { score: number | null; label?: string }) {
  if (score === null) return <span className="sp-muted">Not scored</span>;
  const clamped = Math.max(0, Math.min(100, score));
  const band =
    clamped >= 80 ? 'critical' : clamped >= 60 ? 'high' : clamped >= 40 ? 'medium' : 'low';
  return (
    <span className="sp-score">
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-valuetext={`${clamped} out of 100`}
        className="sp-score__track"
      >
        <span
          className={cx('sp-score__fill', `sp-score__fill--${band}`)}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="sp-score__value" aria-hidden="true">
        {clamped}
      </span>
    </span>
  );
}

/** "Load more" pagination for cursor-based lists (ADR-0024: cursors can't jump to page N). */
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  shown,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  shown: number;
}) {
  return (
    <div className="sp-loadmore">
      <span className="sp-muted">
        Showing {shown} {shown === 1 ? 'item' : 'items'}
        {hasMore ? '' : ' (all loaded)'}
      </span>
      {hasMore ? (
        <Button onClick={onLoadMore} busy={loading}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}

/** One entry of a {@link Timeline}. */
export interface TimelineItem {
  id: string;
  /** ISO timestamp (machine-readable in `<time dateTime>`). */
  at: string;
  /** Pre-formatted timestamp text. */
  atLabel: string;
  title: string;
  description?: string;
  tone?: 'neutral' | 'success' | 'danger' | 'warning';
}

/** A chronological, ordered list of events (`<ol>`: order is meaningful). */
export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  return (
    <ol className="sp-timeline" aria-label={label}>
      {items.map((item) => (
        <li
          key={item.id}
          className={cx('sp-timeline__item', `sp-timeline__item--${item.tone ?? 'neutral'}`)}
        >
          <span className="sp-timeline__dot" aria-hidden="true" />
          <div>
            <p className="sp-timeline__title">{item.title}</p>
            {item.description ? <p className="sp-timeline__desc">{item.description}</p> : null}
            <time dateTime={item.at} className="sp-muted sp-small">
              {item.atLabel}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}
