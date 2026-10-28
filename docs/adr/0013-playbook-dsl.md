# ADR-0013: Playbook DSL — declarative YAML/JSON DAG with structured, non-eval conditions

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** architecture, security

## Context and problem statement

Playbooks encode a SOC's response knowledge: "if the sender domain is malicious and the
user clicked, quarantine the mailbox after a lead approves". They must be readable by
analysts, versioned, reviewable in PRs, validated **before** they ever run, and they
must never become a code-execution vector.

## Decision drivers

- Safety: no arbitrary code execution (OWASP A03 Injection).
- Validation at load time: unknown step types, dangling references and cycles are rejected.
- Readability for non-developers, and diffability in Git.
- Support for: enrich, score, branch, notify, create ticket, block indicator, approval gate,
  plus per-step timeout, retry and compensation.

## Considered options

1. **Declarative YAML (or JSON) document validated by a Zod schema; graph edges via `next`; conditions as structured JSON predicates**
2. Playbooks as TypeScript code (a plugin per playbook)
3. YAML with embedded JavaScript expressions (`when: "alert.score > 80"`) evaluated with `vm`
4. A visual low-code builder storing an opaque graph JSON

## Decision outcome

**Chosen option 1.** Example:

```yaml
apiVersion: spine/v1
kind: Playbook
metadata: { id: malware-containment, name: Malware containment, version: 3 }
trigger:
  event: alert.scored
  when: { all: [ { field: alert.category, op: eq, value: malware }, { field: score.value, op: gte, value: 60 } ] }
start: enrich
steps:
  - id: enrich
    type: enrich
    next: decide
  - id: decide
    type: branch
    branches:
      - when: { field: score.value, op: gte, value: 85 }
        next: approve-block
    default: notify
  - id: approve-block
    type: approval
    with: { approverRole: analyst, prompt: "Block {{alert.indicators}} on the perimeter firewall?", timeoutMs: 3600000, onTimeout: reject }
    next: block
    onReject: notify
  - id: block
    type: block_indicator
    with: { indicatorTypes: [ipv4, domain], durationMinutes: 1440 }
    timeoutMs: 10000
    retry: { maxAttempts: 3, backoffMs: 500 }
    compensate: { type: unblock_indicator }
    next: ticket
  - id: ticket
    type: create_ticket
    with: { queue: SOC, priority: high }
    next: notify
  - id: notify
    type: notify
    with: { channel: "#soc-alerts", template: "Alert {{alert.title}} handled by {{run.playbookId}}" }
```

- **Conditions** form a tiny, closed predicate language: `{all:[…]}`, `{any:[…]}`, `{not:…}`
  and `{field, op, value}` with `op ∈ eq|neq|gt|gte|lt|lte|in|contains|exists|matches`.
  `field` is a dotted path into a read-only context `{alert, score, enrichment, steps, run}`.
  `matches` uses a length-capped regex compiled at load time; patterns that fail a
  safe-regex check are rejected (ReDoS defence).
- **Templates** (`{{path}}`) are plain path lookups with **no expressions or helpers**, and
  are rendered as text (escaped by each adapter).
- **Load-time validation**: Zod schema → unique step IDs → every `next`/`onReject`/branch
  target exists → `start` exists → graph is acyclic (DFS with colours) → every step is
  reachable from `start` → step `with` parameters are validated against each step type's schema.
- **DAG semantics in v0.1**: the execution path is a single token moving through the DAG
  (branching chooses one successor). Parallel fan-out/join is deliberately deferred; see
  "revisit" below.
- Playbooks are **versioned**: `(id, version)` is immutable once stored, and runs pin the version they started with.

### Consequences

- 👍 There is no `eval`, `Function` or `vm`, so the attack surface is the predicate interpreter, which is about 100 lines and property-tested.
- 👍 Diffable, reviewable and lintable. The console can render the graph from the same JSON.
- 👎 Less expressive than code. Complex logic needs a new step type (an engineering change),
  which is intentional: response logic that complex deserves code review.
- 👎 No parallel steps in v0.1, so enrichment of many indicators happens inside one step.

## Pros and cons of the options

### Playbooks as code
- 👍 Unlimited power and type safety.
- 👎 Every change needs a deploy, analysts can't author them, and they're impossible to validate generically.

### Embedded JS expressions
- 👍 Familiar syntax.
- 👎 `vm` is explicitly **not a security boundary** (per the Node docs). It's a sandbox-escape risk,
  and expressions can hang (`while(true)`).

### Visual builder
- 👍 Friendly UX.
- 👎 Opaque JSON, poor diffs. It can be added *on top of* this DSL later.

## What would make us revisit this

- Real playbooks need parallel branches (e.g. notify + ticket concurrently with a join) →
  add `parallel` step type with explicit `join`.
- Users need computed values (arithmetic) → add a vetted expression language such as CEL with a superseding ADR.

## Further reading

- Node.js docs, *vm: "The vm module is not a security mechanism"*
- Google, *Common Expression Language (CEL)* spec
- OWASP, *Regular expression Denial of Service (ReDoS)*
