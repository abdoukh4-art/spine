#!/usr/bin/env node
// Documentation integrity checks (run in CI; see docs/testing/strategy.md):
//  1. Every relative Markdown link points to an existing file (anchors are not checked).
//  2. Every ADR file is listed in docs/adr/README.md.
//  3. Every workspace package and app has a README.md.
//  4. Every module under apps/api/src/modules has docs/modules/<name>.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'playwright-report',
  'test-results',
]);
const errors = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|!\[[^\]]*\]\(([^)\s]+)\)/g;
for (const file of walk(root)) {
  // Strip fenced code blocks so example links inside them are not checked.
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of text.matchAll(LINK)) {
    const target = match[1] ?? match[2];
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    const clean = decodeURIComponent(target.split('#')[0]);
    if (!clean) continue;
    const resolved = path.resolve(path.dirname(file), clean);
    if (!existsSync(resolved)) {
      errors.push(`${path.relative(root, file)}: broken link → ${target}`);
    }
  }
}

const adrDir = path.join(root, 'docs/adr');
const adrIndex = readFileSync(path.join(adrDir, 'README.md'), 'utf8');
for (const f of readdirSync(adrDir)) {
  if (/^\d{4}-.+\.md$/.test(f) && !adrIndex.includes(`(${f})`)) {
    errors.push(`docs/adr/README.md: ADR ${f} is not listed in the index`);
  }
}

for (const group of ['apps', 'packages']) {
  for (const pkg of readdirSync(path.join(root, group))) {
    const dir = path.join(root, group, pkg);
    if (
      statSync(dir).isDirectory() &&
      existsSync(path.join(dir, 'package.json')) &&
      !existsSync(path.join(dir, 'README.md'))
    ) {
      errors.push(`${group}/${pkg}: missing README.md`);
    }
  }
}

const modulesDir = path.join(root, 'apps/api/src/modules');
for (const m of readdirSync(modulesDir)) {
  if (
    statSync(path.join(modulesDir, m)).isDirectory() &&
    !existsSync(path.join(root, 'docs/modules', `${m}.md`))
  ) {
    errors.push(`docs/modules/${m}.md: missing module documentation`);
  }
}

if (errors.length > 0) {
  console.error(`✖ ${errors.length} documentation problem(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log('✔ docs: links, ADR index, package READMEs and module docs are consistent');
