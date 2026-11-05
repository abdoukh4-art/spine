# @spine/console

The analyst console: React 19 + Vite + TanStack Query + React Router 7, with hand-built
accessible components (WCAG 2.2 AA) and no UI kit
([ADR-0023](../../docs/adr/0023-console-react-vite-no-ui-kit.md)).

```bash
pnpm --filter @spine/console dev          # http://localhost:5173, proxies /api to :3000
pnpm --filter @spine/console test         # Vitest + Testing Library + axe-core
pnpm --filter @spine/console test:coverage
pnpm --filter @spine/console typecheck
pnpm --filter @spine/console build
```

## Standalone demo (no backend)

```bash
VITE_USE_FAKE_API=true pnpm --filter @spine/console dev
```

The console then talks to an in-browser fake of the v1 API with realistic fixtures
([ADR-0071](../../docs/adr/0071-console-in-browser-fake-api.md)). Demo accounts (they exist only
in your browser): `ada@spine.local` (admin), `sam@spine.local` (analyst), `val@spine.local`
(viewer), password `spine-demo-password`. A normal build doesn't include the fake at all.

## Layout

- `src/lib/api`: typed client (Zod-validated responses, RFC 9457 errors, single-flight refresh)
- `src/lib/auth`: in-memory session, silent refresh, `useCan`, route guards
- `src/components`: the design system
- `src/features`: one folder per page area
- `src/fake`: fake API + fixtures shared by tests and the demo
- `src/test`: render helpers and `expectNoAxeViolations`

Full guide, design, invariants and exercises: [docs/modules/console.md](../../docs/modules/console.md).
