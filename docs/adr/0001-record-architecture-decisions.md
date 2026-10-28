# ADR-0001: Record architecture decisions as MADR files

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** process

## Context and problem statement

Spine is both a working product and a **learning resource**. Readers have to be able to
see *why* the system looks the way it does, not only *what* it is. Decisions that live
only in chat logs, commit messages or someone's head are lost, and future contributors
then either re-argue them forever or change them without knowing the trade-offs.

## Decision drivers

- Every meaningful choice, big or small, needs a written "why" (a project rule).
- The format must be readable on GitHub with no extra tooling.
- Decisions must be easy to supersede without rewriting history.

## Considered options

1. **MADR (Markdown Architectural Decision Records)** in `docs/adr/NNNN-title.md`
2. Michael Nygard's original short ADR format
3. A wiki (GitHub Wiki / Notion)
4. Design docs only (Google-style long-form), with no per-decision records

## Decision outcome

**Chosen option: MADR**, with three Spine-specific sections it requires:
*Considered options* (rejected alternatives included), *Consequences* (good and bad),
and **What would make us revisit this** (concrete triggers).

Rules:

- Files are numbered sequentially and never renumbered: `docs/adr/0007-postgres.md`.
- An accepted ADR is **immutable** except for its status line. To change a decision,
  write a new ADR that supersedes the old one and link both ways.
- `docs/adr/README.md` is the index, and CI checks that every ADR file is listed in it.
- A PR that makes a meaningful choice must add or update an ADR in the same PR.

### Consequences

- 👍 Decisions are reviewable in PRs, versioned with the code, and searchable.
- 👍 Rejected alternatives are recorded, which saves future re-arguing and teaches trade-offs.
- 👎 Writing ADRs takes time. We accept this, because teaching is a core goal (G6).
- ⚖️ Small decisions get short ADRs, which is fine. Length does not measure importance.

## Pros and cons of the options

### MADR
- 👍 Structured, so readers know where to look. It's widely used and has a template.
- 👎 Slightly more ceremony than Nygard's format.

### Nygard format
- 👍 Very lightweight.
- 👎 Has no explicit "options considered" section, so newcomers lose the most educational part.

### Wiki
- 👍 Easy to edit.
- 👎 Not versioned with the code and not reviewed in PRs. Drifts out of date.

### Design docs only
- 👍 Good for big up-front designs.
- 👎 Too heavy for the many small decisions (e.g. "which pagination style").

## What would make us revisit this

- If ADRs go unread because there are too many (more than 150), introduce topic
  groupings or a decision log summary.
- If contributors routinely skip ADRs, add a CI check tied to PR labels.

## Further reading

- Michael Nygard, *Documenting Architecture Decisions* (2011)
- MADR project: <https://adr.github.io/madr/>
