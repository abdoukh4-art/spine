#!/usr/bin/env node
// Structural checks for .github/workflows (ADR-0099), run in the CI lint job:
//  1. Every `uses:` of a remote action is pinned to a full 40-hex commit SHA (Scorecard's
//     Pinned-Dependencies). Dependabot keeps the pins current.
//  2. Every workflow sets top-level `permissions` (least privilege by default).
//  3. Every job has `runs-on`, and every `needs` names a job of the same workflow.
//  4. Every `needs.<job>.outputs.<name>` reference names an output that job declares.
// Not a replacement for actionlint (expression typing, shell checks); it guards what matters most.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const dir = path.resolve(import.meta.dirname, '../.github/workflows');
const errors = [];

for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(path.join(dir, file), 'utf8');
  const wf = parse(text);
  if (!wf || typeof wf !== 'object') {
    errors.push(`${file}: not a YAML mapping`);
    continue;
  }
  if (!('permissions' in wf)) errors.push(`${file}: no top-level permissions`);
  const jobs = wf.jobs ?? {};
  for (const [name, job] of Object.entries(jobs)) {
    if (!job['runs-on'] && !job.uses) errors.push(`${file}: job ${name} has no runs-on`);
    const needs = [job.needs ?? []].flat();
    for (const n of needs)
      if (!(n in jobs)) errors.push(`${file}: job ${name} needs unknown job ${n}`);
    for (const step of job.steps ?? []) {
      const uses = step.uses;
      if (!uses || uses.startsWith('./') || uses.startsWith('docker://')) continue;
      const ref = uses.split('@')[1];
      if (!ref || !/^[0-9a-f]{40}$/.test(ref)) {
        errors.push(`${file}: job ${name}: "${uses}" is not pinned to a commit SHA`);
      }
    }
  }
  for (const m of text.matchAll(/needs\.([\w-]+)\.outputs\.([\w-]+)/g)) {
    const [, job, output] = m;
    if (!jobs[job]?.outputs || !(output in jobs[job].outputs)) {
      errors.push(`${file}: needs.${job}.outputs.${output} is not declared by job ${job}`);
    }
  }
}

if (errors.length > 0) {
  console.error(
    `✖ ${errors.length} workflow problem(s):\n${errors.map((e) => `  ${e}`).join('\n')}`,
  );
  process.exit(1);
}
console.log('✔ workflows: actions pinned to SHAs, permissions set, job graph consistent');
