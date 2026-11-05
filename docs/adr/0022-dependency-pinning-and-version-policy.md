# ADR-0022: Pin exact dependency versions; prefer mature releases over newest majors

- **Status:** accepted, amended by [ADR-0028](0028-security-patches-override-version-maturity.md)
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** security, process

## Context and problem statement

Supply-chain attacks on npm (typosquatting, hijacked maintainers, malicious patch
releases) are a real threat, and so are breaking changes in fresh major versions. While
bootstrapping, several libraries had brand-new major versions (e.g. TypeScript 7, Vitest 5,
ESLint 10) only weeks or months old.

## Decision drivers

- Reproducible builds: the same lockfile gives the same tree.
- Supply-chain hygiene (OWASP A06 Vulnerable and Outdated Components, A08 Software and Data Integrity Failures).
- Stability: ecosystem plugins lag new majors.

## Considered options

1. **Exact versions in every `package.json` (`save-exact=true`), committed `pnpm-lock.yaml`, `--frozen-lockfile` in CI, latest _stable minor of the previous mature major_ where a new major is less than 3 months old, Dependabot weekly grouped updates**
2. Caret ranges (`^1.2.3`) with the lockfile only
3. Always the latest versions

## Decision outcome

**Chosen option 1.** Concretely, for v0.1: TypeScript 5.9, Vitest 3.2, ESLint 9, Vite 7,
React 19.2, Fastify 5.6, Zod 4.1, Kysely 0.28, BullMQ 5, Playwright 1.63 (matching the
browser build available in the dev container).

- `.npmrc`: `save-exact=true`, `engine-strict=true`.
- CI installs with `pnpm install --frozen-lockfile`. Any lockfile drift fails.
- `pnpm audit --audit-level high` runs in CI. Dependabot opens grouped weekly PRs
  (`dev-dependencies`, `opentelemetry`, `react`), and each one has to pass the full suite.
- A new major version is adopted through an ADR when it is more than 3 months old and its
  plugins support it.
- `onlyBuiltDependencies` in `pnpm-workspace.yaml` allow-lists packages that may run install
  scripts (a supply-chain defence: pnpm 10 blocks lifecycle scripts by default).

### Consequences

- 👍 Reproducible, reviewable dependency changes.
- 👎 Manual work to upgrade, mitigated by Dependabot.
- 👎 We're one major behind on some tools. Acceptable.

## What would make us revisit this

- Dependabot PR backlog > 10 → enable auto-merge for patch updates of dev dependencies.

## Further reading

- OpenSSF, _Concise Guide for Evaluating Open Source Software_
- pnpm docs, _onlyBuiltDependencies_
