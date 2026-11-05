import type { Alert, AlertDetail } from '@spine/shared-schema';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  EmptyState,
  KeyValue,
  PageHeader,
  QueryView,
  ScoreBar,
  SeverityBadge,
  StatusBadge,
  Table,
  type KeyValueItem,
} from '../../components';
import { queryKeys, useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth/AuthProvider';
import { formatDateTime, humanize } from '../../lib/format';
import { RunsTable } from '../runs/RunsTable';
import { AlertActions } from './AlertActions';
import { EnrichmentResults } from './EnrichmentResults';
import { ScoreExplanationView } from './ScoreExplanationView';

/** The optional canonical blocks (host, user, network, file, url, labels) as label/value rows. */
export function canonicalFields(alert: Alert): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  if (alert.host) {
    items.push({
      label: 'Host',
      value: [alert.host.hostname, alert.host.ips?.join(', '), alert.host.os]
        .filter(Boolean)
        .join(' · '),
    });
  }
  if (alert.user)
    items.push({
      label: 'User',
      value: [alert.user.name, alert.user.email].filter(Boolean).join(' · '),
    });
  if (alert.network) {
    const n = alert.network;
    const endpoint = (ip?: string, port?: number) =>
      ip ? `${ip}${port !== undefined ? `:${String(port)}` : ''}` : '?';
    items.push({
      label: 'Network',
      value: `${endpoint(n.sourceIp, n.sourcePort)} → ${endpoint(n.destinationIp, n.destinationPort)}${n.protocol ? ` (${n.protocol})` : ''}`,
    });
  }
  if (alert.file) {
    items.push({
      label: 'File',
      value: (
        <span className="sp-break">
          {[alert.file.name, alert.file.path, alert.file.sha256 ?? alert.file.md5]
            .filter(Boolean)
            .join(' · ')}
        </span>
      ),
    });
  }
  if (alert.url)
    items.push({ label: 'URL', value: <span className="sp-break sp-mono">{alert.url}</span> });
  for (const [key, value] of Object.entries(alert.labels))
    items.push({ label: `Label: ${key}`, value });
  return items;
}

function Summary({ detail, myId }: { detail: AlertDetail; myId: string | undefined }) {
  const { summary, alert } = detail;
  return (
    <KeyValue
      items={[
        { label: 'Status', value: <StatusBadge status={summary.status} /> },
        { label: 'Severity', value: <SeverityBadge severity={summary.severity} /> },
        { label: 'Score', value: <ScoreBar score={summary.score} label="Alert score" /> },
        { label: 'Source severity', value: humanize(summary.sourceSeverity) },
        { label: 'Category', value: humanize(summary.category) },
        { label: 'Source', value: `${summary.source.vendor} ${summary.source.product}` },
        { label: 'Source alert ID', value: alert.source.sourceAlertId },
        { label: 'Occurred', value: formatDateTime(summary.occurredAt) },
        { label: 'Received', value: formatDateTime(summary.receivedAt) },
        { label: 'Last seen', value: formatDateTime(summary.lastSeenAt) },
        { label: 'Duplicates merged', value: String(summary.duplicateCount) },
        {
          label: 'Assignee',
          value:
            summary.assigneeId === null
              ? 'Unassigned'
              : summary.assigneeId === myId
                ? 'You'
                : summary.assigneeId,
        },
        {
          label: 'Resolved',
          value: summary.resolvedAt ? formatDateTime(summary.resolvedAt) : null,
        },
      ]}
    />
  );
}

function Details({ detail }: { detail: AlertDetail }) {
  const { user } = useAuth();
  const { alert } = detail;
  const fields = canonicalFields(alert);
  return (
    <>
      {alert.description ? <p>{alert.description}</p> : null}
      <div className="sp-grid sp-grid--wide">
        <section className="sp-section" aria-labelledby="summary-h">
          <h2 id="summary-h">Summary</h2>
          <Summary detail={detail} myId={user?.id} />
        </section>
        <section className="sp-section" aria-labelledby="actions-h">
          <h2 id="actions-h">Actions</h2>
          <AlertActions alert={detail.summary} />
        </section>
      </div>
      <section className="sp-section" aria-labelledby="score-h">
        <h2 id="score-h">Why this score?</h2>
        <ScoreExplanationView score={detail.score} />
      </section>
      <div className="sp-grid">
        <section className="sp-section" aria-labelledby="fields-h">
          <h2 id="fields-h">Canonical fields</h2>
          {fields.length > 0 ? (
            <KeyValue items={fields} />
          ) : (
            <p className="sp-muted">No host, user, network or file context.</p>
          )}
        </section>
        <section className="sp-section" aria-labelledby="mitre-h">
          <h2 id="mitre-h">MITRE ATT&amp;CK</h2>
          {alert.mitre.length === 0 ? (
            <p className="sp-muted">No technique mapped.</p>
          ) : (
            <Table caption="MITRE ATT&CK mapping" captionHidden>
              <thead>
                <tr>
                  <th scope="col">Tactic</th>
                  <th scope="col">Technique</th>
                </tr>
              </thead>
              <tbody>
                {alert.mitre.map((m) => (
                  <tr key={m.techniqueId}>
                    <td>{m.tacticId ? `${m.tacticId} ${m.tacticName ?? ''}` : '—'}</td>
                    <td>
                      <span className="sp-mono">{m.techniqueId}</span> {m.techniqueName ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      </div>
      <section className="sp-section" aria-labelledby="indicators-h">
        <h2 id="indicators-h">Indicators and enrichment</h2>
        {alert.indicators.length === 0 ? (
          <p className="sp-muted">No indicators were extracted from this alert.</p>
        ) : (
          <p>
            {alert.indicators.length} indicator{alert.indicators.length === 1 ? '' : 's'}:{' '}
            {alert.indicators.map((i) => `${i.type} ${i.value}`).join('; ')}
          </p>
        )}
        <EnrichmentResults results={detail.enrichments} />
      </section>
      <section className="sp-section" aria-labelledby="runs-h">
        <h2 id="runs-h">Playbook runs</h2>
        {detail.runs.length === 0 ? (
          <EmptyState title="No playbook has run on this alert." />
        ) : (
          <RunsTable runs={detail.runs} caption="Runs for this alert" showAlert={false} />
        )}
      </section>
    </>
  );
}

/** `/alerts/:id`: everything known about one alert, and what an analyst can do about it. */
export default function AlertDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.alert(id),
    queryFn: () => api.alerts.get(id),
    // Keep polling while the pipeline hasn't scored the alert yet.
    refetchInterval: (q) => (q.state.data && q.state.data.score === null ? 5_000 : false),
  });
  return (
    <>
      <PageHeader
        title={query.data?.summary.title ?? 'Alert'}
        description={<Link to="/alerts">← Back to the queue</Link>}
      />
      <QueryView query={query} loadingLabel="Loading alert">
        {(detail) => <Details detail={detail} />}
      </QueryView>
    </>
  );
}
