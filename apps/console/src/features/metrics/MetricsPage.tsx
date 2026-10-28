import { SEVERITIES, type DurationStat, type MetricsSummary } from '@spine/shared-schema';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { BarChart, PageHeader, QueryView } from '../../components';
import { queryKeys, useApi } from '../../lib/api';
import { formatDateTime, formatDuration, formatPercent, humanize } from '../../lib/format';

/** Selectable time windows, in milliseconds. */
export const WINDOWS = {
  '24h': { label: 'Last 24 hours', ms: 86_400_000 },
  '7d': { label: 'Last 7 days', ms: 7 * 86_400_000 },
  '30d': { label: 'Last 30 days', ms: 30 * 86_400_000 },
} as const;
export type WindowKey = keyof typeof WINDOWS;

/** `2026-10-28` → `28 Oct` (UTC). */
export function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
        date,
      );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="sp-tile">
      <dt>{label}</dt>
      <dd>
        {value}
        {sub ? <span className="sp-tile__sub">{sub}</span> : null}
      </dd>
    </div>
  );
}

function StatTiles({
  name,
  stat,
  extra,
}: {
  name: string;
  stat: DurationStat;
  extra?: { label: string; value: string }[];
}) {
  return (
    <dl className="sp-tiles" aria-label={name}>
      <Tile label="Mean" value={formatDuration(stat.meanSeconds)} />
      <Tile label="Median (p50)" value={formatDuration(stat.p50Seconds)} />
      <Tile label="90th percentile" value={formatDuration(stat.p90Seconds)} />
      <Tile label="Sample size" value={String(stat.count)} />
      {extra?.map((e) => (
        <Tile key={e.label} label={e.label} value={e.value} />
      ))}
    </dl>
  );
}

function MetricsBody({ m }: { m: MetricsSummary }) {
  const severityData = [...SEVERITIES]
    .reverse()
    .map((s) => ({ label: humanize(s), value: m.alertVolume.bySeverity[s] }));
  const dayData = m.alertVolume.byDay.map((d) => ({ label: shortDay(d.day), value: d.count }));
  const runs = m.playbooks.runs;
  return (
    <>
      <p className="sp-muted">
        Window: {formatDateTime(m.window.from)} – {formatDateTime(m.window.to)}. Definitions:{' '}
        <a href="https://github.com/abdoukh4-art/spine/blob/develop/docs/adr/0026-mttd-mttr-definitions.md">
          ADR-0026
        </a>
        .
      </p>
      <div className="sp-grid">
        <section className="sp-section" aria-labelledby="mttd-h">
          <h2 id="mttd-h">Mean time to detect (MTTD)</h2>
          <p className="sp-muted sp-small">
            From when the event happened to when Spine received the alert.
          </p>
          <StatTiles
            name="MTTD statistics"
            stat={m.mttd}
            {...(m.mttd.clockSkewCount > 0
              ? {
                  extra: [
                    { label: 'Clock-skewed (excluded)', value: String(m.mttd.clockSkewCount) },
                  ],
                }
              : {})}
          />
        </section>
        <section className="sp-section" aria-labelledby="mttr-h">
          <h2 id="mttr-h">Mean time to respond (MTTR)</h2>
          <p className="sp-muted sp-small">
            From when Spine received the alert to when it was resolved.
          </p>
          <StatTiles
            name="MTTR statistics"
            stat={m.mttr}
            extra={[{ label: 'Still open', value: String(m.mttr.openCount) }]}
          />
        </section>
      </div>
      <section className="sp-section" aria-labelledby="volume-h">
        <h2 id="volume-h">Alert volume: {m.alertVolume.total} alerts</h2>
        <div className="sp-grid">
          <BarChart title="Alerts by severity" data={severityData} valueName="Alerts" />
          <BarChart title="Alerts per day (UTC)" data={dayData} valueName="Alerts" />
        </div>
      </section>
      <section className="sp-section" aria-labelledby="pb-h">
        <h2 id="pb-h">Playbooks</h2>
        <dl className="sp-tiles" aria-label="Playbook outcomes">
          <Tile
            label="Success rate"
            value={formatPercent(m.playbooks.successRate)}
            sub="succeeded ÷ finished (excl. dry runs)"
          />
          <Tile label="Succeeded" value={String(runs.succeeded)} />
          <Tile label="Failed" value={String(runs.failed)} />
          <Tile label="Compensated" value={String(runs.compensated)} />
          <Tile label="Cancelled" value={String(runs.cancelled)} />
          <Tile label="In flight" value={String(runs.inFlight)} />
        </dl>
        <h3>Run latency</h3>
        <StatTiles name="Run latency statistics" stat={m.playbooks.latency} />
        <h3>Time waiting for approval</h3>
        <StatTiles name="Approval wait statistics" stat={m.playbooks.approvalWait} />
        <p className="sp-small">
          <Link to="/runs">See all runs</Link>
        </p>
      </section>
    </>
  );
}

/** `/metrics`: MTTD, MTTR, alert volume and playbook health for a chosen window. */
export default function MetricsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const raw = params.get('window');
  const windowKey: WindowKey = raw === '24h' || raw === '30d' ? raw : '7d';
  const query = useQuery({
    queryKey: queryKeys.metrics(windowKey),
    queryFn: () => {
      const to = Date.now();
      return api.metrics.summary({
        from: new Date(to - WINDOWS[windowKey].ms).toISOString(),
        to: new Date(to).toISOString(),
      });
    },
    refetchInterval: 60_000,
  });
  return (
    <>
      <PageHeader
        title="Metrics"
        actions={
          <fieldset className="sp-checkbox-group" style={{ alignItems: 'center' }}>
            <legend className="sp-field__label">Time window</legend>
            {(Object.keys(WINDOWS) as WindowKey[]).map((key) => (
              <label key={key} className="sp-checkbox">
                <input
                  type="radio"
                  name="window"
                  value={key}
                  checked={windowKey === key}
                  onChange={() => setParams(key === '7d' ? {} : { window: key }, { replace: true })}
                />
                {WINDOWS[key].label}
              </label>
            ))}
          </fieldset>
        }
      />
      <QueryView query={query} loadingLabel="Loading metrics">
        {(m) => <MetricsBody m={m} />}
      </QueryView>
    </>
  );
}
