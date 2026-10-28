# 2026-10-28 — Day 0: foundations before code

## Goal of the session

Turn an empty repo (a README with one line) into a project with a written vision,
founding architecture decisions and a contract that parallel workstreams can build against,
**before** writing any application code.

## What I did, in order, and why

1. **Checked the environment before planning.** Node 22.22, pnpm 10.28, Postgres 16 and
   Redis 7 binaries, Docker 29, and a preinstalled Playwright 1.63 with Chromium.
   *Lesson:* check your tools before you design around them. Two surprises turned up:
   - The Docker daemon wasn't running. Starting `dockerd` manually worked.
   - Pulling `postgres:16-alpine` from Docker Hub failed with **HTTP 429 (rate limit)**.
     *Hypothesis:* anonymous pull quota on a shared egress IP. *Experiment:* pull the same
     image from `mirror.gcr.io/library/postgres:16-alpine`. *Result:* it worked, so I
     re-tagged it locally. *Consequence:* the testing ADR (0021) gained a fallback that
     lets integration tests use `TEST_DATABASE_URL` / `TEST_REDIS_URL` instead of
     Testcontainers, because a test strategy that depends on one registry being reachable is fragile.
   - `gh auth status` said the token was invalid, but `gh api` calls worked (the environment
     injects credentials at a proxy). *Lesson:* trust experiments over status messages.
2. **Checked library versions before choosing them.** The npm registry already had
   TypeScript 7, Vitest 5, ESLint 10 and Vite 8. New majors are risky: plugins lag, and
   blog posts describe the old APIs. I wrote ADR-0022: pin exact versions, and use the
   latest *mature* major unless the new one is more than 3 months old. Playwright is pinned
   to 1.63 because that's the browser build installed in the container. A version mismatch
   would make Playwright look for browsers that aren't there.
3. **Wrote the vision (`00-vision.md`)** with explicit **non-goals**. Non-goals are the most
   useful part of a vision: "not a SIEM" and "no real response actions" cut away whole
   categories of work and risk.
4. **Wrote 26 ADRs.** The hardest ones to decide were:
   - *Event sourcing: where?* It's tempting to apply it everywhere because it's interesting.
     The honest answer was "only playbook runs", because that's where history is a
     *requirement* (resume after crash, full timeline). Everything else gets an audit log. (ADR-0010)
   - *How do modules talk?* Direct calls are simple but create a crash window (the dual-write
     problem). The transactional outbox fixes it at the cost of eventual consistency. (ADR-0009)
   - *Playbook conditions.* Embedding JavaScript expressions is the obvious idea, but Node's
     own docs say `vm` is not a security boundary. A closed predicate language is safer
     **and** can be shared with the scoring engine. (ADR-0013, ADR-0015)
5. **Wrote the contract** (API, data model, event catalog) so that the six parallel
   workstreams have a fixed interface to build against.

## What I'd tell a junior engineer from this session

- Spend the first hour on *why* and *what*, not *how*. It's cheaper to change a Markdown table
  than a migration.
- An ADR that lists only the chosen option is propaganda. The rejected options are the lesson.
- Write down your environment surprises. They become your CI's edge cases.
