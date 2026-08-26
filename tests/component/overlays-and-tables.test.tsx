import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Pagination,
  ToastProvider,
  useToast,
  type Column,
} from '@uxe/ui';

interface EvidenceRow {
  id: string;
  requirement: string;
  result: string;
  document: string;
  page: number;
}

const ROWS: EvidenceRow[] = [
  {
    id: 'r1',
    requirement: '6.4.2 Emergency illumination',
    result: 'Non-compliant',
    document: 'UAE Fire Code',
    page: 214,
  },
  {
    id: 'r2',
    requirement: '6.6.1 Travel distance',
    result: 'Compliant',
    document: 'UAE Fire Code',
    page: 220,
  },
];

const COLUMNS: Array<Column<EvidenceRow>> = [
  { key: 'requirement', header: 'Requirement', render: (r) => r.requirement, primary: true },
  { key: 'result', header: 'Result', render: (r) => r.result },
  { key: 'document', header: 'Document', render: (r) => `${r.document} p. ${r.page}` },
];

describe('DataTable', () => {
  it('renders a caption, headers and one row per record', () => {
    render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} caption="Evidence matrix" />,
    );
    const table = screen.getByRole('table', { name: 'Evidence matrix' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Requirement', 'Result', 'Document']);
    // Header row plus two data rows.
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('6.4.2 Emergency illumination')).toBeInTheDocument();
    expect(within(table).getByText('UAE Fire Code p. 214')).toBeInTheDocument();
  });

  it('shows the empty state instead of an empty grid', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        caption="Evidence matrix"
        empty={<p>No evidence yet</p>}
      />,
    );
    expect(screen.getByText('No evidence yet')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Emergency illumination/ })).not.toBeInTheDocument();
  });

  it('announces loading rather than rendering a misleading empty table', () => {
    render(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r) => r.id}
        caption="Evidence matrix"
        empty={<p>No evidence yet</p>}
        loading
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading Evidence matrix');
    // "No evidence yet" while the request is still running would be a lie.
    expect(screen.queryByText('No evidence yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('opens the row that was activated', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        caption="Evidence matrix"
        onRowClick={onRowClick}
      />,
    );
    const table = screen.getByRole('table', { name: 'Evidence matrix' });
    await userEvent.click(within(table).getByText('6.6.1 Travel distance'));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
  });

  it('gives every clickable row a keyboard-reachable, named control', async () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        caption="Evidence matrix"
        onRowClick={onRowClick}
      />,
    );
    const table = screen.getByRole('table', { name: 'Evidence matrix' });
    const activator = within(table).getByRole('button', { name: '6.4.2 Emergency illumination' });
    activator.focus();
    expect(activator).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('does not add a control when rows are not clickable', () => {
    render(
      <DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} caption="Evidence matrix" />,
    );
    const table = screen.getByRole('table', { name: 'Evidence matrix' });
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
  });

  it('selects one row and all rows', async () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        caption="Evidence matrix"
        selection={{
          selected: new Set(['r1']),
          onToggle,
          onToggleAll,
          rowLabel: (row) => row.requirement,
          renderCheckbox: (checked, onChange, label) => (
            <Checkbox checked={checked} onCheckedChange={onChange} ariaLabel={label} />
          ),
        }}
      />,
    );

    const table = screen.getByRole('table', { name: 'Evidence matrix' });
    const boxes = within(table).getAllByRole('checkbox');
    expect(boxes).toHaveLength(ROWS.length + 1);

    await userEvent.click(within(table).getByRole('checkbox', { name: 'Select all rows' }));
    expect(onToggleAll).toHaveBeenCalled();

    await userEvent.click(
      within(table).getByRole('checkbox', { name: 'Select 6.6.1 Travel distance' }),
    );
    expect(onToggle).toHaveBeenCalledWith('r2');
  });
});

describe('Pagination', () => {
  it('reports the visible window and disables the ends', () => {
    render(<Pagination page={1} totalPages={5} total={92} pageSize={20} onPageChange={() => {}} />);
    expect(screen.getByText(/Showing 1–20 of 92/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled();
  });

  it('moves to the requested page', async () => {
    const onPageChange = vi.fn();
    render(
      <Pagination page={2} totalPages={5} total={92} pageSize={20} onPageChange={onPageChange} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('renders nothing at all when there is nothing to page through', () => {
    const { container } = render(
      <Pagination page={1} totalPages={0} total={0} pageSize={20} onPageChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Dialog', () => {
  it('is a labelled modal that traps focus', async () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Promote to knowledge"
        description="This makes the document citable."
      >
        <button type="button">Inside</button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Promote to knowledge' });
    expect(dialog).toHaveAccessibleDescription('This makes the document citable.');
    // Focus is inside the dialog, not left behind on the page underneath.
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null);
  });

  it('closes on Escape and on the close button', async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Promote to knowledge">
        <p>body</p>
      </Dialog>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onOpenChange={() => {}} title="Promote to knowledge">
        <p>body</p>
      </Dialog>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('confirms a reversible action directly', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Archive source"
        description="It can be restored later."
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('will not delete until the confirmation word is typed exactly', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Delete source"
        description="This permanently removes the document and its citations."
        destructive
        confirmWord="DELETE"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();

    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'DELET');
    expect(confirm).toBeDisabled();

    await userEvent.type(input, 'E');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels without acting', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete source"
        description="Permanent."
        onConfirm={onConfirm}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('Toasts', () => {
  function Trigger({ tone = 'success' as const }: { tone?: 'success' | 'error' }) {
    const { push } = useToast();
    return (
      <Button
        onClick={() => push({ title: 'Report ready', description: 'Download started.', tone })}
      >
        Generate
      </Button>
    );
  }

  it('announces a result in a live region and can be dismissed', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('Report ready');
    expect(toast).toHaveTextContent('Download started.');

    await userEvent.click(within(toast).getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('Report ready')).not.toBeInTheDocument();
  });

  it('does not swallow a click meant for the control underneath it', async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const toast = await screen.findByRole('status');

    // The toast lands over the bottom-right of the screen, which is where a dialog puts
    // its primary action. Its own controls stay clickable; the card does not.
    expect(toast.className).toContain('pointer-events-none');
    expect(within(toast).getByRole('button', { name: /dismiss/i }).className).toContain(
      'pointer-events-auto',
    );
  });

  it('raises a failure as an assertive alert, and does not auto-hide it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <ToastProvider>
          <Trigger tone="error" />
        </ToastProvider>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Report ready');

      // An error the user has not read must not disappear on a timer.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
