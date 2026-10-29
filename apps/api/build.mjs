// Production build (ADR-0027): bundle each entrypoint with esbuild. Workspace packages
// (@spine/*) are TypeScript source and get bundled in; third-party deps stay external
// and are installed in the runtime image with `pnpm deploy --prod`.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@spine/'));

await build({
  entryPoints: [
    'src/main.ts',
    'src/worker.ts',
    'src/instrument.ts',
    'src/cli/migrate.ts',
    'src/cli/seed.ts',
  ],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
