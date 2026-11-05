import type {
  AlertDetail,
  AlertStatus,
  IndicatorType,
  OcsfDetectionFinding,
  Severity,
} from '@spine/shared-schema';

/**
 * Exports a Spine alert as an **OCSF 1.9.0 Detection Finding** (class 2004), the open schema that
 * SIEMs and security data lakes ingest (ADR-0097). Pure: the mapping is the whole contract and is
 * validated in tests against a contract generated from the official schema.
 *
 * Choices worth knowing (each one is in the ADR):
 * - `time` and `finding_info.created_time` are when **Spine received** the alert; the sensor's
 *   own time is `start_time`. Detection latency stays computable downstream (MTTD).
 * - `severity_id` is Spine's score-derived severity, falling back to the sensor's before scoring.
 * - `status_id`: `false_positive` → Suppressed (3), `resolved` → Resolved (4).
 * - Spine's explanation (factors, data gaps, ruleset version) and playbook runs go under
 *   `unmapped.spine`: OCSF has no standard place for an explainable score.
 * - The raw sensor payload is not exported (`raw_data` omitted): size and data minimisation.
 */

/** The OCSF schema version the export conforms to. */
export const OCSF_VERSION = '1.9.0';

const CATEGORY_UID = 2; // Findings
const CLASS_UID = 2004; // Detection Finding
const ACTIVITY_CREATE = 1;

const SEVERITY_ID: Record<Severity, number> = {
  informational: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/** OCSF `risk_level_id`: Info 0, Low 1, Medium 2, High 3, Critical 4. */
const RISK_LEVEL_ID: Record<Severity, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** OCSF finding `status_id` and its caption, per Spine status. */
const STATUS: Record<AlertStatus, { id: number; caption: string }> = {
  new: { id: 1, caption: 'New' },
  triaged: { id: 2, caption: 'In Progress' }, // someone has looked at it
  in_progress: { id: 2, caption: 'In Progress' },
  false_positive: { id: 3, caption: 'Suppressed' },
  resolved: { id: 4, caption: 'Resolved' },
};

/** OCSF observable `type_id` for each Spine indicator type. */
const OBSERVABLE_TYPE_ID: Record<IndicatorType, number> = {
  hostname: 1, // Hostname
  domain: 1, // OCSF has no separate domain type; hostname_t covers DNS names
  ipv4: 2, // IP Address
  ipv6: 2,
  username: 4, // User Name
  email: 5, // Email Address
  url: 6, // URL String
  sha256: 8, // Hash
  sha1: 8,
  md5: 8,
};

const ms = (iso: string): number => Date.parse(iso);

/** Maps one alert (with its score and runs) to an OCSF Detection Finding. */
export function toOcsfDetectionFinding(
  detail: AlertDetail,
  product: { version: string },
): OcsfDetectionFinding {
  const { alert, summary, score, runs } = detail;
  const severity = summary.severity ?? summary.sourceSeverity;
  const observables = observablesOf(alert);
  return {
    activity_id: ACTIVITY_CREATE,
    activity_name: 'Create',
    category_uid: CATEGORY_UID,
    category_name: 'Findings',
    class_uid: CLASS_UID,
    class_name: 'Detection Finding',
    type_uid: CLASS_UID * 100 + ACTIVITY_CREATE,
    type_name: 'Detection Finding: Create',
    time: ms(alert.receivedAt),
    start_time: ms(alert.occurredAt),
    severity_id: SEVERITY_ID[severity],
    severity: capitalize(severity),
    status_id: STATUS[alert.status].id,
    status: STATUS[alert.status].caption,
    message: alert.title,
    is_alert: true,
    ...(score ? { risk_score: score.score, risk_level_id: RISK_LEVEL_ID[score.severity] } : {}),
    metadata: {
      version: OCSF_VERSION,
      uid: alert.id,
      original_time: alert.occurredAt,
      product: { name: 'Spine', vendor_name: 'Spine project', version: product.version },
    },
    finding_info: findingInfoOf(alert),
    ...(alert.host
      ? {
          device: {
            type_id: 0, // Unknown: sensors don't tell Spine the device type
            ...(alert.host.hostname ? { hostname: alert.host.hostname } : {}),
            ...(alert.host.ips?.[0] ? { ip: alert.host.ips[0] } : {}),
          },
        }
      : {}),
    ...(observables.length > 0 ? { observables } : {}),
    unmapped: {
      spine: {
        duplicates: alert.duplicateCount,
        score: score
          ? {
              score: score.score,
              severity: score.severity,
              rulesetVersion: score.rulesetVersion,
              factors: score.factors,
              dataGaps: score.dataGaps,
            }
          : null,
        playbookRuns: runs.map((r) => ({ runId: r.id, playbook: r.playbookId, status: r.status })),
      },
    },
  };
}

type Alert = AlertDetail['alert'];

/** Indicators plus the host's name and addresses, as OCSF observables. */
function observablesOf(alert: Alert): { name: string; type_id: number; value: string }[] {
  return [
    ...alert.indicators.map((i) => ({
      name: `indicator.${i.type}`,
      type_id: OBSERVABLE_TYPE_ID[i.type],
      value: i.value,
    })),
    ...(alert.host?.hostname
      ? [{ name: 'device.hostname', type_id: 1, value: alert.host.hostname }]
      : []),
    ...(alert.host?.ips ?? []).map((ip) => ({ name: 'device.ip', type_id: 2, value: ip })),
  ];
}

/** `finding_info`: identity, title, timing, the detecting product and ATT&CK mapping. */
function findingInfoOf(alert: Alert): OcsfDetectionFinding['finding_info'] {
  return {
    uid: alert.id,
    title: alert.title,
    ...(alert.description ? { desc: alert.description } : {}),
    created_time: ms(alert.receivedAt),
    first_seen_time: ms(alert.receivedAt),
    last_seen_time: ms(alert.lastSeenAt),
    types: [alert.category],
    ...(alert.source.sourceAlertId ? { uid_alt: alert.source.sourceAlertId } : {}),
    product: { name: alert.source.product, vendor_name: alert.source.vendor },
    ...(alert.mitre.length > 0
      ? {
          attacks: alert.mitre.map((m) => ({
            technique: {
              uid: m.techniqueId,
              ...(m.techniqueName ? { name: m.techniqueName } : {}),
            },
            ...(m.tacticId
              ? { tactic: { uid: m.tacticId, ...(m.tacticName ? { name: m.tacticName } : {}) } }
              : {}),
          })),
        }
      : {}),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
