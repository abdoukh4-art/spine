import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const ANALYST = {
  email: 'analyst@spine.test',
  password: process.env.SPINE_DEMO_ANALYST_PASSWORD ?? 'night-owl-demo-dana-2026',
};
export const VIEWER = {
  email: 'viewer@spine.test',
  password: process.env.SPINE_DEMO_VIEWER_PASSWORD ?? 'night-owl-demo-victor-2026',
};

/** Logs in through the real login form. */
export async function login(page: Page, user: { email: string; password: string }): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Log in to Spine' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

/** Fails on serious or critical WCAG 2.x A/AA violations (ADR-0023). */
export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`)).toEqual([]);
}

/** Obtains an access token for API-level setup steps. */
export async function apiToken(request: APIRequestContext, user = ANALYST): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: user });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Ingests a fresh critical malware alert (unique per call) and returns its id. */
export async function ingestMalwareAlert(
  request: APIRequestContext,
  token: string,
): Promise<{ alertId: string; title: string }> {
  const tag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const title = `E2E beacon on fin-db01 (${tag})`;
  const res = await request.post('/api/v1/alerts', {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': `e2e-${tag}` },
    data: {
      source: { vendor: 'Acme', product: 'EDR', sourceAlertId: `e2e-${tag}` },
      title,
      category: 'malware',
      severity: 'high',
      occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      host: { hostname: 'fin-db01.corp.example', ips: ['10.20.5.20'] },
      network: {
        sourceIp: '10.20.5.20',
        destinationIp: '203.0.113.66',
        destinationPort: 443,
        protocol: 'tcp',
      },
      mitre: [{ tacticId: 'TA0011', techniqueId: 'T1071.001' }],
    },
  });
  expect(res.status(), await res.text()).toBe(202);
  return { alertId: ((await res.json()) as { alertId: string }).alertId, title };
}
