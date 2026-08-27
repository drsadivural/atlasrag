import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { SourceSummary } from '@uxe/contracts';
import { ToastProvider, TooltipProvider } from '@uxe/ui';
import { I18nProvider } from '../../apps/web/src/lib/i18n.js';
import {
  SourceStatusCell,
  UploadList,
  type UploadState,
} from '../../apps/web/src/routes/KnowledgePage.js';
import { SourceSelectorDialog } from '../../apps/web/src/routes/ConsultPage.js';

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const BASE_SOURCE: SourceSummary = {
  id: 'src-1',
  title: 'UAE Fire and Life Safety Code',
  documentType: 'pdf',
  status: 'ready',
  pages: 812,
  currentVersion: 'v3',
  currentVersionId: 'ver-3',
  accessScope: 'workspace',
  accessLabel: 'Workspace',
  tags: ['fire'],
  ownerName: 'Ayumi',
  sizeBytes: 4_500_000,
  lastSyncedAt: null,
  updatedAt: '2026-08-20T10:00:00.000Z',
  createdAt: '2026-08-01T10:00:00.000Z',
  connectorKind: null,
  failureReason: null,
  processingPercent: null,
  isPromotedUpload: false,
  effectiveDate: '2024-01-01T00:00:00.000Z',
  version: 1,
};

