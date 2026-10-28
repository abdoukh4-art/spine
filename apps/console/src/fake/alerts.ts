import {
  CLOSED_ALERT_STATUSES,
  severityFromScore,
  type Alert,
  type AlertCategory,
  type AlertStatus,
  type AssetCriticality,
  type EnrichmentResult,
  type EnrichmentStatus,
  type IndicatorType,
  type MitreMapping,
  type ScoreExplanation,
  type ScoreFactor,
  type Severity,
  type Verdict,
} from '@spine/shared-schema';
import { fakeId, ID_KIND, seededRandom } from './ids';

/** An alert as the fake server stores it: the canonical alert plus pipeline results. */
export interface StoredAlert {
  alert: Alert;
  severity: Severity | null;
  score: ScoreExplanation | null;
  enrichments: EnrichmentResult[];
  assigneeId: string | null;
  caseId: string | null;
  resolvedAt: string | null;
}

/** One indicator of a featured alert, with what the fake providers "know" about it. */
interface IndicatorSpec {
  type: IndicatorType;
  value: string;
  verdict?: Verdict;
  reputation?: number;
  /** Make the reputation lookup fail with this status (a data gap). */
  failed?: EnrichmentStatus;
  geo?: { country: string; asn: number; org: string; isTor?: boolean };
  geoFailed?: EnrichmentStatus;
  asset?: { owner: string; businessUnit: string; criticality: AssetCriticality };
}

interface AlertSpec {
  title: string;
  description?: string;
  category: AlertCategory;
  vendor: string;
  product: string;
  sourceSeverity: Severity;
  status: AlertStatus;
  minutesAgo: number;
  detectDelaySec: number;
  host?: { hostname: string; ips?: string[]; os?: string };
  user?: { name: string; email?: string };
  network?: Alert['network'];
  file?: Alert['file'];
  url?: string;
  indicators: IndicatorSpec[];
  mitre: MitreMapping[];
  labels?: Record<string, string>;
  /** null → not scored yet (the pipeline is still running). */
  factors: ScoreFactor[] | null;
  duplicateCount?: number;
  assignee?: string;
  resolvedAfterMin?: number;
}

/** Baseline points per source severity (mirrors the default scoring ruleset). */
export const BASELINE_POINTS: Record<Severity, number> = {
  informational: 5,
  low: 15,
  medium: 30,
  high: 50,
  critical: 70,
};

const baseline = (severity: Severity): ScoreFactor => ({
  ruleId: `baseline-${severity}`,
  description: `Baseline for source severity "${severity}"`,
  points: BASELINE_POINTS[severity],
  evidence: `sourceSeverity = ${severity}`,
});

/** Factors are additive; the score is the raw sum clamped to 0–100 (ADR-0015). */
export function explainScore(
  factors: ScoreFactor[],
  dataGaps: string[],
  computedAt: string,
): ScoreExplanation {
  const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.max(0, Math.min(100, rawScore));
  return {
    score,
    rawScore,
    severity: severityFromScore(score),
    rulesetVersion: 4,
    factors,
    dataGaps,
    computedAt,
  };
}

