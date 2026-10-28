// k6 load test: alert ingestion through the edge (nginx → API → outbox).
// Run with scripts/load-test.sh (k6 in Docker). Method: docs/operations/performance.md.
//
// Model: an OPEN workload (ramping-arrival-rate). Requests arrive at a target rate whether
// or not earlier ones finished, which is how sensors behave. A closed model (fixed VUs
// looping) slows down when the server slows down and hides queueing ("coordinated
// omission").
//
// Outcomes are classified, not lumped together:
//   202          accepted (created or deduplicated)
//   503          back-pressure: the pipeline is behind and asked the sender to retry
//                (ADR-0024); counted separately, it's the system protecting itself
//   429          rate limited: the per-client limit is too low for this test (configuration)
//   anything else  an error; must stay under 1 %
import { check } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const PEAK_RATE = Number(__ENV.PEAK_RATE || 100); // alerts per second at the plateau
const RAMP = __ENV.RAMP || '1m';
const HOLD = __ENV.HOLD || '3m';
const DUPLICATE_RATIO = Number(__ENV.DUPLICATE_RATIO || 0.1); // share of re-sent alerts

const backpressure = new Counter('spine_backpressure_503');
const rateLimited = new Rate('spine_rate_limited');
const unexpected = new Rate('spine_unexpected_status');
const acceptedLatency = new Trend('spine_accepted_duration', true);

// 202, 429 and 503 are "expected" so http_req_failed only counts genuine errors.
http.setResponseCallback(http.expectedStatuses(202, 429, 503));

export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: Math.max(1, Math.round(PEAK_RATE / 10)),
      timeUnit: '1s',
      preAllocatedVUs: Math.max(10, PEAK_RATE),
      maxVUs: PEAK_RATE * 5,
      stages: [
        { target: PEAK_RATE, duration: RAMP },
        { target: PEAK_RATE, duration: HOLD },
        { target: 0, duration: '30s' },
      ],
    },
  },
  thresholds: {
    // Latency SLO for the synchronous part of ingest (accepted requests only).
    'http_req_duration{expected_response:true}': ['p(95)<500'],
    spine_accepted_duration: ['p(95)<500', 'p(99)<1500'],
    // Genuine errors (5xx other than 503, 4xx other than 429) under 1 %.
    http_req_failed: ['rate<0.01'],
    spine_unexpected_status: ['rate<0.01'],
    // If this trips, raise RATE_LIMIT_MAX_PER_MINUTE for the test: we are measuring the
    // pipeline, not the abuse limiter.
    spine_rate_limited: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const CATEGORIES = [
  ['intrusion', 'ET EXPLOIT Possible exploitation attempt', 'TA0001', 'T1190'],
  ['malware', 'Suspicious executable launched from temp directory', 'TA0002', 'T1204.002'],
  ['command_and_control', 'Beaconing to known C2 infrastructure', 'TA0011', 'T1071.001'],
  ['credential_access', 'Multiple failed logons followed by success', 'TA0006', 'T1110'],
  ['phishing', 'User clicked link in reported phishing email', 'TA0001', 'T1566.002'],
  ['reconnaissance', 'Horizontal port scan from internal host', 'TA0007', 'T1046'],
  ['exfiltration', 'Large outbound transfer to rare destination', 'TA0010', 'T1048'],
];
const SEVERITIES = [
  'informational',
  'low',
  'low',
  'medium',
  'medium',
  'medium',
  'high',
  'critical',
];
const SOURCES = [
  { vendor: 'OISF', product: 'Suricata' },
  { vendor: 'Elastic', product: 'Elastic Defend' },
  { vendor: 'Microsoft', product: 'Defender for Endpoint' },
  { vendor: 'Okta', product: 'Workforce Identity' },
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function hex(len) {
  let s = '';
  while (s.length < len)
    s += Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0');
  return s.slice(0, len);
}

// Documentation ranges only (RFC 5737): synthetic data never points at real hosts.
function testIp() {
  return `${pick(['192.0.2', '198.51.100', '203.0.113'])}.${1 + Math.floor(Math.random() * 254)}`;
}

/** A realistic canonical alert (CanonicalAlertInput, ADR-0011). */
export function syntheticAlert(sourceAlertId) {
  const [category, title, tacticId, techniqueId] = pick(CATEGORIES);
  const src = testIp();
  const dst = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 254)}`;
  const host = `ws-${Math.floor(Math.random() * 500)
    .toString()
    .padStart(4, '0')}.corp.example`;
  return {
    source: { ...pick(SOURCES), sourceAlertId },
    title,
    description: `Synthetic load-test alert (${category}).`,
    category,
    severity: pick(SEVERITIES),
    occurredAt: new Date(Date.now() - Math.floor(Math.random() * 120_000)).toISOString(),
    host: { hostname: host, ips: [dst] },
    user: { name: `user${Math.floor(Math.random() * 2000)}` },
    network: {
      sourceIp: src,
      sourcePort: 1024 + Math.floor(Math.random() * 60000),
      destinationIp: dst,
      destinationPort: pick([22, 53, 80, 443, 445, 3389, 8080]),
      protocol: pick(['tcp', 'udp']),
    },
    indicators: [
      { type: 'ipv4', value: src },
      { type: 'domain', value: `${hex(8)}.example.net` },
      { type: 'sha256', value: hex(64) },
    ],
    mitre: [{ tacticId, techniqueId }],
    labels: { loadtest: 'true' },
  };
}

/** Logs in as the demo analyst unless SPINE_TOKEN is provided. */
export function setup() {
  if (__ENV.SPINE_TOKEN) return { token: __ENV.SPINE_TOKEN };
  const res = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({
      email: __ENV.SPINE_EMAIL || 'admin@spine.test',
      password: __ENV.SPINE_PASSWORD || '',
    }),
    {
      headers: { 'content-type': 'application/json' },
      responseCallback: http.expectedStatuses(200),
    },
  );
  if (res.status !== 200) {
    throw new Error(
      `login failed (${res.status}): set SPINE_TOKEN, or SPINE_EMAIL/SPINE_PASSWORD for an analyst`,
    );
  }
  return { token: res.json('accessToken') };
}

let sent = 0;
const recentIds = [];

export default function ingest(data) {
  // Re-send an earlier alert now and then: exercises deduplication (ADR-0012).
  const duplicate = recentIds.length > 0 && Math.random() < DUPLICATE_RATIO;
  const sourceAlertId = duplicate ? pick(recentIds) : `lt-${__VU}-${sent++}-${hex(8)}`;
  if (!duplicate) {
    recentIds.push(sourceAlertId);
    if (recentIds.length > 50) recentIds.shift();
  }

  const res = http.post(
    `${BASE_URL}/api/v1/alerts`,
    JSON.stringify(syntheticAlert(sourceAlertId)),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${data.token}`,
        'idempotency-key': `lt-${hex(24)}`,
      },
      tags: { name: 'POST /api/v1/alerts' },
    },
  );

  if (res.status === 503) backpressure.add(1);
  rateLimited.add(res.status === 429);
  unexpected.add(![202, 429, 503].includes(res.status));
  if (res.status === 202) acceptedLatency.add(res.timings.duration);

  check(res, {
    'accepted or shed (202/503)': (r) => r.status === 202 || r.status === 503,
    'has request id': (r) => Boolean(r.headers['X-Request-Id']),
  });
}
