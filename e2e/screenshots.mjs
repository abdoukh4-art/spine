// Captures README screenshots from a RUNNING demo stack (make demo). Not part of the test run.
// Usage: node e2e/screenshots.mjs  → docs/assets/screenshots/*.png
import { chromium } from '@playwright/test';

const base = process.env.SPINE_BASE_URL ?? 'http://localhost:8080';
const out = new URL('../docs/assets/screenshots/', import.meta.url).pathname;
const browser = await chromium.launch();

async function shoot(theme) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('textbox', { name: 'Email' }).fill('analyst@spine.test');
  await page
    .getByLabel('Password')
    .fill(process.env.SPINE_DEMO_ANALYST_PASSWORD ?? 'night-owl-demo-dana-2026');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Alert queue' }).waitFor();
  await page.goto(`${base}/alerts?sort=score`);
  await page.getByRole('heading', { level: 1, name: 'Alert queue' }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}alert-queue-${theme}.png` });

  await page
    .getByRole('main')
    .getByRole('link')
    .filter({ hasText: /Cobalt Strike beacon and LSASS/ })
    .first()
    .click();
  await page.getByRole('heading', { name: 'Why this score?' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}alert-detail-${theme}.png`, fullPage: true });

  const runLink = page
    .getByRole('region', { name: 'Runs for this alert' })
    .getByRole('link')
    .first();
  if (await runLink.count()) {
    await runLink.click();
    await page.getByRole('heading', { name: 'Timeline' }).waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}run-timeline-${theme}.png`, fullPage: true });
  }
  await page.goto(`${base}/approvals`);
  await page.getByRole('heading', { level: 1, name: 'Approvals' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}approvals-${theme}.png` });
  await page.goto(`${base}/metrics`);
  await page.getByRole('heading', { name: 'Mean time to detect (MTTD)' }).waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}metrics-${theme}.png`, fullPage: true });
  await context.close();
}

await shoot('light');
await shoot('dark');
await browser.close();
console.log(`screenshots written to ${out}`);