describe('UploadList', () => {
  const uploads: UploadState[] = [
    {
      id: 'u1',
      fileName: 'evacuation-plan.pdf',
      sizeBytes: 2_400_000,
      uploadedBytes: 1_008_000,
      percent: 42,
      status: 'uploading',
      message: null,
    },
    {
      id: 'u2',
      fileName: 'lighting.xlsx',
      sizeBytes: 180_000,
      uploadedBytes: 180_000,
      percent: 100,
      status: 'processing',
      message: null,
    },
    {
      id: 'u3',
      fileName: 'fire-code.pdf',
      sizeBytes: 9_100_000,
      uploadedBytes: 9_100_000,
      percent: 100,
      status: 'duplicate',
      message: 'Already in this workspace as UAE Fire and Life Safety Code v3.',
    },
    {
      id: 'u4',
      fileName: 'corrupt.pdf',
      sizeBytes: 12_000,
      uploadedBytes: 12_000,
      percent: 0,
      status: 'failed',
      message: 'The file could not be opened as a PDF. Re-export it and try again.',
    },
  ];

  it('counts the bytes up while they are moving, and stops when they stop', () => {
    render(<UploadList uploads={uploads} onDismiss={() => {}} />);

    // A file's own size never changes, so printing it alone beside a moving bar reads as
    // a number that is stuck — which is exactly how a 136MB upload looked.
    expect(screen.getByText('984 KB of 2.3 MB · 42%')).toBeInTheDocument();

    // Once the bytes have arrived there is nothing left to count.
    expect(screen.getByText('176 KB')).toBeInTheDocument();
  });

  it('shows measurable progress while a file is uploading', () => {
    render(<UploadList uploads={uploads} onDismiss={() => {}} />, { wrapper: Providers });
    const bar = screen.getByRole('progressbar', { name: 'Uploading evacuation-plan.pdf' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
  });

  it('distinguishes uploading from indexing', () => {
    render(<UploadList uploads={uploads} onDismiss={() => {}} />, { wrapper: Providers });
    expect(screen.getByText('Uploaded. Indexing in progress.')).toBeInTheDocument();
    // Only the in-flight upload has a progress bar; a finished one must not imply movement.
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  });

  it('explains a duplicate rather than silently discarding the file', () => {
    render(<UploadList uploads={uploads} onDismiss={() => {}} />, { wrapper: Providers });
    expect(
      screen.getByText(/Already in this workspace as UAE Fire and Life Safety Code v3/),
    ).toBeInTheDocument();
  });

  it('gives a failed upload an actionable reason', () => {
    render(<UploadList uploads={uploads} onDismiss={() => {}} />, { wrapper: Providers });
    expect(
      screen.getByText(/could not be opened as a PDF\. Re-export it and try again\./),
    ).toBeInTheDocument();
  });

  it('announces changes politely and lets each entry be dismissed', async () => {
    const onDismiss = vi.fn();
    const { container } = render(<UploadList uploads={uploads} onDismiss={onDismiss} />, {
      wrapper: Providers,
    });
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss corrupt.pdf' }));
    expect(onDismiss).toHaveBeenCalledWith('u4');
  });
});

describe('SourceStatusCell', () => {
  const props = { onRetry: vi.fn(), retrying: false, canRetry: true };

  it('shows a ready source as ready', () => {
    render(<SourceStatusCell source={BASE_SOURCE} {...props} />, { wrapper: Providers });
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('shows processing while indexing is still running', () => {
    render(<SourceStatusCell source={{ ...BASE_SOURCE, status: 'indexing' }} {...props} />, {
      wrapper: Providers,
    });
    expect(screen.getByText('Processing')).toBeInTheDocument();
  });

  it('shows the failure reason and offers a retry', async () => {
    const onRetry = vi.fn();
    render(
      <SourceStatusCell
        source={{ ...BASE_SOURCE, status: 'failed', failureReason: 'Password-protected PDF.' }}
        onRetry={onRetry}
        retrying={false}
        canRetry
      />,
      { wrapper: Providers },
    );
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Password-protected PDF.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('hides the retry from a user without permission, rather than failing on click', () => {
    render(
      <SourceStatusCell
        source={{ ...BASE_SOURCE, status: 'failed', failureReason: 'Password-protected PDF.' }}
        onRetry={vi.fn()}
        retrying={false}
        canRetry={false}
      />,
      { wrapper: Providers },
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('marks a quarantined source distinctly from a failed one, with no retry', () => {
    render(
      <SourceStatusCell
        source={{
          ...BASE_SOURCE,
          status: 'quarantined',
          failureReason: 'Instruction-like content detected.',
        }}
        onRetry={vi.fn()}
        retrying={false}
        canRetry
      />,
      { wrapper: Providers },
    );
    expect(screen.getByText('Quarantined')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('flags a source that needs review before it can be cited', () => {
    render(<SourceStatusCell source={{ ...BASE_SOURCE, status: 'needs_review' }} {...props} />, {
      wrapper: Providers,
    });
    expect(screen.getByText('Needs review')).toBeInTheDocument();
  });
});

describe('SourceSelectorDialog', () => {
  const consultation = {
    id: 'con-1',
    version: 4,
    sources: [
      {
        sourceId: 'src-1',
        sourceVersionId: 'ver-3',
        title: 'UAE Fire and Life Safety Code',
        documentType: 'pdf' as const,
        version: 'v3',
        role: 'governing' as const,
        pages: 812,
        effectiveDate: '2024-01-01T00:00:00.000Z',
        status: 'ready' as const,
      },
    ],
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/sources')) {
        return new Response(
          JSON.stringify({
            items: [
              BASE_SOURCE,
              {
                ...BASE_SOURCE,
                id: 'src-2',
                title: 'NFPA 101 Life Safety Code',
                currentVersion: 'v2',
                pages: 540,
              },
            ],
            page: 1,
            pageSize: 100,
            total: 2,
            totalPages: 1,
            counts: { all: 2, ready: 2, processing: 0, needs_review: 0, failed: 0, archived: 0 },
            pipeline: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({ id: 'con-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderDialog(onOpenChange = vi.fn()) {
    render(
      <SourceSelectorDialog
        open
        onOpenChange={onOpenChange}
        consultation={consultation as never}
      />,
      { wrapper: Providers },
    );
    return onOpenChange;
  }

  it('only offers sources that are ready to be cited', async () => {
    renderDialog();
    await screen.findByRole('checkbox', { name: 'Select UAE Fire and Life Safety Code' });
    expect(fetchMock.mock.calls[0]![0]).toContain('status=ready');
  });

  it('pre-selects the sources already attached to the consultation', async () => {
    renderDialog();
    expect(
      await screen.findByRole('checkbox', { name: 'Select UAE Fire and Life Safety Code' }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Select NFPA 101 Life Safety Code' }),
    ).not.toBeChecked();
  });

  it('keeps a running count of what will be saved', async () => {
    renderDialog();
    await screen.findByRole('checkbox', { name: 'Select NFPA 101 Life Safety Code' });
    expect(screen.getByRole('button', { name: /Save \(1\)/ })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select NFPA 101 Life Safety Code' }),
    );
    expect(screen.getByRole('button', { name: /Save \(2\)/ })).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select UAE Fire and Life Safety Code' }),
    );
    expect(screen.getByRole('button', { name: /Save \(1\)/ })).toBeInTheDocument();
  });

  it('shows the pinned version and access scope for each source', async () => {
    renderDialog();
    await screen.findByRole('checkbox', { name: 'Select UAE Fire and Life Safety Code' });
    expect(screen.getByText(/v3 · 812 pages · effective 2024 · Workspace/)).toBeInTheDocument();
  });

  it('sends the selection and the consultation version, so a concurrent edit cannot be lost', async () => {
    const onOpenChange = renderDialog();
    await screen.findByRole('checkbox', { name: 'Select NFPA 101 Life Safety Code' });
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select NFPA 101 Life Safety Code' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Save \(2\)/ }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(String((patch![1] as RequestInit).body));
      expect(new Set(body.sourceIds)).toEqual(new Set(['src-1', 'src-2']));
      expect(body.version).toBe(4);
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('surfaces a save failure instead of closing as if it worked', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'conflict',
              message: 'This consultation changed since you opened it.',
              traceId: 't1',
            },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          items: [BASE_SOURCE],
          page: 1,
          pageSize: 100,
          total: 1,
          totalPages: 1,
          counts: { all: 1, ready: 1, processing: 0, needs_review: 0, failed: 0, archived: 0 },
          pipeline: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const onOpenChange = renderDialog();
    await screen.findByRole('checkbox', { name: 'Select UAE Fire and Life Safety Code' });
    await userEvent.click(screen.getByRole('button', { name: /Save \(1\)/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not update sources');
    expect(alert).toHaveTextContent('This consultation changed since you opened it.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('tells the user where to go when there is nothing to select', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            items: [],
            page: 1,
            pageSize: 100,
            total: 0,
            totalPages: 0,
            counts: { all: 0, ready: 0, processing: 0, needs_review: 0, failed: 0, archived: 0 },
            pipeline: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    renderDialog();
    expect(await screen.findByText('No ready sources')).toBeInTheDocument();
    expect(screen.getByText(/Upload and index a source in the Knowledge Base/)).toBeInTheDocument();
  });

  it('passes the search term to the server rather than filtering a partial page locally', async () => {
    renderDialog();
    await screen.findByRole('checkbox', { name: 'Select UAE Fire and Life Safety Code' });
    await userEvent.type(screen.getByRole('textbox'), 'egress');
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('q=egress'))).toBe(true);
    });
  });
});
