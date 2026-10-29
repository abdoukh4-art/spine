# ADR-0028: Security patches override the "mature version" rule

- **Status:** accepted (amends [ADR-0022](0022-dependency-pinning-and-version-policy.md))
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** security, process

## Context and problem statement

ADR-0022 told us to prefer the _latest stable minor of a mature major_ over brand-new
majors. While bootstrapping we read that as "pick a version we know well", and pinned
Fastify 5.6.2, Zod 4.1.13, React Router 7.9.4, Vite 7.1.12 and Vitest 3.2.7. The first CI
run's `pnpm audit` reported **43 advisories (2 critical, 18 high)** against those pins,
including Fastify body-validation bypasses, React Router XSS/DoS, a Zod memory-exhaustion
issue and a critical Tinypool (Vitest) prototype-pollution-to-RCE.

The policy had optimized for API familiarity and forgotten that **old patch levels carry
known vulnerabilities**.

## Decision drivers

- Known vulnerabilities are a concrete risk; API churn is a hypothetical one.
- CI must stay green on `pnpm audit --audit-level high` (a required check).

## Considered options

1. **Within a chosen major, always take the latest patched minor/patch; move to a newer major only when the fix exists only there**
2. Keep the familiar versions and suppress the advisories
3. Always take the absolute latest of everything

## Decision outcome

**Chosen option 1.** The rule from ADR-0022 becomes:

> Choose the major line by maturity (more than 3 months old, ecosystem support). **Within that
> line, pin the newest release that has no known high/critical advisory.** If a fix exists
> only in a newer major (as with Vitest 3 → 4 for Tinypool), take that major and record it here.

Applied now: Fastify 5.12.7, Zod 4.6.7, `@fastify/swagger` 9.9.2, `@fastify/swagger-ui` 6.1.2
(pulls in the patched `@fastify/static` 10), React Router 7.18.5, Vite 7.3.7, Vitest 4.1.12,
Ajv 8.20.0. A pnpm override forces `uuid ≥ 11.1.1` under `testcontainers → dockerode`
(a moderate advisory in a dev-only path, with an API-compatible fix).
Result: `pnpm audit` reports **no known vulnerabilities**, and all tests still pass.

### Consequences

- 👍 The audit gate is green, and the rule is explicit about how to resolve the trade-off.
- 👎 Upgrades surfaced deprecations (two Fastify logging options), which were fixed in the same change.
- ⚖️ Overrides are a sharp tool. Each one must name the advisory and be removed when upstream updates.

## What would make us revisit this

- An override lingers more than 90 days → open an issue upstream or replace the dependency.

## Further reading

- GitHub Advisory Database; `pnpm audit` docs; OpenSSF Scorecard "Vulnerabilities" check
