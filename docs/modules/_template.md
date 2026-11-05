# Module: <name>

## Purpose

<One paragraph: which problem in the SOC workflow this module solves.>

## Design

<Key types, how data flows through the module, which ports and adapters it has. Link ADRs.>

```mermaid
<a small diagram>
```

## Public API

<What other modules may use (public-api.ts) and the HTTP endpoints it serves.>

## Invariants

<Things that are always true, e.g. "an open alert's fingerprint is unique". Name the test that proves each one.>

## Failure modes

| Failure | Behaviour | How it's tested |
| ------- | --------- | --------------- |

## How to extend it

<Step-by-step for the most common extension.>

## How to learn this module

1. Read …, then …
2. Run `pnpm --filter … test -- <file>` and watch …

### Exercises

1. …
2. …
3. …

Solutions: `docs/modules/exercises/<name>-solutions.md` (try first!)
