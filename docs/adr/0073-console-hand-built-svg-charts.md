# ADR-0073: Hand-built, accessible inline-SVG bar charts instead of a chart library

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** console workstream
- **Tags:** frontend

## Context and problem statement

The metrics page shows alert volume by severity and by day. These are two single-series bar
charts. Chart libraries are the usual answer, but they are large and their accessibility
varies: many render a `<canvas>` (invisible to screen readers) or unlabelled SVG.

## Decision drivers

- WCAG 2.2 AA: a text alternative for the chart and the exact numbers available without sight.
- No new runtime dependency without an ADR (ADR-0023), small bundle.
- Readable in both themes.

## Considered options

1. **A ~150-line `BarChart` component: inline SVG with `role="img"`, a `<title>`, a `<desc>`
   summary, per-bar `<title>` tooltips, and a real data table in a `<details>` disclosure.**
2. Recharts.
3. Chart.js (canvas).
4. No chart: tables only.

## Decision outcome

**Chosen option 1.** The SVG is named by the chart title (`aria-labelledby`) and described by
an automatically generated summary ("8 bars, total 38. Highest: 28 Oct with 11.") via
`aria-describedby`. Each bar has a `<title>` and a hit area taller than the bar. One series
means one colour (`--accent`), so colour carries no meaning; axis labels do. Value labels are
shown on every bar up to 12 bars, otherwise only on the peak, and x-labels are thinned to ≤ 10
so they never collide. "Show data table" reveals a semantic `<table>` with the same numbers.

### Consequences

- 👍 Zero dependencies, fully accessible, styled by tokens in both themes.
- 👎 Only what we need: no stacked bars, lines or zoom. Adding a second chart type costs code.

## Pros and cons of the options

### Recharts

- 👍 Many chart types, animations.
- 👎 ~100 kB gzip with D3 modules; accessibility needs extra work anyway.

### Chart.js

- 👎 Canvas: no DOM for assistive technology; we'd still need the table.

### Tables only

- 👍 Simplest and fully accessible.
- 👎 Trends over 30 days are much harder to see.

## What would make us revisit this

- We need more than two chart types, or interactive exploration (zoom, brushing): adopt a
  library and keep the data-table alternative.

## Further reading

- W3C WAI, _Complex Images_ tutorial
- Sarah Higley, _Accessible SVG charts_ patterns
