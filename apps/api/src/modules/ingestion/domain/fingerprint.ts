import { createHash } from 'node:crypto';
import type { Indicator } from '@spine/shared-schema';

/**
 * Deterministic deduplication fingerprint (ADR-0012):
 *
 *     sha256(vendor | product | sourceAlertId)                              when the source gives a stable id
 *     sha256(vendor | product | category | normalizedTitle | indicators…)   otherwise
 *
 * Each component is escaped (`\` → `\\`, `|` → `\|`) before joining, so a vendor named
 * `a|b` can never collide with vendor `a` + product `b`. The two forms have a different number
 * of unescaped separators (exactly 2 vs at least 3), so they can't collide with each other either.
 * Indicators must already be normalized (see indicators.ts); they are sorted here anyway so the
 * fingerprint never depends on input order.
 */
export interface FingerprintInput {
  source: { vendor: string; product: string; sourceAlertId?: string | undefined };
  category: string;
  title: string;
  indicators: readonly Indicator[];
}

function escape(component: string): string {
  return component.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Lower-cases, applies Unicode NFKC and collapses whitespace, so cosmetic title changes don't split alerts. */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The exact string that gets hashed (exposed so the docs and tests can show it). */
export function fingerprintMaterial(input: FingerprintInput): string {
  const { vendor, product, sourceAlertId } = input.source;
  if (sourceAlertId !== undefined && sourceAlertId.length > 0) {
    return [vendor, product, sourceAlertId].map(escape).join('|');
  }
  const indicators = input.indicators.map((i) => `${i.type}:${i.value}`).sort();
  return [vendor, product, input.category, normalizeTitle(input.title), ...indicators]
    .map(escape)
    .join('|');
}

/** 64 lower-case hex characters. */
export function computeFingerprint(input: FingerprintInput): string {
  return createHash('sha256').update(fingerprintMaterial(input), 'utf8').digest('hex');
}