const FEATURED: AlertSpec[] = [
  {
    title: 'Cobalt Strike beacon to 185.220.101.47 from FIN-WS-0231',
    description:
      'Periodic HTTPS callbacks with a 60 s jitter pattern matching a Cobalt Strike malleable profile.',
    category: 'command_and_control',
    vendor: 'CrowdStrike',
    product: 'Falcon',
    sourceSeverity: 'high',
    status: 'new',
    minutesAgo: 6,
    detectDelaySec: 41,
    duplicateCount: 3,
    host: { hostname: 'fin-ws-0231', ips: ['10.20.4.31'], os: 'Windows 11 Enterprise 23H2' },
    user: { name: 'j.morales', email: 'j.morales@example.com' },
    network: {
      sourceIp: '10.20.4.31',
      sourcePort: 51544,
      destinationIp: '185.220.101.47',
      destinationPort: 443,
      protocol: 'tcp',
    },
    indicators: [
      {
        type: 'ipv4',
        value: '185.220.101.47',
        verdict: 'malicious',
        reputation: 97,
        geo: { country: 'DE', asn: 205100, org: 'F3 Netze e.V.', isTor: true },
      },
      { type: 'domain', value: 'cdn-update-check.com', verdict: 'malicious', reputation: 88 },
      {
        type: 'hostname',
        value: 'fin-ws-0231',
        asset: { owner: 'Finance IT', businessUnit: 'Finance', criticality: 'critical' },
      },
    ],
    mitre: [
      {
        tacticId: 'TA0011',
        tacticName: 'Command and Control',
        techniqueId: 'T1071.001',
        techniqueName: 'Application Layer Protocol: Web Protocols',
      },
      {
        tacticId: 'TA0011',
        tacticName: 'Command and Control',
        techniqueId: 'T1573.002',
        techniqueName: 'Encrypted Channel: Asymmetric Cryptography',
      },
    ],
    factors: [
      baseline('high'),
      {
        ruleId: 'malicious-reputation',
        description: 'An indicator has a malicious reputation verdict',
        points: 25,
        evidence: '185.220.101.47: malicious (97/100, abuse-db)',
      },
      {
        ruleId: 'tor-exit-node',
        description: 'Remote IP is a Tor exit node',
        points: 10,
        evidence: '185.220.101.47 isTor = true',
      },
      {
        ruleId: 'critical-asset',
        description: 'Affected host is a critical asset',
        points: 15,
        evidence: 'fin-ws-0231: criticality critical (owner Finance IT)',
      },
      {
        ruleId: 'repeated-occurrence',
        description: 'Seen more than twice (deduplicated)',
        points: 5,
        evidence: 'duplicateCount = 3',
      },
    ],
  },
  {
    title: 'Credential phishing link clicked: login-micros0ft-support.com',
    description: 'User clicked a rewritten URL that later scored as credential phishing.',
    category: 'phishing',
    vendor: 'Proofpoint',
    product: 'TAP',
    sourceSeverity: 'medium',
    status: 'triaged',
    assignee: 'sam',
    minutesAgo: 38,
    detectDelaySec: 190,
    user: { name: 'a.chen', email: 'a.chen@example.com' },
    url: 'https://login-micros0ft-support.com/oauth2/authorize',
    labels: { clicked: 'true', reported_by: 'a.chen' },
    indicators: [
      {
        type: 'url',
        value: 'https://login-micros0ft-support.com/oauth2/authorize',
        verdict: 'malicious',
        reputation: 91,
      },
      {
        type: 'domain',
        value: 'login-micros0ft-support.com',
        verdict: 'malicious',
        reputation: 91,
      },
      {
        type: 'email',
        value: 'it-support@micros0ft-support.com',
        verdict: 'suspicious',
        reputation: 55,
      },
    ],
    mitre: [
      {
        tacticId: 'TA0001',
        tacticName: 'Initial Access',
        techniqueId: 'T1566.002',
        techniqueName: 'Phishing: Spearphishing Link',
      },
    ],
    factors: [
      baseline('medium'),
      {
        ruleId: 'malicious-reputation',
        description: 'An indicator has a malicious reputation verdict',
        points: 25,
        evidence: 'login-micros0ft-support.com: malicious (91/100)',
      },
      {
        ruleId: 'user-clicked',
        description: 'The user interacted with the lure',
        points: 10,
        evidence: 'labels.clicked = true',
      },
    ],
  },
  {
    title: 'Password spraying against 37 accounts from 45.155.205.233',
    category: 'credential_access',
    vendor: 'Microsoft',
    product: 'Entra ID Protection',
    sourceSeverity: 'high',
    status: 'in_progress',
    assignee: 'ada',
    minutesAgo: 125,
    detectDelaySec: 420,
    duplicateCount: 12,
    user: { name: 'svc-backup' },
    indicators: [
      {
        type: 'ipv4',
        value: '45.155.205.233',
        verdict: 'suspicious',
        reputation: 64,
        geo: { country: 'RU', asn: 49505, org: 'Selectel' },
      },
      { type: 'username', value: 'svc-backup' },
    ],
    mitre: [
      {
        tacticId: 'TA0006',
        tacticName: 'Credential Access',
        techniqueId: 'T1110.003',
        techniqueName: 'Brute Force: Password Spraying',
      },
    ],
    factors: [
      baseline('high'),
      {
        ruleId: 'suspicious-reputation',
        description: 'An indicator has a suspicious reputation verdict',
        points: 10,
        evidence: '45.155.205.233: suspicious (64/100)',
      },
      {
        ruleId: 'many-duplicates',
        description: 'More than 10 occurrences merged into this alert',
        points: 8,
        evidence: 'duplicateCount = 12',
      },
    ],
  },
  {
    title: 'Mimikatz credential dumping detected on DC-01',
    description: 'LSASS memory read by an unsigned binary matching Mimikatz.',
    category: 'credential_access',
    vendor: 'SentinelOne',
    product: 'Singularity',
    sourceSeverity: 'critical',
    status: 'new',
    minutesAgo: 15,
    detectDelaySec: 12,
    host: { hostname: 'dc-01', ips: ['10.0.0.10'], os: 'Windows Server 2022' },
    file: {
      name: 'mimikatz.exe',
      path: 'C:\\Users\\Public\\mimikatz.exe',
      sha256: '61c0810a23580cf492a6ba4f7654566108331e7a4134c968c2d6a05261b2d8a1',
    },
    indicators: [
      {
        type: 'sha256',
        value: '61c0810a23580cf492a6ba4f7654566108331e7a4134c968c2d6a05261b2d8a1',
        verdict: 'malicious',
        reputation: 99,
      },
      {
        type: 'hostname',
        value: 'dc-01',
        asset: { owner: 'Identity team', businessUnit: 'IT', criticality: 'critical' },
      },
    ],
    mitre: [
      {
        tacticId: 'TA0006',
        tacticName: 'Credential Access',
        techniqueId: 'T1003.001',
        techniqueName: 'OS Credential Dumping: LSASS Memory',
      },
    ],
    factors: [
      baseline('critical'),
      {
        ruleId: 'malicious-hash',
        description: 'A file hash is known malicious',
        points: 25,
        evidence: 'sha256 61c0810a…: malicious (99/100)',
      },
      {
        ruleId: 'critical-asset',
        description: 'Affected host is a critical asset',
        points: 15,
        evidence: 'dc-01: criticality critical (owner Identity team)',
      },
    ],
  },
  {
    title: 'Exploit attempt against web-01 (CVE-2026-21894)',
    category: 'intrusion',
    vendor: 'Palo Alto Networks',
    product: 'PAN-OS Threat Prevention',
    sourceSeverity: 'high',
    status: 'new',
    minutesAgo: 22,
    detectDelaySec: 3,
    host: { hostname: 'web-01', ips: ['10.0.5.10'] },
    network: {
      sourceIp: '198.51.100.23',
      destinationIp: '10.0.5.10',
      destinationPort: 443,
      protocol: 'tcp',
    },
    indicators: [
      {
        type: 'ipv4',
        value: '198.51.100.23',
        verdict: 'malicious',
        reputation: 82,
        geoFailed: 'circuit_open',
      },
      {
        type: 'hostname',
        value: 'web-01',
        asset: { owner: 'Web platform', businessUnit: 'Digital', criticality: 'high' },
      },
    ],
    mitre: [
      {
        tacticId: 'TA0001',
        tacticName: 'Initial Access',
        techniqueId: 'T1190',
        techniqueName: 'Exploit Public-Facing Application',
      },
    ],
    factors: [
      baseline('high'),
      {
        ruleId: 'malicious-reputation',
        description: 'An indicator has a malicious reputation verdict',
        points: 25,
        evidence: '198.51.100.23: malicious (82/100)',
      },
      {
        ruleId: 'high-asset',
        description: 'Affected host is a high-criticality asset',
        points: 10,
        evidence: 'web-01: criticality high',
      },
    ],
  },
  {
    title: 'Large upload (2.4 GB) to transfer.sh by m.ivanova',
    category: 'exfiltration',
    vendor: 'Zscaler',
    product: 'Internet Access',
    sourceSeverity: 'medium',
    status: 'new',
    minutesAgo: 52,
    detectDelaySec: 300,
    user: { name: 'm.ivanova', email: 'm.ivanova@example.com' },
    url: 'https://transfer.sh/9Xk2/backup.7z',
    labels: { bytes_out: '2576980377' },
    indicators: [
      {
        type: 'domain',
        value: 'transfer.sh',
        verdict: 'suspicious',
        reputation: 45,
        failed: 'timeout',
      },
      { type: 'username', value: 'm.ivanova' },
    ],
    mitre: [
      {
        tacticId: 'TA0010',
        tacticName: 'Exfiltration',
        techniqueId: 'T1567.002',
        techniqueName: 'Exfiltration Over Web Service: Exfiltration to Cloud Storage',
      },
    ],
    factors: [
      baseline('medium'),
      {
        ruleId: 'large-volume',
        description: 'More than 1 GB sent to an external service',
        points: 12,
        evidence: 'labels.bytes_out = 2576980377',
      },
    ],
  },
  {
    title: 'Encoded PowerShell spawned by WINWORD.EXE on HR-LT-114',
    category: 'malware',
    vendor: 'Microsoft',
    product: 'Defender for Endpoint',
    sourceSeverity: 'high',
    status: 'new',
    minutesAgo: 1,
    detectDelaySec: 8,
    host: { hostname: 'hr-lt-114', ips: ['10.30.8.114'] },
    indicators: [{ type: 'hostname', value: 'hr-lt-114' }],
    mitre: [
      {
        tacticId: 'TA0002',
        tacticName: 'Execution',
        techniqueId: 'T1059.001',
        techniqueName: 'Command and Scripting Interpreter: PowerShell',
      },
    ],
    factors: null,
  },
  {
    title: 'Nmap OS-detection probe from 203.0.113.50',
    category: 'reconnaissance',
    vendor: 'OISF',
    product: 'Suricata',
    sourceSeverity: 'low',
    status: 'false_positive',
    minutesAgo: 26 * 60,
    detectDelaySec: 2,
    resolvedAfterMin: 50,
    labels: { scanner: 'approved-vuln-scan' },
    network: { sourceIp: '203.0.113.50', destinationIp: '10.0.5.10', protocol: 'tcp' },
    indicators: [
      {
        type: 'ipv4',
        value: '203.0.113.50',
        verdict: 'benign',
        reputation: 5,
        geo: { country: 'US', asn: 64500, org: 'Example Security Scanning' },
      },
    ],
    mitre: [
      {
        tacticId: 'TA0043',
        tacticName: 'Reconnaissance',
        techniqueId: 'T1595.001',
        techniqueName: 'Active Scanning: Scanning IP Blocks',
      },
    ],
    factors: [
      baseline('low'),
      {
        ruleId: 'benign-reputation',
        description: 'All indicators have a benign verdict',
        points: -10,
        evidence: '203.0.113.50: benign (5/100)',
      },
      {
        ruleId: 'approved-scanner',
        description: 'Source is an approved vulnerability scanner',
        points: -10,
        evidence: 'labels.scanner = approved-vuln-scan',
      },
    ],
  },
  {
    title: 'Ransom note dropped on FS-02 share \\\\finance',
    category: 'malware',
    vendor: 'CrowdStrike',
    product: 'Falcon',
    sourceSeverity: 'critical',
    status: 'resolved',
    minutesAgo: 3 * 24 * 60,
    detectDelaySec: 95,
    resolvedAfterMin: 95,
    assignee: 'ada',
    host: { hostname: 'fs-02', ips: ['10.0.7.2'] },
    file: {
      name: 'README_RESTORE.txt',
      sha256: 'b5d2c1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2',
    },
    indicators: [
      {
        type: 'sha256',
        value: 'b5d2c1f0e9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2',
        verdict: 'malicious',
        reputation: 95,
      },
    ],
    mitre: [
      {
        tacticId: 'TA0040',
        tacticName: 'Impact',
        techniqueId: 'T1486',
        techniqueName: 'Data Encrypted for Impact',
      },
    ],
    factors: [
      baseline('critical'),
      {
        ruleId: 'malicious-hash',
        description: 'A file hash is known malicious',
        points: 25,
        evidence: 'sha256 b5d2c1f0…: malicious (95/100)',
      },
    ],
  },
  {
    title: 'USB mass storage mounted on HR-LT-114',
    category: 'policy_violation',
    vendor: 'Microsoft',
    product: 'Intune',
    sourceSeverity: 'low',
    status: 'triaged',
    minutesAgo: 5 * 60,
    detectDelaySec: 600,
    host: { hostname: 'hr-lt-114' },
    indicators: [
      {
        type: 'hostname',
        value: 'hr-lt-114',
        asset: { owner: 'HR', businessUnit: 'People', criticality: 'medium' },
      },
    ],
    mitre: [],
    factors: [
      baseline('low'),
      {
        ruleId: 'medium-asset',
        description: 'Affected host is a medium-criticality asset',
        points: 5,
        evidence: 'hr-lt-114: criticality medium',
      },
    ],
  },
];

