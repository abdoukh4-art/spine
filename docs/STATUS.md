# Project status: final report for v0.1.0

> **Honest by rule:** every number below comes from a run that was executed and observed on
> 2026-10-28. Anything not proven by a test or a recorded run is listed as unverified.

_Last updated: 2026-10-28 (night), end of Phase 3._

## Phase overview

| Phase | Scope                                                                                                                        | State                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 0     | Vision, ADRs, contracts, monorepo skeleton, CI, docs hub                                                                     | ✅ done (PR #1)             |
| 1     | Auth+audit (#2) · Playbooks (#3) · Enrichment+scoring (#4) · Ingestion+alerts (#5) · Console (#6) · Infra+observability (#7) | ✅ merged                   |
| 2     | Integration, metrics, demo, contract + e2e tests, tutorials                                                                  | ✅ done (PR #8)             |
| 3     | Security review, performance, docs completeness, final README, release PR                                                    | ✅ done (PR #8, release PR) |

## Complete (verified)

### Features (vision scope)

| #   | Feature                                                                                                                         | Evidence                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Ingestion: REST, HMAC-signed webhooks (Suricata EVE, generic), CEF/syslog and NDJSON batch; idempotency keys; fingerprint dedup | ingestion unit + integration tests; demo scenarios 3 and 4             |
| 2   | Canonical alert (ECS/OCSF-inspired) with MITRE ATT&CK mapping                                                                   | ADR-0011; normalizer tests; contract tests                             |
| 3   | Pluggable enrichers (reputation, geo, asset inventory; fixture-driven mocks) with timeout, retry + jitter, breaker, bulkhead    | enrichers package (100 % lines), property tests                        |
| 4   | Explainable, versioned rule scoring                                                                                             | scoring tests incl. fast-check laws; demo scores 70 / 100 / 100 / 5    |
| 5   | Playbooks: YAML DAG DSL, validation, dry-run, durable event-sourced runs, approvals, retry/timeout, compensation                | playbook-engine (99.6 % lines), end-to-end integration test, demo run  |
| 6   | Console: alert queue, alert detail with score explanation, runs timeline, approvals, playbooks, metrics; light/dark; WCAG AA    | 141 console tests; 4 Playwright journeys with axe; screenshots         |
| 7   | Auth: JWT + rotating refresh with reuse detection, argon2id, RBAC viewer/analyst/admin, append-only audit log                   | auth tests incl. RBAC matrix over every route, race test               |
| 8   | Metrics: MTTD/MTTR (ADR-0026 definitions), alert volume, playbook success rate/latency; Prometheus + Grafana dashboard          | metrics unit tests; demo values (69 alerts, MTTD 70 min, MTTR 188 min) |
| —   | `make demo` ("Operation Night Owl", five scenarios) on a fresh stack                                                            | run end to end on 2026-10-28; README screenshots taken from it         |

**Every response action is simulated** (firewall block, ticket, chat, status change). There is
no real offensive or destructive capability anywhere (ADR-0018).

### Tests (all run locally on 2026-10-28, all passing)

| Suite                                              | Count                                                                             | Result                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| Unit + property (Vitest, fast-check)               | **745**: shared-schema 61, enrichers 93, playbook-engine 65, console 141, api 385 | 745 / 745 ✅                  |
| Integration (Testcontainers Postgres 16 + Redis 7) | **150**, including the end-to-end pipeline and OpenAPI contract tests             | 150 / 150 ✅, 3 runs in a row |
| End-to-end (Playwright + axe, real Compose stack)  | **4** analyst journeys                                                            | 4 / 4 ✅ (also green in CI)   |

### Coverage (`pnpm test:coverage`; API also with `test:coverage:all`)

| Package / layer                  | Lines                     | Branches   |
| -------------------------------- | ------------------------- | ---------- |
| packages/playbook-engine         | **99.6 %**                | 90.1 %     |
| packages/enrichers               | **100 %**                 | 98.4 %     |
| packages/shared-schema           | **97.4 %**                | 89.5 %     |
| apps/console                     | 97.8 %                    | 88.7 %     |
| api `*/domain/` (all 7 modules)  | **98.9–100 %** per module | 91–100 %   |
| apps/api overall (unit only)     | 60.1 %                    | 56.4 %     |
| **apps/api, unit + integration** | **95.6 %**                | **86.8 %** |

The ≥ 85 % target for domain code and the playbook engine is met. API adapters (Postgres,
BullMQ, HTTP) are tested against real infrastructure by the integration suite, so the API's
meaningful number is the combined run (`pnpm --filter @spine/api test:coverage:all`): **95.6 %
lines**. CI enforces ≥ 90 % lines / 80 % branches on it, and ≥ 85 % on domain folders from unit
tests alone ([ADR-0091](adr/0091-combined-unit-and-integration-coverage.md)).

### Performance (k6, one 4-core host, details in [performance.md](operations/performance.md))

- 200 alerts/s through nginx: **0 errors**, accepted p95 **167 ms** / p99 269 ms, 0.4 % shed with
  `503 + Retry-After` (back-pressure working as designed).
- Ingest → scored at 20 alerts/s: p50 98 ms, **p95 125 ms**, p99 269 ms.
- Two load bugs found and fixed: Redis OOM → HTTP 500s, and polling latency (ADR-0090).

### Security

- Adversarial review ([report](security/review-2026-10-28.md)): 7 findings. **5 fixed** with
  regression tests (F1, F2, F3, F5; F3 mutation-checked), **F4 documented** with the operational
  fix, F6/F7 accepted for v0.1.
- STRIDE [threat model](security/threat-model.md), [OWASP Top 10 mapping](security/owasp-top10.md),
  [RBAC](security/rbac.md).
- CI: CodeQL, gitleaks, `pnpm audit` (clean), Trivy on both images (0 fixable HIGH/CRITICAL), SBOM.

### CI and engineering

- 17 checks on every PR: lint, arch (dependency-cruiser boundaries), typecheck, unit, integration,
  contract drift, build, docs links, commitlint, CodeQL, gitleaks, deps-audit, SBOM, Docker
  build + Trivy (api, console), e2e on the full stack. Release workflow (release-please).
- Feature PRs #1–#8 merged into `develop` after green CI. The release PR `develop → main`
  ("Spine v0.1.0") is open for the owner's review and is **not merged**.

### Docs (learning hub)

71 ADRs (MADR, each with rejected alternatives and "what would make us revisit"), C4 / ERD /
sequence diagrams / event catalog / OpenAPI, module guides with exercises and separate solutions
for every module, 3 tutorials rehearsed against the code, runbooks, SLOs, backup/restore, upgrade,
threat model, testing strategy, glossary, reading list, and 9 journal entries. CI fails on broken
links.

## Stubbed / not done

- **Integrations are simulated by design** (ADR-0018); enrichment providers are fixture-driven mocks. No real third-party calls.
- Not run: the load-test knee above 200/s, the 30-minute soak, and multi-host runs.
- F4: the API connects to Postgres as the table owner, so the audit log is append-only by trigger, not by privilege (fix documented, not wired).
- Batch import is synchronous within one request (F6); no four-eyes approvals (F7).
- No retention/purge jobs for `domain_events` or the enrichment inbox (enrichment exercise 5).
- Playbooks run steps sequentially; parallel branches aren't implemented.
- Non-goals for v0.1: SSO/MFA, multi-tenancy, a visual playbook editor.

## Known issues

- Score-sorted pagination can repeat or skip an alert that is re-scored while paging (ADR-0037).
- Circuit-breaker state is per process: the API shows its own breakers, the worker's are
  visible only as metrics.
- Locally (this build environment) the console image can't run `apk upgrade` (Alpine CDN
  unreachable), so `APK_UPGRADE=false` is set in `.env`. CI upgrades normally.

## Recommended next steps

1. Separate migration and runtime database roles (F4) with an ADR and Compose support.
2. Run the load-test knee sweep, the 30-minute soak, and a multi-host run.
3. `LISTEN/NOTIFY` outbox wake-ups and slimmer queue payloads (ADR-0090 "revisit").
4. Retention jobs for `domain_events` and the enrichment inbox.
5. Async batch imports (F6), four-eyes approvals (F7), parallel playbook branches.
6. OIDC SSO, more source normalizers (OCSF export), more step types (tutorial 03's `isolate_host`).
