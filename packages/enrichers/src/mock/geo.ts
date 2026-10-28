import { GeoDataSchema, type Indicator, type IndicatorType } from '@spine/shared-schema';
import { z } from 'zod';
import fixture from '../../fixtures/geo.json' with { type: 'json' };
import { found, notFound, type Enricher } from '../enricher.js';
import { normalizeIndicator } from '../targets.js';
import { createMockEnricher, type FaultInjectionOptions } from './fault-injection.js';
import { isPrivateIp } from './ip.js';

/** Indicator types a geo-IP database resolves. */
export const GEO_TYPES: readonly IndicatorType[] = ['ipv4', 'ipv6'];

const GeoFixtureSchema = z.object({
  entries: z.array(GeoDataSchema.omit({ kind: true }).extend({ ip: z.string().min(1) })),
});

/**
 * Mock geo-IP database (think MaxMind GeoLite2), backed by `fixtures/geo.json`. Resolves
 * public IPs to country, city, ASN, organization and whether the address is a Tor exit
 * node. Geo carries no verdict on its own; scoring rules decide what a country or Tor means.
 *
 * @param data defaults to the bundled fixture; tests may pass their own.
 */
export function createGeoEnricher(
  options: FaultInjectionOptions = {},
  data: unknown = fixture,
): Enricher {
  const parsed = GeoFixtureSchema.parse(data);
  const index = new Map(parsed.entries.map((e) => [normalizeIp(e.ip), e] as const));
  return createMockEnricher(
    {
      name: 'geo',
      indicatorTypes: GEO_TYPES,
      supports: (indicator: Indicator) =>
        GEO_TYPES.includes(indicator.type) && !isPrivateIp(indicator.value),
      resolve: (indicator: Indicator) => {
        const entry = index.get(normalizeIp(indicator.value));
        if (!entry) return notFound();
        const { ip: _ip, ...geo } = entry;
        return found({ kind: 'geo', ...geo });
      },
    },
    options,
  );
}

function normalizeIp(ip: string): string {
  return normalizeIndicator({ type: ip.includes(':') ? 'ipv6' : 'ipv4', value: ip }).value;
}
