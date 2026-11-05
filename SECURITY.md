# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository ("Security" tab → "Report a vulnerability").

Please include the affected version/commit, steps to reproduce, and the impact you
observed. We aim to acknowledge within 5 working days and to agree a disclosure timeline with you.

## Scope

In scope: the API, worker, console, playbook engine, enrichers, and the provided
Docker/nginx configuration.

Out of scope: the **simulated** response adapters and mock enrichment providers
behaving "insecurely" by design (they have no real effect), and findings that require
an already-compromised host.

## Supported versions

Only the latest release on `main` receives security fixes while the project is in 0.x.

## Design

See [docs/security](docs/security/README.md) for the threat model, RBAC matrix and OWASP mapping.
