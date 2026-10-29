import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Runs axe-core (WCAG 2.0/2.1/2.2 A and AA rules) on a container and fails the test with a
 * readable list of violations. `color-contrast` is disabled here because jsdom has no layout
 * or computed colours; contrast is checked on the tokens and in the real-browser screenshots.
 */
export async function expectNoAxeViolations(container: Element = document.body): Promise<void> {
  const results = await axe.run(container, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: {
      'color-contrast': { enabled: false },
      // Components are tested in isolation, outside the shell's landmarks.
      region: { enabled: false },
    },
  });
  const report = results.violations.map(
    (v) =>
      `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
  );
  expect(report, report.join('\n')).toEqual([]);
}
