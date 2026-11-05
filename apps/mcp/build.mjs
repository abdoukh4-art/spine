// Production build: bundle the stdio entry point with esbuild (same approach as apps/api,
// ADR-0027). Workspace packages are TypeScript source and get bundled in; third-party deps
// stay external.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@spine/'));

await build({
  entryPoints: ['src/main.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
  banner: { js: '#!/usr/bin/env node' },
});
