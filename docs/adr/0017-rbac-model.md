# ADR-0017: Role-based access control with three hierarchical roles

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** security

## Context and problem statement

Different users must be allowed to do different things: read-only auditors, analysts who
triage and approve, and admins who change playbooks, rules and users. Broken access
control is OWASP Top 10 #1 (A01:2021).

## Decision drivers

- Simple enough to reason about and test exhaustively.
- Deny by default, enforced server-side on every route.
- The console hides actions a user can't perform, but **never** relies on that for security.

## Considered options

1. **Three hierarchical roles (viewer < analyst < admin), checked per route via a declarative `requireRole`**
2. Fine-grained permissions (`alerts:write`, `playbooks:publish`, …) assigned through roles
3. Attribute-based access control (ABAC) with a policy engine (OPA/Cedar)

## Decision outcome

**Chosen option 1**, with a permission matrix that is code (`platform/http/authorize.ts`)
**and** documentation ([security/rbac.md](../security/rbac.md)), checked by a test that
iterates over every registered route and asserts it declares an access policy. A route
without a policy fails the test, which gives us deny-by-default.

| Capability                                            | viewer | analyst | admin |
| ----------------------------------------------------- | :----: | :-----: | :---: |
| Read alerts, cases, runs, metrics                     |   ✅   |   ✅    |  ✅   |
| Change alert status/assignee, create cases            |        |   ✅    |  ✅   |
| Approve/reject approval gates                         |        |   ✅    |  ✅   |
| Start manual / dry-run playbook runs                  |        |   ✅    |  ✅   |
| Publish playbooks, change scoring rules               |        |         |  ✅   |
| Manage users, read audit log                          |        |         |  ✅   |
| Submit alerts manually (`POST /alerts`, batch import) |        |   ✅    |  ✅   |

Machine ingestion uses **webhook secrets** (HMAC-SHA256 signature over the body,
`X-Spine-Signature` header, with a timestamp to prevent replay) per source, not user accounts.

### Consequences

- 👍 Easy to test: three roles × N routes, generated as a table-driven test.
- 👎 Coarse. "Analyst can approve only for their team" is not expressible. Acceptable for v0.1.

## Pros and cons of the options

### Fine-grained permissions

- 👍 Flexible.
- 👎 More moving parts, and easy to misconfigure. Our routes map cleanly onto three roles today.

### ABAC / policy engine

- 👍 Expressive and auditable policies.
- 👎 A new language and runtime. Overkill for three roles.

## What would make us revisit this

- Multi-team SOCs need team-scoped data → permissions + resource ownership (ABAC-lite).
- Customers need custom roles.

## Further reading

- OWASP Top 10 2021, A01 Broken Access Control
- NIST RBAC model (Sandhu et al., 2000)