/** Index of each featured alert in the fixture list, for wiring runs and approvals. */
export const FEATURED_ALERT = {
  c2: 0,
  phishing: 1,
  spraying: 2,
  mimikatz: 3,
  exploit: 4,
  exfil: 5,
  powershell: 6,
  nmap: 7,
  ransomware: 8,
  usb: 9,
} as const;

const iso = (ms: number) => new Date(ms).toISOString();

function fingerprintOf(id: string): string {
  const hex = id.replace(/-/g, '');
  return (hex + hex).slice(0, 64);
}

function enrich(spec: IndicatorSpec, fetchedAt: string): EnrichmentResult[] {
  const indicator = { type: spec.type, value: spec.value };
  const results: EnrichmentResult[] = [];
  if (spec.type !== 'hostname' && spec.type !== 'username') {
    if (spec.failed) {
      results.push({
        provider: 'abuse-db',
        indicator,
        status: spec.failed,
        error:
          spec.failed === 'timeout' ? 'No answer within 3000 ms' : 'Circuit open after 5 failures',
        durationMs: spec.failed === 'timeout' ? 3000 : 0,
        fetchedAt,
      });
    } else if (spec.verdict) {
      results.push({
        provider: 'abuse-db',
        indicator,
        status: 'ok',
        verdict: spec.verdict,
        data: {
          kind: 'reputation',
          score: spec.reputation ?? 0,
          verdict: spec.verdict,
          tags: spec.verdict === 'malicious' ? ['botnet', 'c2'] : [],
        },
        durationMs: 184,
        fetchedAt,
      });
    } else {
      results.push({
        provider: 'abuse-db',
        indicator,
        status: 'not_found',
        durationMs: 97,
        fetchedAt,
      });
    }
  }
  if (spec.geo) {
    results.push({
      provider: 'geo-ip',
      indicator,
      status: 'ok',
      data: { kind: 'geo', ...spec.geo, isTor: spec.geo.isTor ?? false },
      durationMs: 12,
      fetchedAt,
    });
  }
  if (spec.geoFailed) {
    results.push({
      provider: 'geo-ip',
      indicator,
      status: spec.geoFailed,
      error: 'Circuit open: provider failed 5 times in 60 s',
      durationMs: 0,
      fetchedAt,
    });
  }
  if (spec.asset) {
    results.push({
      provider: 'cmdb',
      indicator,
      status: 'ok',
      data: { kind: 'asset', hostname: spec.value, ...spec.asset, tags: [] },
      durationMs: 31,
      fetchedAt,
    });
  }
  if (spec.type === 'username') {
    results.push({ provider: 'cmdb', indicator, status: 'skipped', durationMs: 0, fetchedAt });
  }
  return results;
}

