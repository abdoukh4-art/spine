# Project status: final report for v0.1.0

> **Honest by rule:** every number below comes from a run that was executed and observed.
> Anything not proven by a test or a recorded run is listed as unverified.

_Last updated: 2026-11-05. v0.1 shipped on 2026-10-28; the gaps it listed were closed on 2026-10-29
(PRs #10–#13), and closing them overturned two earlier conclusions (see the
[journal](journal/2026-10-29-closing-the-gaps.md)). PRs #14–#19 added an AI analyst over MCP with four-eyes approvals, tutorial 04, OCSF export, a Sigma
rule catalog and supply-chain signing ([journal](journal/2026-11-05-ai-analyst-mcp.md))._

## Phase overview

| Phase | Scope                                                                                                                        | State                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0     | Vision, ADRs, contracts, monorepo skeleton, CI, docs hub                                                                     | ✅ done (PR #1)                                 |
| 1     | Auth+audit (#2) · Playbooks (#3) · Enrichment+scoring (#4) · Ingestion+alerts (#5) · Console (#6) · Infra+observability (#7) | ✅ merged                                       |
| 2     | Integration, metrics, demo, contract + e2e tests, tutorials                                                                  | ✅ done (PR #8)                                 |
| 3     | Security review, performance, docs completeness, final README                                                                | ✅ done (PR #8)                                 |
| 3+    | Close the reported gaps: coverage (#10), DB roles / F4 (#11), overload behaviour, DB-side metrics, TSDoc (#12)               | ✅ done                                         |
| AI    | AI analyst MCP server, four-eyes approvals (#14); approval-window race fix (#15)                                             | ✅ done                                         |
| 2026+ | Tutorial 04 (#16), OCSF 1.9.0 export (#17), Sigma rule catalog (#18), supply-chain pinning/signing/provenance (#19)          | ✅ done (release signing runs at first release) |
| —     | Release PR `develop → main` "Spine v0.1.0"                                                                                   | open for the owner, **never merged**            |

## Complete (verified)

### Features (vision scope)

| #   | Feature                                                                                                                         | Evidence                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Ingestion: REST, HMAC-signed webhooks (Suricata EVE, generic), CEF/syslog and NDJSON batch; idempotency keys; fingerprint dedup | ingestion unit + integration tests; demo scenarios 3 and 4              |
| 2   | Canonical alert (ECS/OCSF-inspired) with MITRE ATT&CK mapping                                                                   | ADR-0011; normalizer tests; contract tests                              |
| 3   | Pluggable enrichers (reputation, geo, asset inventory; fixture-driven mocks) with timeout, retry + jitter, breaker, bulkhead    | enrichers package (100 % lines), property tests                         |
| 4   | Explainable, versioned rule scoring                                                                                             | scoring tests incl. fast-check laws; demo scores 70 / 100 / 100 / 5     |
| 5   | Playbooks: YAML DAG DSL, validation, dry-run, durable event-sourced runs, approvals, retry/timeout, compensation                | playbook-engine (99.6 % lines), end-to-end integration test, demo run   |
| 6   | Console: alert queue, alert detail with score explanation, runs timeline, approvals, playbooks, metrics; light/dark; WCAG AA    | 141 console tests; 4 Playwright journeys with axe; screenshots          |
| 7   | Auth: JWT + rotating refresh with reuse detection, argon2id, RBAC viewer/analyst/admin, append-only audit log                   | RBAC matrix over every route, race test, runtime DB role (ADR-0092)     |
| 8   | Metrics: MTTD/MTTR (ADR-0026), alert volume, playbook success rate/latency; Prometheus + Grafana; aggregated in Postgres        | metrics unit tests + SQL = TypeScript differential test (ADR-0095)      |
| —   | `make demo` ("Operation Night Owl", five scenarios) on a fresh stack                                                            | run end to end on 2026-10-28 and 2026-10-29; README screenshots from it |

**Every response action is simulated** (firewall block, ticket, chat, status change). There is
no real offensive or destructive capability anywhere (ADR-0018). No real secrets or third-party
calls: everything runs offline from fixtures.

### Tests (all run locally and in CI, all passing)

| Suite                                              | Count                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Unit + property (Vitest, fast-check)               | **779**: shared-schema 61, enrichers 93, playbook-engine 65, console 141, api 404, mcp 15     |
| Integration (Testcontainers Postgres 16 + Redis 7) | **165**, incl. end-to-end pipeline, OpenAPI contract, DB-role attacks, SQL-vs-spec, four eyes |
| End-to-end (Playwright + axe, real Compose stack)  | **4** analyst journeys                                                                        |

Mutation checks: the most important tests were also proven to **fail** when the code they guard is
broken (end-to-end wiring, webhook replay, DB-role `REVOKE`, queue back-pressure, SQL clamp,
coverage gate).

### Coverage (enforced in CI)

| Package / layer                                 | Lines      | Branches   | Gate (CI fails below)      |
| ----------------------------------------------- | ---------- | ---------- | -------------------------- |
| packages/playbook-engine                        | **99.6 %** | 90.1 %     | 85 %                       |
| packages/enrichers                              | **100 %**  | 98.4 %     | 85 %                       |
| packages/shared-schema                          | **97.4 %** | 89.5 %     | 85 %                       |
| apps/console                                    | 97.8 %     | 88.7 %     | —                          |
| api `src/modules/*/domain/**` (unit tests only) | 98.9–100 % | 91–100 %   | 85 % (ADR-0091)            |
| **apps/api, unit + integration**                | **95.5 %** | **86.9 %** | 90 % lines / 80 % branches |
| apps/mcp                                        | 97.6 %     | 81.7 %     | 85 % lines / 80 % branches |

### Performance ([performance.md](operations/performance.md); one 4-core host shared by k6 and the whole stack)

- **Overload is bounded:** at 250 alerts/s offered, 0 errors and accepted p95 **354 ms**; every
  request gets `202` or `503 + Retry-After` (vision S3 met). At 400/s, 0.95 % errors (CPU-bound host).
  Before ADR-0093 the same runs had p95 9.9–14.7 s and 18–52 % errors.
- **Sustainable rate** = pipeline throughput, **≈ 42–45 alerts/s** on this host; above it,
  back-pressure keeps the backlog bounded.
- **Latency at realistic load:** ingest → scored p95 **125 ms** at 20/s.
- **Soak (30 min at 30 alerts/s):** 55 439 requests, **0 errors**, accepted p95 21 ms; heap and Redis flat,
  backlog ≤ 22; RSS +6–9 MB over 30 min (a multi-hour soak would confirm the plateau).
- `GET /metrics/summary` over 177 k alerts and 41 k runs: 0.49 s, with constant memory.

### Security

- Adversarial review ([report](security/review-2026-10-28.md)): 7 findings, **6 fixed** with
  regression tests (F1–F5, and F7 by four-eyes approvals), 1 accepted for v0.1 (F6 synchronous
  batch import).
- F4 closed by [ADR-0092](adr/0092-separate-migration-and-runtime-database-roles.md): the app runs
  as a non-owner role and **cannot** rewrite or un-protect the audit log (tested as the attack itself,
  on the live stack too); production refuses a privileged role.
- STRIDE [threat model](security/threat-model.md), [OWASP Top 10 mapping](security/owasp-top10.md),
  [RBAC](security/rbac.md). CI: CodeQL, gitleaks, `pnpm audit` (clean), Trivy on both images, SBOM.

### CI and engineering

- 17 checks on every PR: lint (+ TSDoc), arch (dependency-cruiser), typecheck, unit, integration
  (+ combined coverage gates), contract drift, build, docs links, commitlint, CodeQL, gitleaks,
  deps-audit, SBOM, Docker build + Trivy (api, console), e2e on the full stack. Release workflow
  (release-please).
- **Supply chain** ([ADR-0099](adr/0099-supply-chain-pinning-signing-provenance.md)): all 48 GitHub
  Action references pinned to commit SHAs, enforced by `check-workflows.mjs` in CI (mutation-checked)
  and kept current by Dependabot. Release images get keyless cosign signatures and SLSA build
  provenance; an OpenSSF Scorecard workflow publishes the score.
- PRs #1–#19 merged into `develop` after green CI. The release PR `develop → main`
  ("Spine v0.1.0") is open for the owner's review and is **not merged**.

### AI analyst (MCP)

- `apps/mcp`: an MCP server that lets Claude (Claude Code, Claude Desktop) triage through Spine's
  public API as its own account ([ADR-0096](adr/0096-mcp-ai-analyst-with-guardrails.md)). 8 tools,
  dry runs by default, sensor text fenced as untrusted, no tool to approve, reject or close.
- **Four-eyes approvals, enforced by Spine:** whoever started a run can't approve it. Verified on the
  live stack: the agent's raw token gets `403` on its own run.
- Live smoke test (`apps/mcp/scripts/smoke.mjs`): **14/14** checks.

### Docs (learning hub)

77 ADRs (MADR, each with rejected alternatives and "what would make us revisit"), C4 / ERD /
sequence diagrams / event catalog / OpenAPI, module guides with exercises and separate solutions
for every module, 4 tutorials rehearsed against the code, runbooks, SLOs, backup/restore, upgrade,
threat model, testing strategy, glossary, reading list, 11 journal entries. **TSDoc on 341/341
public exports**, enforced in CI (ADR-0094). CI fails on broken links.

## Stubbed / not done

- **Integrations are simulated by design** (ADR-0018); enrichment providers are fixture-driven mocks.
- **Release signing, provenance and Scorecard are configured but not yet exercised:** they run only on
  `main` (first release). The pinned `ci.yml`/`security.yml` are exercised on every PR; the two new
  workflows were checked structurally, not run.
- **Multi-host performance:** every number was measured on one 4-core machine running k6, nginx, the
  API, the worker and Postgres together. Separate hosts were not available in this environment;
  the procedure is documented.
- Batch import is synchronous within one request (F6).
- No retention/purge jobs for `domain_events` or the enrichment inbox (enrichment exercise 5).
- Playbooks run steps sequentially; parallel branches aren't implemented.
- Non-goals for v0.1: SSO/MFA, multi-tenancy, a visual playbook editor.

## Known issues

- Score-sorted pagination can repeat or skip an alert that is re-scored while paging (ADR-0037).
- Circuit-breaker state is per process: the API shows its own breakers, the worker's are
  visible only as metrics.
- The in-flight cap is per API process (N replicas allow N × 16); a fixed cap, not adaptive (ADR-0093).
- Locally (this build environment) the console image can't run `apk upgrade` (Alpine CDN
  unreachable), so `APK_UPGRADE=false` is set in `.env`. CI upgrades normally.

## Recommended next steps

1. Load-test on separate hosts (API, worker, Postgres, load generator), then tune `EVENT_WORKER_CONCURRENCY` and the pool.
2. `LISTEN/NOTIFY` outbox wake-ups and slimmer queue payloads (ADR-0090 "revisit").
3. Retention jobs for `domain_events` and the enrichment inbox.
4. Async batch imports (F6), parallel playbook branches.
5. OIDC SSO, bulk OCSF export, more step types (tutorial 03's `isolate_host`).
