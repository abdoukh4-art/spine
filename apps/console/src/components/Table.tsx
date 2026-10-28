import type { ReactNode } from 'react';
import { cx } from './cx';

/** Props for {@link Table}. */
export interface TableProps {
  /** Every data table needs a caption: it names the table for screen-reader table lists. */
  caption: string;
  /** Hide the caption visually (it stays available to assistive technology). */
  captionHidden?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * A semantic `<table>` in a horizontally scrollable, keyboard-focusable wrapper (so the
 * overflow can be scrolled without a mouse: axe rule `scrollable-region-focusable`).
 * Children are ordinary `<thead>`/`<tbody>` markup: the browser's table semantics are the API.
 */
export function Table({ caption, captionHidden = false, children, className }: TableProps) {
  return (
    <div className="sp-table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className={cx('sp-table', className)}>
        <caption className={captionHidden ? 'visually-hidden' : 'sp-table__caption'}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

/** Sort direction of a sortable column. */
export type SortDirection = 'asc' | 'desc';

/** Props for {@link SortableHeader}. */
export interface SortableHeaderProps {
  label: string;
  /** Direction if this column is the active sort, otherwise null. */
  direction: SortDirection | null;
  /** Called with the direction the user asked for. */
  onSort: (direction: SortDirection) => void;
  className?: string;
}

/**
 * A column header that sorts. `aria-sort` sits on the `<th>` (only on the sorted column,
 * as the WAI-ARIA APG recommends) and the clickable part is a real `<button>`.
 */
export function SortableHeader({ label, direction, onSort, className }: SortableHeaderProps) {
  const ariaSort =
    direction === null ? undefined : direction === 'asc' ? 'ascending' : 'descending';
  const next: SortDirection = direction === 'desc' ? 'asc' : 'desc';
  return (
    <th scope="col" aria-sort={ariaSort} className={className}>
      <button type="button" className="sp-sort" onClick={() => onSort(next)}>
        {label}
        <span aria-hidden="true" className="sp-sort__icon">
          {direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : '↕'}
        </span>
      </button>
    </th>
  );
}
