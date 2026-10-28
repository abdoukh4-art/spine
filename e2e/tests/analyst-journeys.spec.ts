import { expect, test } from '@playwright/test';
import {
  ANALYST,
  apiToken,
  expectAccessible,
  ingestMalwareAlert,
  login,
  VIEWER,
} from './support.js';

test.describe('analyst journeys (real stack)', () => {
  test('the queue shows scored alerts and the detail page explains the score', async ({ page }) => {
    await login(page, ANALYST);
    await expect(page.getByRole('heading', { level: 1, name: 'Alert queue' })).toBeVisible();
    await expectAccessible(page);

    // Highest risk first: open the top alert.
    await page.goto('/alerts?sort=score');
    const firstAlert = page
      .getByRole('main')
      .getByRole('link')
      .filter({ hasText: /fin-db01|beacon/i })
      .first();
    await firstAlert.click();
    await expect(page.getByRole('heading', { name: 'Why this score?' })).toBeVisible();
    await expect(
      page.getByText('The affected host is a critical asset', { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Indicators and enrichment' })).toBeVisible();
    await expectAccessible(page);
  });

  test('an analyst approves a containment and the run succeeds', async ({ page, request }) => {
    const token = await apiToken(request);
    const { alertId, title } = await ingestMalwareAlert(request, token);

    await login(page, ANALYST);
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    // The card for OUR alert: the approval prompt quotes the alert's unique title.
    const card = page.getByRole('listitem').filter({ hasText: title });
    await expect(async () => {
      await page.reload();
      await expect(card).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expectAccessible(page);
    await card.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('dialog').getByLabel('Comment (optional)').fill('e2e: contain');
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.getByText('Approved. The run continues.')).toBeVisible();

    // The run on the alert detail page reaches "succeeded".
    await page.goto(`/alerts/${alertId}`);
    await expect(page.getByRole('heading', { name: 'Playbook runs' })).toBeVisible();
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/succeeded/i).first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  });

  test('a viewer can read but cannot act', async ({ page }) => {
    await login(page, VIEWER);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Users' })).toHaveCount(0);
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  });

  test('the metrics page shows MTTD, MTTR and alert volume', async ({ page }) => {
    await login(page, ANALYST);
    await page.goto('/metrics');
    await expect(page.getByRole('heading', { name: 'Mean time to detect (MTTD)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mean time to respond (MTTR)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Alert volume: \d+ alerts/ })).toBeVisible();
    await expectAccessible(page);
  });
});
