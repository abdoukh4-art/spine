# ADR-0023: Console with React 19 + Vite + TanStack Query + React Router, hand-built accessible components, no UI kit

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** maintainers
- **Tags:** frontend

## Context and problem statement

Analysts live in the console for 8-hour shifts. It must be fast, keyboard-friendly,
readable in light and dark themes, and meet **WCAG 2.2 AA**. The mission specifies
React 19 + Vite + TanStack Query + React Router, with no heavy UI kit unless an ADR
justifies one.

## Decision drivers

- Accessibility (AA contrast, focus management, semantic HTML, screen-reader labels).
- Small bundle and few dependencies (supply chain).
- Learnability: components readable without knowing a kit's API.

## Considered options

1. **Hand-built component set (≈ 15 components) with CSS custom properties (design tokens) and CSS Modules**
2. MUI / Ant Design
3. Radix primitives + Tailwind (shadcn/ui-style)
4. Headless UI kit (React Aria)

## Decision outcome

**Chosen option 1.**

- Design tokens (`src/styles/tokens.css`) for colour, spacing and typography, with
  light/dark themes via `prefers-color-scheme` plus a manual toggle. Every severity colour pair is checked for ≥ 4.5:1 contrast.
- Components: `Button`, `Badge` (severity/status, never colour-only: text + icon),
  `Table` (semantic `<table>`, sortable headers with `aria-sort`), `Dialog` (native
  `<dialog>` + focus return), `Tabs` (roving tabindex), `Field`, `Select`, `Toast` (`aria-live`),
  `Timeline`, `EmptyState`, `Spinner`, `Pagination`, `ScoreBar`, `KeyValue`.
- Server state lives in TanStack Query (cache, retries, polling for live queues). There's
  no global client store: URL search params hold filter state, so views are shareable.
- Auth: the access token sits in a React context (memory), and refresh happens through the cookie ([ADR-0016](0016-authentication-jwt-refresh-rotation.md)).
- An API client is generated from the same Zod schemas (`@spine/shared-schema`), and
  responses are parsed in development to catch contract drift early.
- Accessibility is tested with `axe-core` in Playwright on every page.

### Consequences

- 👍 Tiny bundle, full control over a11y, nothing magic.
- 👎 We build components ourselves. Kept small, and complex widgets (comboboxes, date
  pickers) are avoided in favour of native inputs.

## Pros and cons of the options

### MUI / Ant

- 👍 Rich and fast to build with.
- 👎 Large bundles, a theme system to learn, and a heavy look that's hard to make our own.

### Radix + Tailwind

- 👍 Accessible primitives.
- 👎 Many dependencies, and Tailwind adds a build concept. A reasonable alternative if the
  component count grows past ~30.

### React Aria

- 👍 Best-in-class accessibility.
- 👎 Large API surface for a learner.

## What would make us revisit this

- We need complex widgets (virtualized grids, comboboxes) → adopt React Aria for those only.

## Further reading

- W3C WAI-ARIA Authoring Practices Guide (APG)
- WCAG 2.2 quick reference
- TanStack Query docs, _Important Defaults_
