# Contributing to Spine

Thanks for helping! Spine is also a learning resource, so **explaining why** matters as much as the code.

## Setup

```bash
nvm use            # Node 22 (see .nvmrc)
corepack enable    # pnpm 10
pnpm install
cp .env.example .env
make up            # Postgres, Redis, API, worker, console, Prometheus, Grafana
```

## Workflow

1. Branch from `develop`: `feat/<module>-<topic>`, `fix/<topic>`, `docs/<topic>` ([ADR-0025](docs/adr/0025-git-workflow-and-ci-gates.md)).
2. Write a failing test first where practical.
3. Keep commits small and atomic, using [Conventional Commits](https://www.conventionalcommits.org):
   `feat(scoring): add negative weight for known scanners`. Hooks run commitlint and lint-staged.
4. Before pushing, run:
   ```bash
   pnpm lint && pnpm lint:arch && pnpm typecheck && pnpm test && pnpm docs:check
   ```
5. Open a PR to `develop` using the template: summary, ADRs touched, **how you tested
   (paste real output)**, screenshots for UI, risks.

## Rules of the road

- **A meaningful choice needs an ADR** ([template](docs/adr/template.md)). If you chose between options, write down why.
- **Docs change in the same PR as the code.**
- **Module boundaries are enforced** (`pnpm lint:arch`). Import other modules only via `public-api.ts`.
- **Domain code is pure.** No framework or I/O imports in `domain/`.
- **No real side effects.** Response adapters stay simulated ([ADR-0018](docs/adr/0018-simulated-response-adapters.md)).
- **No secrets in code or tests.** Use `.env` (git-ignored) and obviously fake test values.
- **No `any`.** Use `unknown` and narrow it.

## Required CI checks

lint, typecheck, arch, unit tests, integration tests, contract, build, docs, commitlint,
CodeQL, gitleaks, dependency audit, Docker build + Trivy. See `.github/workflows`.
