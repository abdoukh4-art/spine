import { createHash } from 'node:crypto';
import type { Alert, AlertCategory, Severity } from '@spine/shared-schema';
import { createApplication } from '../composition.js';
import { createAuthModule } from '../modules/auth/index.js';
import { loadConfig } from '../platform/config.js';
import { createLogger } from '../platform/logger.js';
import { ManualClock } from '../platform/runtime.js';

/**
 * Demo seeder (admin process, twelve-factor XII). Idempotent: safe to run on every `make demo`.
 *
 * 1. Demo users: `analyst@spine.test` and `viewer@spine.test` (the admin comes from
 *    BOOTSTRAP_ADMIN_* on first API start). Passwords come from SPINE_DEMO_*_PASSWORD.
 * 2. Seven days of synthetic, already-handled alert history, so the Metrics page and the
 *    Grafana MTTD/MTTR panels show a trend instead of a single data point. History goes
 *    through the Alerts module's public API with a manual clock (receivedAt / resolvedAt in
 *    the past) and emits no `alert.ingested`, so it never triggers enrichment or playbooks.
 *
 * Everything is synthetic (documentation IP ranges, example domains). Deterministic: the
 * same seed always produces the same history.
 */

const HISTORY_DAYS = 7;
const ALERTS_PER_DAY = 9;

interface HistoryTemplate {
  title: string;
  category: AlertCategory;
  severity: Severity;
  product: string;
}
const TEMPLATES: HistoryTemplate[] = [
  {
    title: 'Credential phishing link clicked',
    category: 'phishing',
    severity: 'medium',
    product: 'MailGuard',
  },
  {
    title: 'Suspicious PowerShell download cradle',
    category: 'intrusion',
    severity: 'high',
    product: 'EDR',
  },
  {
    title: 'Outbound connection to known C2 address',
    category: 'command_and_control',
    severity: 'high',
    product: 'IDS',
  },
  {
    title: 'Repeated VPN authentication failures',
    category: 'credential_access',
    severity: 'medium',
    product: 'VPN',
  },
  {
    title: 'Internal port scan detected',
    category: 'reconnaissance',
    severity: 'low',
    product: 'IDS',
  },
  {
    title: 'Malware quarantined on workstation',
    category: 'malware',
    severity: 'medium',
    product: 'EDR',
  },
  {
    title: 'Large upload to unsanctioned file share',
    category: 'exfiltration',
    severity: 'high',
    product: 'Proxy',
  },
  {
    title: 'USB mass storage policy violation',
    category: 'policy_violation',
    severity: 'low',
    product: 'DLP',
  },
];

/** Small deterministic PRNG (mulberry32): the history is identical on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable RFC 4122 v4-shaped UUID derived from a name, so re-runs find existing rows. */
function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  const variant = ((parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Minutes, skewed: most values small, a long tail (like real detection and response times). */
function skewedMinutes(random: () => number, min: number, max: number): number {
  return Math.round(min + (max - min) * random() ** 3);
}

interface HistoryEntry {
  alert: Alert;
  outcome: 'resolved' | 'false_positive' | 'open';
  resolvedAt: Date | null;
}

function buildHistory(now: Date): HistoryEntry[] {
  const random = prng(20261028);
  const entries: HistoryEntry[] = [];
  for (let day = HISTORY_DAYS; day >= 1; day--) {
    for (let i = 0; i < ALERTS_PER_DAY; i++) {
      const n = (HISTORY_DAYS - day) * ALERTS_PER_DAY + i;
      const template = TEMPLATES[Math.floor(random() * TEMPLATES.length)] as HistoryTemplate;
      const receivedAt = new Date(
        now.getTime() - day * 86_400_000 + Math.floor(random() * 86_000_000),
      );
      const occurredAt = new Date(receivedAt.getTime() - skewedMinutes(random, 1, 240) * 60_000);
      const roll = random();
      const outcome = roll < 0.08 ? 'open' : roll < 0.3 ? 'false_positive' : 'resolved';
      const resolvedAt =
        outcome === 'open'
          ? null
          : new Date(receivedAt.getTime() + skewedMinutes(random, 5, 720) * 60_000);
      const iso = receivedAt.toISOString();
      entries.push({
        outcome,
        resolvedAt,
        alert: {
          id: stableUuid(`spine-demo-history-${n}`),
          fingerprint: createHash('sha256').update(`spine-demo-history|${n}`).digest('hex'),
          status: 'new',
          receivedAt: iso,
          lastSeenAt: iso,
          duplicateCount: 0,
          source: { vendor: 'Acme', product: template.product, sourceAlertId: `history-${n}` },
          title: template.title,
          category: template.category,
          severity: template.severity,
          occurredAt: occurredAt.toISOString(),
          indicators: [],
          mitre: [],
          labels: { origin: 'demo-history' },
        },
      });
    }
  }
  return entries;
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Security review F2: demo users have published passwords; never create them in production.
  if (config.NODE_ENV === 'production' && process.env.SPINE_ALLOW_DEMO_SEED !== 'true') {
    throw new Error(
      'seed: refusing to create demo users in production (set SPINE_ALLOW_DEMO_SEED=true to override)',
    );
  }
  const logger = createLogger(config);
  const clock = new ManualClock();
  const app = createApplication(config, { logger, clock, redis: null });
  try {
    const auth = createAuthModule(app.deps);
    const created = await auth.seedUsers([
      {
        email: 'analyst@spine.test',
        displayName: 'Dana Analyst',
        role: 'analyst',
        password: process.env.SPINE_DEMO_ANALYST_PASSWORD ?? 'night-owl-demo-dana-2026',
      },
      {
        email: 'viewer@spine.test',
        displayName: 'Victor Viewer',
        role: 'viewer',
        password: process.env.SPINE_DEMO_VIEWER_PASSWORD ?? 'night-owl-demo-victor-2026',
      },
    ]);
    logger.info({ created }, 'seed: demo users ensured');

    const alerts = await seedHistory(app, clock);
    logger.info({ inserted: alerts }, 'seed: alert history ensured');
  } finally {
    await app.deps.db.destroy();
  }
}

/** Inserts the synthetic history through the Alerts public API; skips rows that exist. */
async function seedHistory(
  app: ReturnType<typeof createApplication>,
  clock: ManualClock,
): Promise<number> {
  const alertsApi = app.alertsApi;
  let inserted = 0;
  for (const entry of buildHistory(new Date())) {
    if (await alertsApi.get(entry.alert.id)) continue;
    clock.set(entry.alert.receivedAt);
    await app.deps.db.transaction().execute((trx) => alertsApi.create(trx, entry.alert));
    if (entry.outcome !== 'open' && entry.resolvedAt) {
      clock.set(entry.resolvedAt);
      await alertsApi.setStatus(entry.alert.id, 'triaged', null);
      await alertsApi.setStatus(entry.alert.id, entry.outcome, null);
    }
    inserted += 1;
  }
  return inserted;
}

await main();
