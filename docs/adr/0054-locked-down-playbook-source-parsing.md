# ADR-0054: Locked-down YAML/JSON parsing for playbook sources

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** playbooks workstream
- **Tags:** security

## Context and problem statement

Admins publish playbooks as YAML or JSON through the API, and analysts can validate
arbitrary source. YAML parsers have a history of turning text into objects (tags), of
exponential expansion (aliases, "billion laughs") and of silently accepting duplicate keys.
The parser is therefore an attack surface (OWASP A03/A05) as well as a usability surface.

## Decision drivers

- No document may produce anything but plain maps, lists and scalars.
- Bounded CPU and memory for any input.
- Authors get every problem at once, located precisely.

## Considered options

1. **`yaml` package with the core schema, no custom tags, any explicit tag rejected, alias expansions capped at 50, duplicate keys rejected, 256 KiB size cap; then Zod; then graph checks; all errors returned as `{path, message}`.**
2. Accept JSON only.
3. `yaml` defaults (YAML 1.2 core schema, tags allowed, default alias limit 100).

## Decision outcome

**Chosen option 1.**

- Explicit tags are rejected even when the parser knows them: with the core schema, the
  `yaml` package still resolves `!!binary` into a Buffer (found by experiment while writing
  the tests). Playbooks never need a tag.
- `maxAliasCount: 50`; anchors stay usable for small reuse, bombs fail fast.
- Errors are reported with paths like `steps[3].next`, `trigger.when`, or
  `(source):<line>:<col>` for syntax errors. Graph validation collects every error
  (duplicates, dangling references, every cycle with its path, unreachable steps,
  condition depth > 16, unsafe regexes) instead of stopping at the first.
- Pathologically nested documents are reported as errors; a stack overflow inside the
  validator is caught and reported instead of crashing the request.

### Consequences

- 👍 Validation is a safe, cheap endpoint even for analysts.
- 👎 Some valid YAML (tags) is refused; the error message says why.

## Pros and cons of the options

### JSON only

- 👍 Smallest parser surface.
- 👎 Playbooks are meant to be authored and reviewed by people; YAML comments and
  multi-line strings matter for that.

### Library defaults

- 👍 Zero configuration.
- 👎 Tags produce non-JSON values; duplicate keys silently overwrite.

## What would make us revisit this

- A YAML library CVE → re-evaluate the parser; the size cap and tag ban limit the blast radius.

## Further reading

- OWASP, _Deserialization Cheat Sheet_
- Wikipedia, _Billion laughs attack_
