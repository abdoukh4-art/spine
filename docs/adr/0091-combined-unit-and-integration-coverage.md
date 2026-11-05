# ADR-0091: Measure API coverage over unit + integration tests, and enforce it

- **Status:** accepted (refines [ADR-0021](0021-testing-strategy.md))
- **Date:** 2026-10-29
- **Deciders:** maintainers
- **Tags:** testing, ci

## Context and problem statement

ADR-0021 put coverage gates on the pure packages and the API's domain folders, and wrote
"≥ 70 % for the whole API, CI fails below the threshold". The Phase 3 audit found two problems:

1. **The whole-API gate didn't exist.** No threshold was configured for `apps/api`, and neither
   was the domain-folder gate. The packages had their gates; the API had none.
2. **The only API number we had was misleading.** Unit-only coverage was **60 %** lines, because
   Postgres repositories, BullMQ, HTTP routes and several application services (alerts 7 %,
   playbooks 31 %, auth 54 %) are tested _on purpose_ by the integration suite against real
   infrastructure (ADR-0021: "mocks of Postgres lie"). The integration suite was never
   instrumented, so the code it tests looked untested.

Which number should the project report and enforce for the API?

## Decision drivers

- One honest number per package that matches how the code is actually tested.
- Gates that really fail CI (proven by a mutation check), not gates that only exist in prose.
- Don't push people to write mock-heavy unit tests for adapters just to raise a metric.

## Considered options

1. **Combined run:** one Vitest invocation of both projects (`unit` + `integration`) with v8
   coverage, so the report is naturally merged.
2. Two runs plus a merge step (`nyc merge` / lcov merging).
3. Unit-only gate, and raise it with mocked adapter unit tests.
4. Keep reporting unit-only and explain the gap in prose.

## Decision outcome

**Option 1.** `pnpm --filter @spine/api test:coverage:all` runs both projects in one process
tree, and v8 coverage is merged by Vitest itself. CI's `test-integration` job runs it (it already
has Postgres and Redis), prints the totals in the job summary and uploads the HTML report as an
artifact. Gates:

| Scope                                         | Run                                | Lines | Branches | Statements |
| --------------------------------------------- | ---------------------------------- | ----- | -------- | ---------- |
| `src/modules/*/domain/**` (also functions 85) | every coverage run (vitest config) | 85    | 85       | 85         |
| whole API                                     | `test:coverage:all` (script flags) | 90    | 80       | 90         |

Measured on 2026-10-29: **95.6 % lines, 86.8 % branches, 94.1 % statements** (535 tests).
The gates sit a few points below that on purpose: they're there to catch regressions, not to
make people chase a number.

Option 2 adds tooling for no benefit, because Vitest already merges within a run. Option 3
would produce tests that assert our mocks behave like Postgres, which is exactly what ADR-0021
rejects. Option 4 is what we had, and it hid the missing gates.

### Consequences

- 👍 The reported API number reflects real, infrastructure-backed tests.
- 👍 Each gate was mutation-checked: raising the domain branch gate to 99 % fails the run
  (`Coverage for branches (92.91%) does not meet "src/modules/*/domain/**" threshold`).
- 👎 The `test-integration` CI job takes longer, because unit tests run again under instrumentation.
- ⚖️ Combined coverage can't tell _which_ suite covers a line. Domain code keeps its own
  unit-only gate so it can't hide behind integration tests.

## What would make us revisit this

- The combined job gets slow enough to hurt PR feedback → shard it, or run combined coverage only on `develop`.
- Integration tests start covering domain logic that should be unit-tested → add per-suite reports (option 2).

## Further reading

- Vitest docs, _Coverage_ (`coverage.thresholds` with glob patterns)
- Google Testing Blog, _Code Coverage Best Practices_ (2020)
