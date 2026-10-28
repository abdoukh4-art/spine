# 2026-10-28 — Day 0: foundations before code

## Goal of the session

Turn an empty repo (a README with one line) into a project with a written vision,
founding architecture decisions and a contract that parallel workstreams can build against,
**before** writing any application code.

## What I did, in order, and why

1. **Checked the environment before planning.** Node 22.22, pnpm 10.28, Postgres 16 and
   Redis 7 binaries, Docker 29, and a preinstalled Playwright 1.63 with Chromium.
   _Lesson:_ check your tools before you design around them. Two surprises turned up:
   - The Docker daemon wasn't running. Starting `dockerd` manually worked.
   - Pulling `postgres:16-alpine` from Docker Hub failed with **HTTP 429 (rate limit)**.
     _Hypothesis:_ anonymous pull quota on a shared egress IP. _Experiment:_ pull the same
     image from `mirror.gcr.io/library/postgres:16-alpine`. _Result:_ it worked, so I
     re-tagged it locally. _Consequence:_ the testing ADR (0021) gained a fallback that
     lets integration tests use `TEST_DATABASE_URL` / `TEST_REDIS_URL` instead of
     Testcontainers, because a test strategy that depends on one registry being reachable is fragile.
   - `gh auth status` said the token was invalid, but `gh api` calls worked (the environment
     injects credentials at a proxy). _Lesson:_ trust experiments over status messages.
2. **Checked library versions before choosing them.** The npm registry already had
   TypeScript 7, Vitest 5, ESLint 10 and Vite 8. New majors are risky: plugins lag, and
   blog posts describe the old APIs. I wrote ADR-0022: pin exact versions, and use the
   latest _mature_ major unless the new one is more than 3 months old. Playwright is pinned
   to 1.63 because that's the browser build installed in the container. A version mismatch
   would make Playwright look for browsers that aren't there.
3. **Wrote the vision (`00-vision.md`)** with explicit **non-goals**. Non-goals are the most
   useful part of a vision: "not a SIEM" and "no real response actions" cut away whole
   categories of work and risk.
4. **Wrote 26 ADRs.** The hardest ones to decide were:
   - _Event sourcing: where?_ It's tempting to apply it everywhere because it's interesting.
     The honest answer was "only playbook runs", because that's where history is a
     _requirement_ (resume after crash, full timeline). Everything else gets an audit log. (ADR-0010)
   - _How do modules talk?_ Direct calls are simple but create a crash window (the dual-write
     problem). The transactional outbox fixes it at the cost of eventual consistency. (ADR-0009)
   - _Playbook conditions._ Embedding JavaScript expressions is the obvious idea, but Node's
     own docs say `vm` is not a security boundary. A closed predicate language is safer
     **and** can be shared with the scoring engine. (ADR-0013, ADR-0015)
5. **Wrote the contract** (API, data model, event catalog) so that the six parallel
   workstreams have a fixed interface to build against.

## What I'd tell a junior engineer from this session

- Spend the first hour on _why_ and _what_, not _how_. It's cheaper to change a Markdown table
  than a migration.
- An ADR that lists only the chosen option is propaganda. The rejected options are the lesson.
- Write down your environment surprises. They become your CI's edge cases.

## Postscript: the first CI run, and a policy bug

The first push ran CI on GitHub. 12 of 14 checks passed. Two failed, and both taught me something.

**1. `deps-audit`: 43 advisories (2 critical, 18 high).**

- _Observation:_ every vulnerable package was one I had pinned _on purpose_ to a version
  I knew well (Fastify 5.6, React Router 7.9, Vitest 3.2…).
- _Hypothesis:_ the version policy (ADR-0022) optimized the wrong thing. It avoided
  new-major risk but ignored known-vulnerability risk in old patch levels.
- _Experiment:_ upgrade each package to the newest release **in the same major** that's
  past the patched version. Vitest needed a major bump (3 → 4), because the Tinypool RCE fix only exists there.
- _Result:_ `pnpm audit` reports 0 vulnerabilities, and all 87 unit + 8 integration
  tests still pass. The upgrade surfaced two Fastify deprecations, which I fixed. I recorded
  the corrected rule in [ADR-0028](../adr/0028-security-patches-override-version-maturity.md)
  instead of editing ADR-0022 (accepted ADRs are immutable; you supersede or amend them).
- _Lesson:_ "use mature versions" means "use a mature **major** line, at its latest **patch**."
  Patch releases are where security fixes live.

**2. `CodeQL`: one high alert, "exponential backtracking".**

- It pointed at a _test_ that deliberately feeds `(a+)+$` to the ReDoS guard to prove it's
  rejected. A true positive for the pattern, a false positive for the risk.
- Fix: scope CodeQL to production code (`.github/codeql/codeql-config.yml`). The guard itself
  is in `src/` and is still scanned.
- _Lesson:_ security scanners are evidence, not verdicts. Read each finding, and when you
  suppress one, write down why it's safe.
