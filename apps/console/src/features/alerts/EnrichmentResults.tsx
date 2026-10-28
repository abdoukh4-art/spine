import type { EnrichmentData, EnrichmentResult } from '@spine/shared-schema';
import { EmptyState, StatusBadge, Table } from '../../components';

/** One-line, human summary of a provider's payload. */
export function summarizeEnrichment(data: EnrichmentData | undefined): string {
  if (!data) return '—';
  switch (data.kind) {
    case 'reputation':
      return `Reputation ${String(data.score)}/100${data.tags.length ? ` · ${data.tags.join(', ')}` : ''}`;
    case 'geo':
      return [
        data.country,
        data.city,
        data.org,
        data.asn ? `AS${String(data.asn)}` : null,
        data.isTor ? 'Tor exit node' : null,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'asset':
      return `Asset ${data.hostname} · criticality ${data.criticality}${data.owner ? ` · owner ${data.owner}` : ''}`;
  }
}

/** Groups results by indicator (`type:value`), keeping first-seen order. */
export function groupByIndicator(
  results: readonly EnrichmentResult[],
): [string, EnrichmentResult[]][] {
  const groups = new Map<string, EnrichmentResult[]>();
  for (const result of results) {
    const key = `${result.indicator.type}: ${result.indicator.value}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return [...groups.entries()];
}

/** Enrichment results, one table per indicator, with status and verdict as text badges. */
export function EnrichmentResults({ results }: { results: readonly EnrichmentResult[] }) {
  if (results.length === 0) return <EmptyState title="No enrichment results yet." />;
  return (
    <>
      {groupByIndicator(results).map(([indicator, rows]) => (
        <div key={indicator} style={{ marginBottom: 'var(--space-3)' }}>
          <Table caption={indicator}>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Status</th>
                <th scope="col">Verdict</th>
                <th scope="col">Details</th>
                <th scope="col" className="sp-num">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.provider}>
                  <th scope="row" style={{ fontWeight: 'normal' }}>
                    {row.provider}
                  </th>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td>{row.verdict ? <StatusBadge status={row.verdict} /> : '—'}</td>
                  <td className="sp-break">{row.error ?? summarizeEnrichment(row.data)}</td>
                  <td className="sp-num">{row.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      ))}
    </>
  );
}
