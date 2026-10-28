import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import {
  Badge,
  BarChart,
  Button,
  Callout,
  CheckboxGroup,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  KeyValue,
  LoadMore,
  QueryView,
  ScoreBar,
  Select,
  SeverityBadge,
  SortableHeader,
  Spinner,
  StatusBadge,
  Table,
  Tabs,
  Textarea,
  TextInput,
  Timeline,
  ToastProvider,
  cx,
  nextTabIndex,
  roundedTopBar,
  useToast,
} from '.';

describe('Button and IconButton', () => {
  it('defaults to type=button, shows busy state, and IconButton has a name', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <>
        <Button onClick={onClick}>Save</Button>
        <Button busy variant="primary">
          Saving
        </Button>
        <IconButton label="Close panel" icon="✕" />
      </>,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('type', 'button');
    await userEvent.click(save);
    expect(onClick).toHaveBeenCalledOnce();
    const busy = screen.getByRole('button', { name: 'Saving' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveAttribute(
      'title',
      'Close panel',
    );
    await expectNoAxeViolations(container);
  });

  it('cx joins truthy class names', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });
});

describe('badges', () => {
  it('always carry text, never colour alone', async () => {
    const { container } = render(
      <p>
        <SeverityBadge severity="critical" /> <SeverityBadge severity="informational" />{' '}
        <SeverityBadge severity={null} /> <StatusBadge status="in_progress" />{' '}
        <StatusBadge status="something_new" /> <Badge tone="info">Info</Badge>
      </p>,
    );
    expect(screen.getByText('Critical')).toHaveClass('sp-badge--sev-critical');
    expect(screen.getByText('Informational')).toBeInTheDocument();
    expect(screen.getByText('Unscored')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toHaveClass('sp-badge--progress');
    expect(screen.getByText('Something new')).toHaveClass('sp-badge--neutral');
    await expectNoAxeViolations(container);
  });
});

describe('Table and SortableHeader', () => {
  it('sets aria-sort only on the sorted column and toggles direction', async () => {
    const onSort = vi.fn();
    const { container, rerender } = render(
      <Table caption="People">
        <thead>
          <tr>
            <SortableHeader label="Name" direction="desc" onSort={onSort} />
            <SortableHeader label="Age" direction={null} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Ada</td>
            <td>36</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: /Age/ })).not.toHaveAttribute('aria-sort');
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(onSort).toHaveBeenLastCalledWith('asc');
    await userEvent.click(screen.getByRole('button', { name: /Age/ }));
    expect(onSort).toHaveBeenLastCalledWith('desc');
    await expectNoAxeViolations(container);
    rerender(
      <Table caption="People" captionHidden>
        <thead>
          <tr>
            <SortableHeader label="Name" direction="asc" onSort={onSort} />
          </tr>
        </thead>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByText('People')).toHaveClass('visually-hidden');
  });
});

function DialogHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <main id="main" tabIndex={-1}>
      <Button onClick={() => setOpen(true)}>Open</Button>
      <Dialog
        open={open}
        title="Confirm"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}
      >
        <TextInput label="Reason" />
      </Dialog>
    </main>
  );
}

describe('Dialog', () => {
  it('opens modally, is named by its title, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(<DialogHarness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog).toHaveAttribute('open');
    expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  });

  it('closes from the close button and from the parent', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'a', label: 'Alpha', content: <p>Panel A</p> },
    { id: 'b', label: 'Beta', content: <p>Panel B</p> },
    { id: 'c', label: 'Gamma', content: <p>Panel C</p> },
  ];

  it('uses roving tabindex and arrow/Home/End keys', async () => {
    const user = userEvent.setup();
    const { container } = render(<Tabs label="Greek" tabs={tabs} />);
    const [alpha, beta, gamma] = screen.getAllByRole('tab');
    expect(alpha).toHaveAttribute('tabindex', '0');
    expect(beta).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Alpha' })).toHaveTextContent('Panel A');
    await user.tab();
    expect(alpha).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(beta).toHaveFocus();
    expect(beta).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel B');
    await user.keyboard('{End}');
    expect(gamma).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(alpha).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(gamma).toHaveFocus();
    await user.keyboard('{Home}');
    expect(alpha).toHaveFocus();
    await user.keyboard('x');
    expect(alpha).toHaveFocus();
    await user.click(gamma!);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel C');
    await expectNoAxeViolations(container);
  });

  it('computes the next index with wrap-around', () => {
    expect(nextTabIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextTabIndex('Enter', 0, 3)).toBeNull();
  });
});