function buildFeatured(
  spec: AlertSpec,
  n: number,
  now: number,
  users: Record<string, string>,
): StoredAlert {
  const id = fakeId(ID_KIND.alert, n);
  const receivedMs = now - spec.minutesAgo * 60_000;
  const occurredMs = receivedMs - spec.detectDelaySec * 1000;
  const fetchedAt = iso(receivedMs + 4_000);
  const enrichments =
    spec.factors === null ? [] : spec.indicators.flatMap((i) => enrich(i, fetchedAt));
  const dataGaps = [
    ...new Set(
      enrichments
        .filter((e) => e.status !== 'ok' && e.status !== 'not_found' && e.status !== 'skipped')
        .map((e) => e.provider),
    ),
  ];
  const score =
    spec.factors === null ? null : explainScore(spec.factors, dataGaps, iso(receivedMs + 6_000));
  const closed = CLOSED_ALERT_STATUSES.includes(spec.status);
  const alert: Alert = {
    id,
    fingerprint: fingerprintOf(id),
    status: spec.status,
    receivedAt: iso(receivedMs),
    lastSeenAt: iso(receivedMs + (spec.duplicateCount ?? 0) * 90_000),
    duplicateCount: spec.duplicateCount ?? 0,
    source: {
      vendor: spec.vendor,
      product: spec.product,
      sourceAlertId: `${spec.vendor.slice(0, 3).toUpperCase()}-${String(48_210 + n)}`,
    },
    title: spec.title,
    ...(spec.description ? { description: spec.description } : {}),
    category: spec.category,
    severity: spec.sourceSeverity,
    occurredAt: iso(occurredMs),
    ...(spec.host ? { host: spec.host } : {}),
    ...(spec.user ? { user: spec.user } : {}),
    ...(spec.network ? { network: spec.network } : {}),
    ...(spec.file ? { file: spec.file } : {}),
    ...(spec.url ? { url: spec.url } : {}),
    indicators: spec.indicators.map((i) => ({ type: i.type, value: i.value })),
    mitre: spec.mitre,
    labels: spec.labels ?? {},
  };
  return {
    alert,
    severity: score?.severity ?? null,
    score,
    enrichments,
    assigneeId: spec.assignee ? (users[spec.assignee] ?? null) : null,
    caseId: null,
    resolvedAt: closed ? iso(receivedMs + (spec.resolvedAfterMin ?? 60) * 60_000) : null,
  };
}

