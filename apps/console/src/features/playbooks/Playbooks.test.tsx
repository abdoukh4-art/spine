import { PlaybookDefinitionSchema } from '@spine/shared-schema';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createFakeDb, fixtureDefinition } from '../../fake/fixtures';
import { expectNoAxeViolations } from '../../test/axe';
import { renderApp, TEST_NOW } from '../../test/render';
import { conditionText, PlaybookFlow } from './PlaybookFlow';

describe('playbooks list', () => {
  it('shows enabled state as text to non-admins; passes axe', async () => {
    const { container } = renderApp('/playbooks', 'analyst');
    const row = (await screen.findByRole('link', { name: 'Brute-force response' })).closest('tr')!;
    expect(within(row).getByText('Disabled')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('lets admins toggle a playbook with an accessible switch', async () => {
    const { user, server, container } = renderApp('/playbooks', 'admin');
    const toggle = await screen.findByRole('switch', { name: 'Brute-force response enabled' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(await screen.findByText('Brute-force response enabled.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Brute-force response enabled' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(server.db.playbooks.find((p) => p.id === 'brute-force-response')?.enabled).toBe(true);
    await expectNoAxeViolations(container);
  });
});

describe('playbook detail', () => {
  it('renders the flow with branch and approval outcomes, the YAML source and passes axe', async () => {
    const { user, container } = renderApp('/playbooks/contain-c2-beacon');
    const flow = await screen.findByRole('list', {
      name: /Steps of Contain C2 beacon, starting at enrich/,
    });
    expect(within(flow).getByText('If score.score ≥ 70 →')).toBeInTheDocument();
    expect(within(flow).getByText('Otherwise →')).toBeInTheDocument();
    expect(within(flow).getByText('If approved →')).toBeInTheDocument();
    expect(
      within(flow).getByText(/If rejected \(or expired with onTimeout: reject\)/),
    ).toBeInTheDocument();
    // notify-soc is reachable twice; the second path refers back to it.
    expect(within(flow).getByRole('link', { name: 'notify-soc' })).toHaveAttribute(
      'href',
      '#step-notify-soc',
    );
    expect(
      screen.getByText(/On alert.scored when alert.category = "command_and_control"/),
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole('tab', { name: 'YAML source' }));
    expect(screen.getByLabelText('Playbook source')).toHaveTextContent('apiVersion: spine/v1');
  });

  it('validates pasted YAML and lists errors with their paths', async () => {
    const { user } = renderApp('/playbooks/phishing-triage');
    await user.click(await screen.findByRole('tab', { name: 'Validate' }));
    const source = screen.getByRole('textbox', { name: 'Playbook source' });
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText('Valid playbook')).toBeInTheDocument();

    await user.clear(source);
    await user.type(source, 'kind: Playbook\nstart: nowhere\n');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    const errors = await screen.findByRole('alert');
    expect(errors).toHaveTextContent('Playbook is invalid: 4 problems');
    expect(errors).toHaveTextContent('apiVersion: Required');
    expect(errors).toHaveTextContent('start: start step "nowhere" is not defined in steps');
  });

  it('validates JSON with the real schema', async () => {
    const { user } = renderApp('/playbooks/phishing-triage');
    await user.click(await screen.findByRole('tab', { name: 'Validate' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Format' }), 'json');
    const source = screen.getByRole('textbox', { name: 'Playbook source' });
    await user.clear(source);
    await user.click(source);
    await user.paste('{"apiVersion":"spine/v1","kind":"Playbook"}');
    await user.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('metadata');
  });

  it('tells viewers that validation needs the analyst role', async () => {
    const { user } = renderApp('/playbooks/phishing-triage', 'viewer');
    await user.click(await screen.findByRole('tab', { name: 'Validate' }));
    expect(screen.getByText('Validating playbooks needs the analyst role.')).toBeInTheDocument();
  });

  it('shows an error for an unknown playbook', async () => {
    renderApp('/playbooks/nope');
    expect(await screen.findByRole('alert')).toHaveTextContent('Playbook not found');
  });
});

describe('PlaybookFlow', () => {
  it('renders a linear playbook ending in "End of run"', () => {
    const db = createFakeDb(TEST_NOW);
    render(<PlaybookFlow definition={fixtureDefinition(db, 'brute-force-response')} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(screen.getByText('continues on failure')).toBeInTheDocument();
    expect(screen.getByText('End of run')).toBeInTheDocument();
  });

  it('describes conditions in words', () => {
    expect(
      conditionText({
        all: [{ field: 'a', op: 'eq', value: 1 }, { not: { field: 'b', op: 'exists' } }],
      }),
    ).toBe('all of (a = 1; not (b exists))');
    expect(conditionText({ any: [{ field: 'c', op: 'in', value: ['x', 'y'] }] })).toBe(
      'any of (c is one of ["x","y"])',
    );
  });

  it('every fixture playbook is valid against the shared schema', () => {
    const db = createFakeDb(TEST_NOW);
    for (const p of db.playbooks)
      expect(PlaybookDefinitionSchema.safeParse(p.definition).success, p.id).toBe(true);
  });
});
