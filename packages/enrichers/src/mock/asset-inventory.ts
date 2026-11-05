import { AssetDataSchema, type Indicator, type IndicatorType } from '@spine/shared-schema';
import { z } from 'zod';
import fixture from '../../fixtures/asset-inventory.json' with { type: 'json' };
import { found, notFound, type Enricher } from '../enricher.js';
import { createMockEnricher, type FaultInjectionOptions } from './fault-injection.js';
import { isPrivateIp } from './ip.js';

/** Indicator types the asset inventory can resolve to an asset. */
export const ASSET_TYPES: readonly IndicatorType[] = ['hostname', 'ipv4', 'ipv6'];

const AssetFixtureSchema = z.object({
  assets: z.array(
    AssetDataSchema.omit({ kind: true }).extend({ ips: z.array(z.string()).default([]) }),
  ),
});
type AssetEntry = z.infer<typeof AssetFixtureSchema>['assets'][number];

/**
 * Mock asset inventory / CMDB, backed by `fixtures/asset-inventory.json`. Resolves a
 * hostname (FQDN, or short name such as `DC01`) or an **internal** IP to the asset's owner,
 * business unit, criticality and tags. That is the context that turns "malware on a
 * laptop" into "malware on the domain controller".
 *
 * @param data defaults to the bundled fixture; tests may pass their own.
 */
export function createAssetInventoryEnricher(
  options: FaultInjectionOptions = {},
  data: unknown = fixture,
): Enricher {
  const { byHost, byIp } = indexAssets(AssetFixtureSchema.parse(data).assets);
  return createMockEnricher(
    {
      name: 'asset-inventory',
      indicatorTypes: ASSET_TYPES,
      supports: (indicator: Indicator) =>
        indicator.type === 'hostname' ||
        ((indicator.type === 'ipv4' || indicator.type === 'ipv6') && isPrivateIp(indicator.value)),
      resolve: (indicator: Indicator) => {
        const value = indicator.value.trim().toLowerCase();
        const asset = indicator.type === 'hostname' ? byHost.get(value) : byIp.get(value);
        if (!asset) return notFound();
        const { ips: _ips, ...rest } = asset;
        return found({ kind: 'asset', ...rest });
      },
    },
    options,
  );
}

function indexAssets(assets: readonly AssetEntry[]): {
  byHost: Map<string, AssetEntry>;
  byIp: Map<string, AssetEntry>;
} {
  const byHost = new Map<string, AssetEntry>();
  const byIp = new Map<string, AssetEntry>();
  for (const asset of assets) {
    const fqdn = asset.hostname.toLowerCase();
    byHost.set(fqdn, asset);
    const shortName = fqdn.split('.')[0];
    if (shortName && !byHost.has(shortName)) byHost.set(shortName, asset);
    for (const ip of asset.ips) byIp.set(ip.toLowerCase(), asset);
  }
  return { byHost, byIp };
}
