import type { Severity } from '@spine/shared-schema';
import type { ReactNode } from 'react';
import { humanize } from '../lib/format';
import { cx } from './cx';

/** Colour family of a badge. Colour is always paired with text (WCAG 1.4.1). */
export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'progress'
  | 'sev-critical'
  | 'sev-high'
  | 'sev-medium'
  | 'sev-low'
  | 'sev-info';

/** A small inline label. Its meaning is carried by its **text**; colour only reinforces it. */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={cx('sp-badge', `sp-badge--${tone}`, className)}>{children}</span>;
}

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  critical: 'sev-critical',
  high: 'sev-high',
  medium: 'sev-medium',
  low: 'sev-low',
  informational: 'sev-info',
};

/** Non-colour cue: one to four bars, like a signal meter, so severity reads even in greyscale. */
const SEVERITY_GLYPH: Record<Severity, string> = {
  critical: '▮▮▮▮',
  high: '▮▮▮▯',
  medium: '▮▮▯▯',
  low: '▮▯▯▯',
  informational: '▯▯▯▯',
};

/** Severity as text + a bar glyph + colour. `null` means "not scored yet". */
export function SeverityBadge({ severity }: { severity: Severity | null }) {
  if (severity === null) return <Badge tone="neutral">Unscored</Badge>;
  return (
    <Badge tone={SEVERITY_TONE[severity]}>
      <span aria-hidden="true" className="sp-badge__glyph">
        {SEVERITY_GLYPH[severity]}
      </span>
      {humanize(severity)}
    </Badge>
  );
}

const STATUS_TONE: Record<string, BadgeTone> = {
  // alert statuses
  new: 'info',
  triaged: 'progress',
  in_progress: 'progress',
  resolved: 'success',
  false_positive: 'neutral',
  // run statuses
  pending: 'neutral',
  running: 'progress',
  waiting_approval: 'warning',
  compensating: 'warning',
  succeeded: 'success',
  failed: 'danger',
  compensated: 'warning',
  cancelled: 'neutral',
  // step statuses
  waiting: 'warning',
  skipped: 'neutral',
  // approval statuses
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
  // enrichment statuses
  ok: 'success',
  not_found: 'neutral',
  error: 'danger',
  timeout: 'danger',
  circuit_open: 'danger',
  // verdicts
  malicious: 'danger',
  suspicious: 'warning',
  benign: 'success',
  unknown: 'neutral',
};

/** Any lifecycle status (alert, run, step, approval, enrichment, verdict) as a text badge. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{humanize(status)}</Badge>;
}
