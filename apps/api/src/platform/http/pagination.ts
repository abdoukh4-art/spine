import { ValidationError } from '../errors.js';

/**
 * Opaque keyset cursors (ADR-0024). A cursor encodes the last item's sort key and id;
 * the next page is `WHERE (sortKey, id) < (cursor.sortKey, cursor.id)` for descending order.
 * Base64url keeps it URL-safe; it is *opaque*, not secret — clients must not parse it.
 */
export interface Cursor {
  /** Sort key of the last item: ISO timestamp, number, or null (for NULLS LAST sorts). */
  k: string | number | null;
  /** Tie-breaker id of the last item. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** @throws ValidationError on malformed cursors. */
export function decodeCursor(raw: string): Cursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof value === 'object' &&
      value !== null &&
      'id' in value &&
      typeof value.id === 'string' &&
      'k' in value &&
      (typeof value.k === 'string' || typeof value.k === 'number' || value.k === null)
    ) {
      return { k: value.k, id: value.id };
    }
  } catch {
    // fall through
  }
  throw new ValidationError('invalid cursor', [
    { path: 'query.cursor', message: 'malformed cursor' },
  ]);
}

/**
 * Given `limit + 1` fetched rows, returns the page and the cursor for the next one.
 * Fetching one extra row is how we know whether there is a next page without a COUNT.
 */
export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => Cursor,
): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: last === undefined ? null : encodeCursor(cursorOf(last)) };
}
