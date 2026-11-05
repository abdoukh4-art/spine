/** Formatting helpers shared by every page. All pure, all tested in format.test.ts. */

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** `28 Oct 2026, 12:00:00 UTC`. Always UTC, so analysts in different zones see the same time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormat.format(date);
}

/** Human duration from seconds: `42s`, `4m 12s`, `2h 5m`, `3d 4h`. `—` for null. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  return `${secs}s`;
}

/** `5 min ago` / `in 3 h`, relative to `now` (epoch ms). */
export function formatRelative(iso: string, now: number): string {
  const diffSeconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const label = formatDuration(Math.abs(diffSeconds));
  if (Math.abs(diffSeconds) < 5) return 'just now';
  return diffSeconds < 0 ? `${label} ago` : `in ${label}`;
}

/** `0.873` → `87.3 %`; `null` → `—`. */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return '—';
  return `${(ratio * 100).toFixed(1)} %`;
}

/** `in_progress` → `In progress`, `false_positive` → `False positive`. */
export function humanize(value: string): string {
  const spaced = value.replace(/[_.-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
