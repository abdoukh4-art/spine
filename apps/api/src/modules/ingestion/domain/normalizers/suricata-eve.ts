import type { Indicator, Severity } from '@spine/shared-schema';
import { canonicalIp } from '../ip.js';
import { err, normalizationError, type NormalizationError, type Result } from '../result.js';
import { parseJsonInput, validateCanonical, type Normalizer } from './canonical.js';
import {
  classifyCategory,
  compact,
  isRecord,
  port,
  str,
  strings,
  toIsoTimestamp,
  zipMitre,
} from './fields.js';

/**
 * Suricata EVE JSON → canonical alert (ADR-0031).
 *
 * Suricata writes one JSON object per line; only `event_type: "alert"` lines are alerts
 * (others are flow, dns, http… telemetry). Field reference:
 * https://docs.suricata.io/en/latest/output/eve/eve-json-format.html
 */

/** Suricata priorities: 1 is the most severe. 4 exists in some rule sets (informational). */
const SEVERITY_BY_PRIORITY: Record<number, Severity> = {
  1: 'high',
  2: 'medium',
  3: 'low',
  4: 'informational',
};

/**
 * `flow_id` is a 64-bit integer, larger than `Number.MAX_SAFE_INTEGER`. `JSON.parse` would
 * silently round it, so two different flows could get the same id. When we have the raw
 * text, read the digits directly instead (journal: "the flow_id that lost its last digits").
 */
function exactFlowId(rawText: string | undefined, parsed: unknown): string | undefined {
  if (rawText !== undefined) {
    const m = /"flow_id"\s*:\s*(\d{1,20})/.exec(rawText);
    if (m?.[1]) return m[1];
  }
  if (typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0) {
    return String(parsed);
  }
  return str(parsed, 32);
}

function ip(value: unknown): string | undefined {
  const s = str(value, 64);
  return s ? canonicalIp(s)?.value : undefined;
}

function dnsNames(dns: unknown): string[] {
  if (!isRecord(dns)) return [];
  const names = strings(dns.rrname);
  if (Array.isArray(dns.query)) {
    for (const q of dns.query) if (isRecord(q)) names.push(...strings(q.rrname));
  }
  return names;
}

/** Observables found in protocol sections (HTTP, TLS, DNS, file info). */
function protocolIndicators(event: Record<string, unknown>): Indicator[] {
  const out: Indicator[] = [];
  const add = (type: Indicator['type'], value: string | undefined): void => {
    if (value) out.push({ type, value: value.slice(0, 2048) });
  };
  const http = isRecord(event.http) ? event.http : {};
  const tls = isRecord(event.tls) ? event.tls : {};
  const fileinfo = isRecord(event.fileinfo) ? event.fileinfo : {};
  add('domain', str(http.hostname, 255));
  add('domain', str(tls.sni, 255));
  for (const name of dnsNames(event.dns)) add('domain', str(name, 255));
  add('sha256', str(fileinfo.sha256, 64));
  add('md5', str(fileinfo.md5, 32));
  add('sha1', str(fileinfo.sha1, 40));
  return out;
}

function httpUrl(event: Record<string, unknown>): string | undefined {
  if (!isRecord(event.http)) return undefined;
  const host = str(event.http.hostname, 255);
  const path = str(event.http.url, 2048);
  if (!host || !path) return undefined;
  try {
    const url = new URL(path.startsWith('/') ? `http://${host}${path}` : path);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function labels(event: Record<string, unknown>, alert: Record<string, unknown>) {
  const entries: [string, unknown][] = [
    ['suricata.signature_id', alert.signature_id],
    ['suricata.rev', alert.rev],
    ['suricata.gid', alert.gid],
    ['suricata.action', alert.action],
    ['suricata.category', alert.category],
    ['suricata.sensor', event.host],
    ['suricata.in_iface', event.in_iface],
    ['network.community_id', event.community_id],
    ['http.user_agent', isRecord(event.http) ? event.http.http_user_agent : undefined],
  ];
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v).slice(0, 1024);
  }
  return out;
}

function mitreFromMetadata(alert: Record<string, unknown>) {
  const md = isRecord(alert.metadata) ? alert.metadata : {};
  return zipMitre({
    tacticIds: strings(md.mitre_tactic_id),
    tacticNames: strings(md.mitre_tactic_name),
    techniqueIds: strings(md.mitre_technique_id),
    techniqueNames: strings(md.mitre_technique_name),
  });
}

function buildCandidate(
  event: Record<string, unknown>,
  alert: Record<string, unknown>,
  rawText: string | undefined,
): Result<Record<string, unknown>, NormalizationError> {
  const title = str(alert.signature);
  if (!title) return err(normalizationError('missing_field', 'alert.signature is required'));
  const occurredAt = toIsoTimestamp(event.timestamp);
  if (!occurredAt) {
    return err(normalizationError('missing_field', 'timestamp is missing or not a valid date'));
  }
  const flowId = exactFlowId(rawText, event.flow_id);
  const signatureId = typeof alert.signature_id === 'number' ? alert.signature_id : undefined;
  const sourceAlertId =
    flowId === undefined
      ? undefined
      : signatureId === undefined
        ? flowId
        : `${flowId}:${signatureId}`;
  const network = compact({
    sourceIp: ip(event.src_ip),
    sourcePort: port(event.src_port),
    destinationIp: ip(event.dest_ip),
    destinationPort: port(event.dest_port),
    protocol: str(event.proto, 32)?.toLowerCase(),
  });
  const category = str(alert.category);
  return {
    ok: true,
    value: compact({
      source: compact({ vendor: 'OISF', product: 'Suricata', sourceAlertId }),
      title,
      description: category ? `${category} (${str(alert.action) ?? 'unknown action'})` : undefined,
      category: classifyCategory([title, category]),
      severity:
        typeof alert.severity === 'number'
          ? (SEVERITY_BY_PRIORITY[alert.severity] ?? 'medium')
          : 'medium',
      occurredAt,
      network: Object.keys(network).length > 0 ? network : undefined,
      url: httpUrl(event),
      indicators: protocolIndicators(event),
      mitre: mitreFromMetadata(alert),
      labels: labels(event, alert),
      raw: event,
    }),
  };
}

/** The `suricata-eve` normalizer. Accepts one parsed EVE object or one EVE JSON line. */
export const normalizeSuricataEve: Normalizer = (raw) => {
  const rawText = typeof raw === 'string' ? raw : undefined;
  const json = parseJsonInput(raw);
  if (!json.ok) return json;
  const event = json.value;
  if (!isRecord(event))
    return err(normalizationError('parse_error', 'EVE record must be a JSON object'));
  if (event.event_type !== 'alert') {
    const type = typeof event.event_type === 'string' ? event.event_type.slice(0, 40) : 'missing';
    return err(normalizationError('not_an_alert', `event_type '${type}' is not an alert`));
  }
  if (!isRecord(event.alert))
    return err(normalizationError('missing_field', 'alert object is required'));
  const candidate = buildCandidate(event, event.alert, rawText);
  return candidate.ok ? validateCanonical(candidate.value) : candidate;
};