const BACKGROUND_TITLES: { title: string; category: AlertCategory; technique: MitreMapping }[] = [
  {
    title: 'Suspicious sign-in from unfamiliar location',
    category: 'credential_access',
    technique: { techniqueId: 'T1078', techniqueName: 'Valid Accounts' },
  },
  {
    title: 'Known adware detected and quarantined',
    category: 'malware',
    technique: { techniqueId: 'T1204.002', techniqueName: 'User Execution: Malicious File' },
  },
  {
    title: 'Inbound port scan blocked at perimeter',
    category: 'reconnaissance',
    technique: { techniqueId: 'T1595', techniqueName: 'Active Scanning' },
  },
  {
    title: 'User reported suspicious email',
    category: 'phishing',
    technique: { techniqueId: 'T1566.001', techniqueName: 'Phishing: Spearphishing Attachment' },
  },
  {
    title: 'DNS query to newly registered domain',
    category: 'command_and_control',
    technique: { techniqueId: 'T1071.004', techniqueName: 'Application Layer Protocol: DNS' },
  },
  {
    title: 'Unapproved remote-access tool installed',
    category: 'policy_violation',
    technique: { techniqueId: 'T1219', techniqueName: 'Remote Access Software' },
  },
  {
    title: 'Outdated OpenSSL on internet-facing host',
    category: 'vulnerability',
    technique: { techniqueId: 'T1190', techniqueName: 'Exploit Public-Facing Application' },
  },
  {
    title: 'SMB lateral movement attempt between workstations',
    category: 'lateral_movement',
    technique: {
      techniqueId: 'T1021.002',
      techniqueName: 'Remote Services: SMB/Windows Admin Shares',
    },
  },
];
const BACKGROUND_SOURCES = [
  ['Microsoft', 'Defender for Endpoint'],
  ['OISF', 'Suricata'],
  ['Proofpoint', 'TAP'],
  ['Okta', 'Workforce Identity'],
  ['Wazuh', 'Wazuh'],
] as const;
const SEVERITY_CYCLE: Severity[] = [
  'low',
  'medium',
  'informational',
  'medium',
  'high',
  'low',
  'critical',
  'medium',
];

