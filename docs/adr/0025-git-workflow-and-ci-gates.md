# ADR-0025: Git workflow (develop/feature branches, Conventional Commits) and required CI gates

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** process

## Context and problem statement

Several workstreams (modules) are built in parallel. We need a branching model that
isolates them, a commit convention that can drive automated versioning and changelogs,
and a definition of "mergeable" that a machine enforces.

## Decision drivers

- `main` always reflects a released, reviewed state.
- Parallel module work without blocking each other.
- Automated semantic versioning and CHANGELOG generation.
- Quality gates that aren't optional.

## Considered options

1. **Simplified git-flow: `main` (releases) ← `develop` (integration) ← `feat/<module>` branches; Conventional Commits; squash-free merges of small atomic commits**
2. Trunk-based development (short-lived branches straight to `main`, feature flags)
3. Full git-flow (release/ and hotfix/ branches)

## Decision outcome

**Chosen option 1.**

- `main` receives only (a) the founding docs commit and (b) release merges from `develop`
  via a reviewed PR titled `Spine vX.Y.Z`.
- `develop` integrates feature PRs once CI is green.
- Branch names: `feat/<module>`, `fix/<topic>`, `docs/<topic>`, `chore/<topic>`.
- Commits follow **Conventional Commits 1.0** (`feat(ingestion): add CEF normalizer`),
  enforced by commitlint locally (husky `commit-msg`) and in CI on PR commits.
- **Required status checks** (configure as branch protection on `develop` and `main`):
  `lint`, `typecheck`, `arch`, `test-unit`, `test-integration`, `contract`, `build`,
  `docs-links`, `commitlint`, `codeql`, `gitleaks`, `deps-audit`, `docker-build-scan`.
  `e2e` is required on `main` only, since it's slower.
- **Release:** the `release` workflow runs on pushes to `main`, computes the next semver
  from Conventional Commits since the last tag (`feat` → minor, `fix` → patch, `!`/`BREAKING CHANGE` → major),
  updates `CHANGELOG.md`, tags `vX.Y.Z`, and publishes a GitHub Release with the SBOM attached.
  The tool is `release-please` (Google's, PR-based), so releases are reviewable PRs.

### Consequences

- 👍 Parallel module work integrates continuously on `develop`, while `main` stays stable.
- 👍 Changelogs are generated, not hand-written.
- 👎 One more long-lived branch than trunk-based. Acceptable while modules land in parallel.

## Pros and cons of the options

### Trunk-based
- 👍 The fastest integration, and favoured by DORA research.
- 👎 Needs feature flags and very mature CI from day one. The mission specifies develop + release PR.

### Full git-flow
- 👎 Release/hotfix branches are ceremony with no benefit for a single-deployable project.

## What would make us revisit this

- After v0.1, move to trunk-based development with feature flags once the CI suite is
  reliably under 10 minutes.

## Further reading

- Conventional Commits 1.0.0 specification
- *Accelerate*, Forsgren, Humble, Kim (2018): trunk-based development findings
- release-please documentation
