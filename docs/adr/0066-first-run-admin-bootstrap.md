# ADR-0066: First-run admin bootstrap from environment variables, only on an empty users table

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** auth workstream
- **Tags:** security, ops

## Context and problem statement

User management needs an admin, and creating an admin needs an admin. A fresh deployment
needs a way in. Common answers each have a security smell: a default `admin/admin` account,
a setup wizard reachable by whoever finds it first, or a CLI that requires shell access to
the container.

## Decision drivers

- Twelve-factor: configuration via environment (factor III).
- No default credentials, ever.
- Can't be used later as a backdoor.
- Safe when several API replicas start at once.

## Considered options

1. **`BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD`: at startup, if the users table is empty, create that admin.**
2. A CLI command (`pnpm --filter @spine/api create-admin`).
3. A first-visit setup page in the console.

## Decision outcome

**Chosen option 1.** The auth module's `SpineModule.startup()` (a new optional platform
hook, run by the API process after migrations) calls `bootstrapAdmin`:

- both variables set **and** zero users → create the admin and log `bootstrap admin created`
  with the email. The password is never logged (and `*.password` is redacted anyway);
- any user exists → no-op. Changing the variables later can't create a second admin;
- "check empty, then insert" runs under `pg_advisory_xact_lock`, so replicas racing at
  startup create exactly one admin (`auth-users.test.ts › creates the admin only when no users exist, once, even when racing`);
- the password must pass the policy; in production, values that look like placeholders
  (`change-me`, `example`, `insecure`, `dev-only`) are refused at config load.

For demos and tests, `createAuthModule(...).seedUsers([...])` idempotently creates users
such as `analyst@spine.test` / `viewer@spine.test` (`INSERT … ON CONFLICT (email) DO NOTHING`).

### Consequences

- 👍 Works with Docker Compose and Kubernetes secrets out of the box.
- 👍 No default account; a forgotten variable is harmless once users exist.
- 👎 The initial password sits in the environment. Operators should remove it after the
  first start and change the password (documented in `.env.example`).

## Pros and cons of the options

### CLI command

- 👍 No secret in the environment.
- 👎 Needs shell access to a running container, awkward in managed platforms. Still a good addition later.

### Setup page

- 👎 Whoever reaches the page first owns the system.

## What would make us revisit this

- SSO/OIDC (the IdP provides the first admin).
- A need to bootstrap without any secret in the environment → add the CLI.

## Further reading

- The Twelve-Factor App, III "Config"
- OWASP ASVS 4.0 V2.3 (authenticator lifecycle: no default credentials)
