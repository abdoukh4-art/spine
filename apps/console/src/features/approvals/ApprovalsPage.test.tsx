import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeId, ID_KIND } from '../../fake/ids';
import { expectNoAxeViolations } from '../../test/axe';
import { currentLocation, renderApp, TEST_NOW } from '../../test/render';
import { expiryLabel } from './ApprovalsPage';

const A1 = fakeId(ID_KIND.approval, 1); // pending, expires in 42 min (C2 alert)
const A2 = fakeId(ID_KIND.approval, 2); // pending, expires in 3 min (Mimikatz alert)

async function openInbox(as: 'viewer' | 'analyst' | 'admin' = 'analyst') {
  const app = renderApp('/approvals', as);
  const list = await screen.findByRole('list', { name: 'Pending approvals' });
  return { ...app, list };
}

const cards = () =>
  within(screen.getByRole('list', { name: 'Pending approvals' })).getAllByRole('listitem');

describe('approval inbox', () => {
  it('lists pending approvals soonest-expiring first with a countdown; passes axe', async () => {
    const { container, list } = await openInbox();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Expires in 3m (soon)');
    expect(items[1]).toHaveTextContent('Expires in 42m');
    expect(items[1]).toHaveTextContent('Block 185.220.101.47 on the perimeter firewall for 24 h?');
    expect(within(items[1]!).getByRole('link', { name: 'View alert' })).toHaveAttribute(
      'href',
      `/alerts/${fakeId(ID_KIND.alert, 1)}`,
    );
    await expectNoAxeViolations(container);
  });

  it('approves with a comment: optimistic removal, then the run resumes', async () => {
    const { user, server } = await openInbox();
    await user.click(within(cards()[1]!).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this action?' });
    await user.type(within(dialog).getByRole('textbox', { name: /Comment/ }), 'Confirmed C2');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(await screen.findByText('Approved. The run continues.')).toBeInTheDocument();
    const approval = server.db.approvals.find((a) => a.id === A1)!;
    expect(approval).toMatchObject({ status: 'approved', comment: 'Confirmed C2' });
    expect(server.db.runs[0]?.run.status).toBe('running');
  });

  it('rejects without a comment', async () => {
    const { user, server } = await openInbox();
    await user.click(within(cards()[0]!).getByRole('button', { name: 'Reject' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    expect(
      await screen.findByText('Rejected. The run takes its rejection path.'),
    ).toBeInTheDocument();
    expect(server.db.approvals.find((a) => a.id === A2)).toMatchObject({
      status: 'rejected',
      comment: null,
    });
  });

  it('rolls back the optimistic update on 409 and explains why', async () => {
    const { user, server } = await openInbox();
    server.failNext(
      'POST',
      `/approvals/${A1}/decision`,
      409,
      'conflict',
      'Approval already decided',
    );
    // Make the follow-up refetch fail too, so the card can only come back via the rollback.
    server.failNext('GET', '/approvals', 503, 'overloaded', 'Service unavailable');
    await user.click(within(cards()[1]!).getByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    expect(await screen.findByText(/already decided or has expired/)).toBeInTheDocument();
    expect(
      await screen.findByText('Could not refresh; showing the last data received'),
    ).toBeInTheDocument();
    expect(cards()).toHaveLength(2);
    expect(server.db.approvals.find((a) => a.id === A1)?.status).toBe('pending');
  });

  it('cancelling the dialog changes nothing and Escape closes it', async () => {
    const { user, server } = await openInbox();
    await user.click(within(cards()[1]!).getByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const approve = within(cards()[1]!).getByRole('button', { name: 'Approve' });
    await user.click(approve);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(approve).toHaveFocus();
    expect(server.count(`POST /approvals/${A1}/decision`)).toBe(0);
  });

  it('viewers see approvals but cannot decide', async () => {
    await openInbox('viewer');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('switches status tabs with the keyboard and keeps the tab in the URL', async () => {
    const { user } = await openInbox();
    const pending = screen.getByRole('tab', { name: 'Pending' });
    expect(pending).toHaveAttribute('aria-selected', 'true');
    pending.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Approved' })).toHaveFocus();
    expect(await screen.findByRole('list', { name: 'Approved approvals' })).toHaveTextContent(
      'Confirmed ransomware',
    );
    expect(currentLocation()).toBe('/approvals?status=approved');
    await user.keyboard('{End}');
    expect(await screen.findByText('No expired approvals.')).toBeInTheDocument();
  });
});

describe('expiryLabel', () => {
  it('counts down and flags the last five minutes', () => {
    expect(expiryLabel(new Date(TEST_NOW + 3_600_000).toISOString(), TEST_NOW)).toEqual({
      text: 'Expires in 1h',
      urgent: false,
    });
    expect(expiryLabel(new Date(TEST_NOW + 90_000).toISOString(), TEST_NOW)).toEqual({
      text: 'Expires in 1m 30s',
      urgent: true,
    });
    expect(expiryLabel(new Date(TEST_NOW - 1).toISOString(), TEST_NOW)).toEqual({
      text: 'Expired',
      urgent: true,
    });
  });
});
