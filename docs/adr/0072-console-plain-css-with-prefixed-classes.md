# ADR-0072: Console styling with one plain-CSS file, `sp-` prefixed classes and design tokens

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** console workstream
- **Tags:** frontend

## Context and problem statement

ADR-0023 chose hand-built components and mentioned "CSS custom properties (design tokens) and
CSS Modules". When building the ~20 components we had to settle how styles are written and
scoped. The console is small (one app, one team), learners read it, and tests run in jsdom.

## Decision drivers

- Readable by a newcomer without build-tool knowledge.
- Light and dark themes from the same tokens (`tokens.css`), including a manual override.
- Nothing that makes tests depend on generated class names.

## Considered options

1. **One global `components.css`, every class prefixed `sp-`, colours only from tokens.**
2. CSS Modules per component.
3. CSS-in-JS (styled-components, Emotion).
4. Tailwind.

## Decision outcome

**Chosen option 1.** `src/styles/tokens.css` defines the tokens and the themes
(`prefers-color-scheme`, overridden by `data-theme="light|dark"` on `<html>`);
`src/styles/components.css` holds every component style, grouped by component with comments.
Classes use a BEM-like `sp-block__element--modifier` form. Colours never appear as literals
outside `tokens.css`. The theme toggle stores `light`/`dark` in `localStorage` (it holds no
secret) and the stored theme is applied before the first render to avoid a flash.

### Consequences

- 👍 One file to read to understand the look; class names are stable and greppable.
- 👍 Tokens checked for contrast in both themes; real-browser axe runs (the screenshot script)
  report no contrast violations.
- 👎 No automatic scoping: a careless class name could collide. The `sp-` prefix and review
  keep this manageable at ~600 lines; past ~1 500 lines, switch to CSS Modules.
- ⚖️ Deviates from ADR-0023's mention of CSS Modules; the tokens approach is unchanged.

## Pros and cons of the options

### CSS Modules

- 👍 Scoped by construction.
- 👎 One file per component, generated names in the DOM, and jsdom tests see proxy objects; more ceremony than this app needs today.

### CSS-in-JS

- 👎 Runtime cost and a new dependency.

### Tailwind

- 👎 A new build concept and dependency; markup becomes harder to read for learners.

## What would make us revisit this

- The stylesheet passes ~1 500 lines, or a second team works on the console.

## Further reading

- BEM methodology, <https://getbem.com>
- WCAG 2.2, 1.4.3 Contrast (Minimum) and 1.4.11 Non-text Contrast
