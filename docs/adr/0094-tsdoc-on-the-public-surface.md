# ADR-0094: Require TSDoc on the public surface, enforced in CI

- **Status:** accepted (adds a gate to [ADR-0025](0025-git-workflow-and-ci-gates.md))
- **Date:** 2026-10-29
- **Deciders:** maintainers
- **Tags:** docs, ci

## Context and problem statement

Spine's brief asks for TSDoc, and the repository is meant to be read as a learning resource
([vision](../00-vision.md)). Nothing checked it.
The v0.1 status report said TSDoc was "present on the main public interfaces" without having
measured it. The first measurement (2026-10-29) found **172 of 341 public exports documented
(50.4 %)**, or 190 (55.7 %) when a schema's inferred type inherits the schema's comment (see below). Almost every gap was in `@spine/shared-schema`: Zod schemas whose meaning was obvious
to their authors and to nobody else (`AuditQuerySchema`, `RetryPolicySchema`…).

What should be documented, and how do we keep it that way?

## Decision drivers

- A learner reading `@spine/shared-schema` should understand each contract from the editor's hover.
- Measurable and enforced: a rule that isn't checked decays.
- No busywork: don't demand comments on every private helper, or repeat the same sentence twice.
- No new dependencies for a check that's ~100 lines.

## Considered options

1. **A script on the TypeScript compiler API** that walks the exports of each package entry point
   (`packages/*/src/index.ts`) and each module's `public-api.ts`, and fails on any export without a
   doc comment.
2. `eslint-plugin-jsdoc` `require-jsdoc` on every exported declaration in the repo.
3. API Extractor (`ae-undocumented`) per package.
4. Review discipline only.

## Decision outcome

**Option 1** (`scripts/check-tsdoc.mjs`, `pnpm check:tsdoc`, in the `lint` CI job and
`make check`). It checks exactly the **public surface**: what another package or module may
import. Internal code is left to review judgement.

Conventions the checker encodes:

- **A Zod schema carries the docs; its inferred type is its twin.** `export type Alert = z.infer<typeof AlertSchema>`
  counts as documented when `AlertSchema` is, instead of repeating the comment.
- A comment must sit on the declaration itself. A file-level `/** … */` that happens to precede the
  first export doesn't count; use `//` for file headers (we found and fixed one such false positive).
- Comments explain meaning and constraints (units, defaults, which ADR), not the type.

Result: **341/341 (100 %)** public exports documented. Each new comment was checked against the code
and the API contract (for example, `GET /audit-log`, not `/audit`).

Option 2 would flag hundreds of internal declarations and push towards filler comments.
Option 3 is heavier (per-package config, `.d.ts` rollups) for the same signal. Option 4 is what
produced 50 %.

### Consequences

- 👍 Hover docs everywhere on the contracts; generated docs (TypeDoc) would now be meaningful.
- 👍 The number is measured and enforced, not estimated.
- 👎 One more CI step, and a comment is required before a new public export can merge.
- ⚖️ The check verifies that a comment exists, not that it's right. Review still owns accuracy.

## What would make us revisit this

- We publish packages to npm → API Extractor for API reports and breaking-change detection.
- Internal modules grow large enough that their own boundaries need docs → extend the entry-point list.

## Further reading

- TSDoc specification (tsdoc.org); TypeScript compiler API, `getJSDocCommentsAndTags`