/** Picks an element by a number in [0, 1). */
function pick<T>(items: readonly T[], r: number): T {
  const item = items[Math.min(items.length - 1, Math.floor(r * items.length))];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
}

/**
 * Older, mostly closed alerts spread over the last 30 days, so the queue has more than
 * one page and the metrics charts have a realistic shape. Deterministic (seeded).
 */
function buildBackground(count: number, startN: number, now: number): StoredAlert[] {
  const random = seededRandom(42);
  const result: StoredAlert[] = [];
  for (let i = 0; i < count; i++) {
    const n = startN + i;
    const id = fakeId(ID_KIND.alert, n);
    const template = pick(BACKGROUND_TITLES, random());
    const [vendor, product] = pick(BACKGROUND_SOURCES, random());
    const sourceSeverity = pick(
      SEVERITY_CYCLE,
      (i % SEVERITY_CYCLE.length) / SEVERITY_CYCLE.length,
    );
    const receivedMs = now - Math.floor(6 * 3_600_000 + random() * 29 * 86_400_000);
    const occurredMs = receivedMs - Math.floor(20_000 + random() * 1_500_000);
    const roll = random();
    const status: AlertStatus =
      roll < 0.55 ? 'resolved' : roll < 0.85 ? 'false_positive' : roll < 0.93 ? 'triaged' : 'new';
    const extra = Math.round(random() * 30) - 10;
    const factors: ScoreFactor[] = [
      baseline(sourceSeverity),
      {
        ruleId: extra >= 0 ? 'context-boost' : 'benign-context',
        description: extra >= 0 ? 'Context rules matched' : 'Benign context reduced the score',
        points: extra === 0 ? 1 : extra,
      },
    ];
    const score = explainScore(factors, [], new Date(receivedMs + 5_000).toISOString());
    const closed = status === 'resolved' || status === 'false_positive';
    result.push({
      alert: {
        id,
        fingerprint: fingerprintOf(id),
        status,
        receivedAt: iso(receivedMs),
        lastSeenAt: iso(receivedMs),
        duplicateCount: Math.floor(random() * 3),
        source: { vendor, product },
        title: template.title,
        category: template.category,
        severity: sourceSeverity,
        occurredAt: iso(occurredMs),
        indicators: [],
        mitre: [template.technique],
        labels: {},
      },
      severity: score.severity,
      score,
      enrichments: [],
      assigneeId: null,
      caseId: null,
      resolvedAt: closed ? iso(receivedMs + Math.floor(600_000 + random() * 20 * 3_600_000)) : null,
    });
  }
  return result;
}

/** Builds every fixture alert relative to `now`: featured ones first, then background. */
export function buildAlerts(now: number, users: Record<string, string>): StoredAlert[] {
  const featured = FEATURED.map((spec, i) => buildFeatured(spec, i + 1, now, users));
  return [...featured, ...buildBackground(140, FEATURED.length + 1, now)];
}
