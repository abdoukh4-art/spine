import {
  IndicatorTypeSchema,
  ReputationDataSchema,
  type Indicator,
  type IndicatorType,
} from '@spine/shared-schema';
import { z } from 'zod';
import fixture from '../../fixtures/reputation.json' with { type: 'json' };
import { found, notFound, type Enricher } from '../enricher.js';
import { normalizeIndicator } from '../targets.js';
import { createMockEnricher, type FaultInjectionOptions } from './fault-injection.js';
import { isPrivateIp } from './ip.js';

/** Indicator types a reputation feed scores. */
export const REPUTATION_TYPES: readonly IndicatorType[] = [
  'ipv4',
  'ipv6',
  'domain',
  'url',
  'sha256',
  'md5',
];

const ReputationFixtureSchema = z.object({
  entries: z.array(
    ReputationDataSchema.omit({ kind: true }).extend({
      type: IndicatorTypeSchema,
      value: z.string().min(1),
    }),
  ),
});
type ReputationFixture = z.infer<typeof ReputationFixtureSchema>;

/**
 * Mock threat-intelligence reputation feed (think VirusTotal or AbuseIPDB), backed by
 * `fixtures/reputation.json`. Answers `found` with `{score, verdict, tags}` for known
 * indicators and `not_found` otherwise. Private IPs are not supported: no Internet feed
 * has an opinion on 10.0.0.1.
 *
 * @param data defaults to the bundled fixture; tests may pass their own.
 */
export function createReputationEnricher(
  options: FaultInjectionOptions = {},
  data: unknown = fixture,
): Enricher {
  const index = indexEntries(ReputationFixtureSchema.parse(data));
  return createMockEnricher(
    {
      name: 'reputation',
      indicatorTypes: REPUTATION_TYPES,
      supports: (indicator: Indicator) =>
        REPUTATION_TYPES.includes(indicator.type) &&
        !((indicator.type === 'ipv4' || indicator.type === 'ipv6') && isPrivateIp(indicator.value)),
      resolve: (indicator: Indicator) => {
        const entry = index.get(key(indicator));
        if (!entry) return notFound();
        return found(
          {
            kind: 'reputation',
            score: entry.score,
            verdict: entry.verdict,
            tags: entry.tags,
            ...(entry.firstSeen ? { firstSeen: entry.firstSeen } : {}),
          },
          entry.verdict,
        );
      },
    },
    options,
  );
}

function key(indicator: Indicator): string {
  const n = normalizeIndicator(indicator);
  return `${n.type}\u0000${n.value}`;
}

function indexEntries(
  parsed: ReputationFixture,
): Map<string, ReputationFixture['entries'][number]> {
  return new Map(parsed.entries.map((e) => [key({ type: e.type, value: e.value }), e]));
}
