# Project status

> Updated after every milestone. **Honest by rule:** anything not proven by a test or a
> recorded run is listed as unverified.

_Last updated: 2026-10-28 (evening), end of Phase 2 (integration)._

## Phase overview

| Phase | Scope                                                                                                                        | State           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 0     | Vision, ADRs, contracts, monorepo skeleton, CI, docs hub                                                                     | ✅ done (PR #1) |
| 1     | Auth+audit (#2) · Playbooks (#3) · Enrichment+scoring (#4) · Ingestion+alerts (#5) · Console (#6) · Infra+observability (#7) | ✅ merged       |
| 2     | Integration, metrics, demo, contract + e2e tests, tutorials                                                                  | ✅ done (PR #8) |
| 3     | Security review, performance, docs completeness, final README, release PR                                                    | ⏳ in progress  |

## Done (verified)

- **End-to-end on the real stack** (`make up` + `./scripts/demo.sh`): five scenarios →
  enrichment → explainable scores (70 / 100 / 100 / 5) → `malware-containment` playbook →
  approval → simulated block, ticket and chat → run `succeeded` (15 events) → metrics
  (69 alerts with seeded history; MTTD mean 70 min, MTTR mean 188 min).
- **Tests** (local, all passing):
  - Unit: shared-schema 61, enrichers 93, playbook-engine 65, console 141, api 379.
  - Integration: 149 (Testcontainers Postgres 16 + Redis 7), including the end-to-end pipeline and the contract tests.
  - Playwright on the real stack: 4 journeys with axe accessibility checks.
- **Coverage** (from the workstream reports, unit): playbook-engine 99.6 % lines / 90.1 % branches,
  enrichers 99.5 % / 98.4 %, shared-schema 98.9 % lines; domain folders 98–100 % lines.
- **Performance** (k6, one 4-core host): 200 alerts/s accepted with 0 errors, p95 167 ms, 0.4 % shed by
  back-pressure; ingest → scored p95 125 ms at 20/s. Two load bugs found and fixed (ADR-0090).
- **Contract:** real responses validated against the committed `openapi.json`; CI fails if the file is stale.
- **CI:** lint, arch, typecheck, unit, integration, contract, build, docs, commitlint, CodeQL,
  gitleaks, pnpm audit, SBOM, Docker build + Trivy (api, console), e2e.
- **Docs:** 70 ADRs, module guides with exercises and solutions for every module, three
  tutorials rehearsed against the code, operations runbooks, threat model, journal.

## Stubbed / not done

- Load test: knee above 200/s and the 30-minute soak not run yet ([performance.md](operations/performance.md)).
- Threat-model rows still marked ⏳ (repudiation for playbook publish/enable/cancel is audited
  after commit, not atomically).
- No real integrations (by design, ADR-0018), no SSO/MFA, no multi-tenancy (non-goals).

## Known issues

- One unexplained failure of the end-to-end integration test (did not reproduce in 9 later runs);
  see the [integration journal](journal/2026-10-28-integration.md).
- Score-sorted pagination can repeat or skip an alert that is re-scored while paging (ADR-0037).
- Circuit-breaker state is per process: the API shows its own breakers, the worker's are
  visible only as metrics.
- The enrichment inbox table has no purge job yet (enrichment exercise 5).
- Locally (this build environment) the console image can't run `apk upgrade` (Alpine CDN
  unreachable), so `APK_UPGRADE=false` is set in `.env`. CI upgrades normally.