describe('form fields', () => {
  it('associate labels, hints and errors (aria-describedby, aria-invalid)', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <form aria-label="Example">
        <TextInput label="Email" hint="Work address" error="Required" />
        <Select label="Role" options={[{ value: 'a', label: 'A' }]} />
        <Textarea label="Notes" labelHidden />
        <CheckboxGroup
          legend="Colours"
          options={[
            { value: 'red', label: 'Red' },
            { value: 'blue', label: 'Blue' },
          ]}
          value={['blue']}
          onChange={onChange}
        />
      </form>,
    );
    const email = screen.getByRole('textbox', { name: 'Email' });
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Work address Required');
    expect(screen.getByRole('combobox', { name: 'Role' })).not.toHaveAttribute('aria-invalid');
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Red' }));
    expect(onChange).toHaveBeenLastCalledWith(['red', 'blue']);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Blue' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole('group', { name: 'Colours' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

function ToastButton() {
  const toast = useToast();
  return <Button onClick={() => toast.show('Saved!', 'success', 50)}>Notify</Button>;
}

describe('Toast', () => {
  it('announces in a polite live region and auto-dismisses', async () => {
    const { container } = render(
      <ToastProvider>
        <ToastButton />
      </ToastProvider>,
    );
    const region = screen.getByRole('status', { name: 'Notifications' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    await userEvent.click(screen.getByRole('button', { name: 'Notify' }));
    expect(within(region).getByText('Saved!')).toBeInTheDocument();
    await expectNoAxeViolations(container);
    await waitFor(() => expect(within(region).queryByText('Saved!')).not.toBeInTheDocument());
  });

  it('can be dismissed and prefixes errors', async () => {
    function ErrorButton() {
      const toast = useToast();
      return <Button onClick={() => toast.show('Nope', 'error')}>Fail</Button>;
    }
    render(
      <ToastProvider>
        <ErrorButton />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fail' }));
    expect(screen.getByText('Error: Nope')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Error: Nope')).not.toBeInTheDocument();
  });

  it('throws outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<ToastButton />)).toThrow(/ToastProvider/);
  });
});

describe('display components', () => {
  it('Spinner, EmptyState, ErrorState, Callout, KeyValue, LoadMore, Timeline are accessible', async () => {
    const retry = vi.fn();
    const more = vi.fn();
    const { container } = render(
      <>
        <Spinner label="Loading alerts" />
        <EmptyState title="Nothing">
          <p>Try again later.</p>
        </EmptyState>
        <ErrorState message="Boom" onRetry={retry} />
        <Callout tone="warning" title="Heads up">
          <p>Careful.</p>
        </Callout>
        <KeyValue
          items={[
            { label: 'Owner', value: 'Ada' },
            { label: 'Empty', value: '' },
          ]}
        />
        <LoadMore hasMore loading={false} onLoadMore={more} shown={1} />
        <LoadMore hasMore={false} loading={false} onLoadMore={more} shown={3} />
        <Timeline
          label="Events"
          items={[
            { id: '1', at: '2026-10-28T12:00:00.000Z', atLabel: 'noon', title: 'Started' },
            {
              id: '2',
              at: '2026-10-28T12:01:00.000Z',
              atLabel: 'later',
              title: 'Failed',
              description: 'oops',
              tone: 'danger',
            },
          ]}
        />
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading alerts…');
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getByRole('complementary', { name: 'Heads up' })).toBeInTheDocument();
    expect(screen.getByText('Owner').nextSibling).toHaveTextContent('Ada');
    expect(screen.getByText('Empty').nextSibling).toHaveTextContent('—');
    expect(screen.getByText('Showing 1 item')).toBeInTheDocument();
    expect(screen.getByText('Showing 3 items (all loaded)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(more).toHaveBeenCalled();
    const timeline = screen.getByRole('list', { name: 'Events' });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2);
    expect(within(timeline).getByText('later').closest('time')).toHaveAttribute(
      'dateTime',
      '2026-10-28T12:01:00.000Z',
    );
    await expectNoAxeViolations(container);
  });

  it('ScoreBar exposes meter semantics and visible text', async () => {
    const { container } = render(
      <>
        <ScoreBar score={72} label="Alert score" />
        <ScoreBar score={140} label="Clamped" />
        <ScoreBar score={null} />
      </>,
    );
    const meter = screen.getByRole('meter', { name: 'Alert score' });
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(meter).toHaveAttribute('aria-valuetext', '72 out of 100');
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Clamped' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('BarChart is an image with a summary, per-bar titles, and a data table', async () => {
    const data = Array.from({ length: 30 }, (_, i) => ({ label: `D${String(i)}`, value: i % 7 }));
    const { container } = render(<BarChart title="Per day" data={data} valueName="Alerts" />);
    const img = screen.getByRole('img', { name: 'Per day' });
    expect(img).toHaveAccessibleDescription('30 bars, total 85. Highest: D6 with 6.');
    expect(container.querySelectorAll('.sp-chart__label')).toHaveLength(10);
    expect(container.querySelectorAll('.sp-chart__value')).toHaveLength(1);
    expect(within(screen.getByRole('table', { name: 'Per day' })).getAllByRole('row')).toHaveLength(
      31,
    );
    await expectNoAxeViolations(container);
  });

  it('BarChart handles empty data and draws rounded bars', () => {
    render(<BarChart title="Nothing" data={[]} valueName="Alerts" />);
    expect(screen.getByRole('img', { name: 'Nothing' })).toHaveAccessibleDescription('No data.');
    expect(roundedTopBar(0, 10, 20, 50, 4)).toBe('M0,60 V14 Q0,10 4,10 H16 Q20,10 20,14 V60 Z');
  });
});

describe('QueryView', () => {
  const base = { refetch: vi.fn(() => Promise.resolve()) };
  it('renders loading, error, empty, stale and success states', () => {
    const child = (d: string[]) => <p>{d.join(',')}</p>;
    const { rerender } = render(
      <QueryView
        query={{ ...base, isPending: true, data: undefined, error: null }}
        loadingLabel="Loading things"
      >
        {child}
      </QueryView>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading things');
    rerender(
      <QueryView
        query={{ ...base, isPending: false, data: undefined, error: new Error('x') }}
        loadingLabel="L"
      >
        {child}
      </QueryView>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this data');
    rerender(
      <QueryView
        query={{ ...base, isPending: false, data: [], error: null }}
        loadingLabel="L"
        isEmpty={(d) => d.length === 0}
      >
        {child}
      </QueryView>,
    );
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    rerender(
      <QueryView
        query={{ ...base, isPending: false, data: ['a', 'b'], error: new Error('x') }}
        loadingLabel="L"
      >
        {child}
      </QueryView>,
    );
    expect(screen.getByText('a,b')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh');
  });
});
