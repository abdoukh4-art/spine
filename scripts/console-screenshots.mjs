#!/usr/bin/env node
// Takes the console screenshots in docs/assets/console/ (light and dark) from the
// standalone demo (fake API). Also runs axe-core in a real browser on each page, where
// colour contrast *can* be computed (jsdom can't).
//
// Usage (Playwright with Chromium must be installed globally):
//   VITE_USE_FAKE_API=true pnpm --filter @spine/console exec vite build --outDir dist/demo
//   pnpm --filter @spine/console exec vite preview --outDir dist/demo --port 5199 &
//   node scripts/console-screenshots.mjs http://localhost:5199
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const base = process.argv[2] ?? 'http://localhost:5199';
const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.resolve(here, '../docs/assets/console');
// axe-core is a devDependency of the console package.
const consoleRequire = createRequire(path.resolve(here, '../apps/console/package.json'));
const axeSource = readFileSync(consoleRequire.resolve('axe-core/axe.min.js'), 'utf8');
mkdirSync(outDir, { recursive: true });

const pages = [
  { name: 'alert-queue', path: '/alerts', ready: 'Cobalt Strike beacon' },
  { name: 'alert-detail', path: null, ready: 'Why this score?' },
  { name: 'approvals', path: '/approvals', ready: 'Expires in' },
  { name: 'metrics', path: '/metrics', ready: 'Alerts per day' },
];

async function login(page) {
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill('sam@spine.local');
  await page.getByLabel('Password').fill('spine-demo-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByRole('heading', { name: 'Alert queue' }).waitFor();
}

async function axeCheck(page, name) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const result = await window.axe.run(document, {
      runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'],
    });
    return result.violations.map((v) => `${v.id}: ${v.nodes.length} node(s)`);
  });
  console.log(`axe ${name}: ${violations.length === 0 ? 'no violations' : violations.join(', ')}`);
  return violations.length;
}

const browser = await chromium.launch();
let failures = 0;
for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: scheme,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await login(page);
  for (const shot of pages) {
    if (shot.path) {
      await page.goto(`${base}${shot.path}`);
    } else {
      await page.goto(`${base}/alerts`);
      await page.getByRole('link', { name: /Cobalt Strike beacon/ }).click();
    }
    await page.getByText(shot.ready).first().waitFor();
    await page.waitForTimeout(400);
    failures += await axeCheck(page, `${shot.name} (${scheme})`);
    const file = path.join(outDir, `${shot.name}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: shot.name !== 'alert-queue' });
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
  await context.close();
}
await browser.close();
process.exit(failures > 0 ? 1 : 0);
