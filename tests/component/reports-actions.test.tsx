import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { ArtifactSummary, SessionResponse } from '@uxe/contracts';
import { ROLE_PERMISSIONS, type Role } from '@uxe/contracts';
import { ToastProvider, TooltipProvider } from '@uxe/ui';
import { ReportsPage } from '../../apps/web/src/routes/ReportsPage.js';
import { I18nProvider } from '../../apps/web/src/lib/i18n.js';
import { SessionProvider } from '../../apps/web/src/lib/session.js';

const REPORT = {
  id: '01JQ8Z9CT2K5V6W7X8Y9Z0RPT1',
  title: 'Marina Tower — compliance report',
  kind: 'compliance_report',
  documentType: 'pdf',
  sizeBytes: 284_113,
  status: 'ready',
  consultationId: '01JQ8Z9CT2K5V6W7X8Y9Z0CONS',
  consultationTitle: 'Marina Tower Evacuation Plan',
  disclosures: [],
  createdAt: '2026-08-30T09:00:00.000Z',
} as unknown as ArtifactSummary;

function sessionFor(role: Role): SessionResponse {
  const workspace = {
    id: 'ws-1',
    organizationId: 'org-1',
    name: 'Marina Tower',
    slug: 'marina-tower',
    role,
    isDefault: true,
    locale: 'en',
  };
  return {
    user: {
      id: 'usr-1',
      email: 'ayumi@uxe.example',
      fullName: 'Dr Sadi Vural',
      avatarUrl: null,
      title: 'Principal consultant',
      locale: 'en',
      theme: 'system',
      emailVerified: true,
      mfaEnabled: true,
      isPlatformAdmin: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    workspace,
    workspaces: [workspace],
    permissions: [...ROLE_PERMISSIONS[role]],
    csrfToken: 'csrf-token',
    expiresAt: '2026-12-31T00:00:00.000Z',
  } as SessionResponse;
}

function renderReports(role: Role, rows: ArtifactSummary[] = [REPORT]) {
  const deletes: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/auth/session')) return json(sessionFor(role));
    if (url.includes('/artifacts')) {
      if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
        deletes.push(url);
        return json({ ok: true });
      }
      return json({ items: rows, total: rows.length, page: 1, pageSize: 20, totalPages: 1 });
    }
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const Providers = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ToastProvider>
            <SessionProvider>
              <MemoryRouter initialEntries={['/reports']}>{children}</MemoryRouter>
            </SessionProvider>
          </ToastProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );

  return { deletes, ...render(<ReportsPage />, { wrapper: Providers }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * Removing a report used to sit two clicks inside a menu whose trigger was a download
 * arrow, in a column that disappeared on a phone. These cover the two things that has to
 * mean: the control is a button on the row, and it cannot go off on a single stray click.
 */
describe('removing a report', () => {
  /* The table lays out a row and a card, one per breakpoint, so each control is in the DOM
   * twice with only one of them visible. Either is the same button. */
  const removeButtons = () =>
    screen.findAllByRole('button', { name: /Remove: Marina Tower — compliance report/ });

  it('puts the control on the row rather than behind a menu', async () => {
    renderReports('owner');
    expect((await removeButtons())[0]).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /Download: Marina Tower — compliance report/ })[0],
    ).toBeInTheDocument();
  });

  it('asks before it removes, and says what removing does', async () => {
    const user = userEvent.setup();
    const { deletes } = renderReports('owner');

    await user.click((await removeButtons())[0]!);

    const confirm = await screen.findByRole('dialog');
    // A compliance report is not deleted, it is archived — and the wording has to match
    // what the server actually does with it.
    expect(within(confirm).getByText(/Moves .* to the archive/)).toBeInTheDocument();
    expect(deletes).toHaveLength(0);

    await user.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain(REPORT.id);
  });

  it('says why the control is unavailable to a role that may not use it', async () => {
    renderReports('member');
    const remove = (await removeButtons())[0]!;
    expect(remove).toBeDisabled();
    // A disabled button cannot be focused and takes no pointer events, so the reason has to
    // reach the accessible name or nobody ever reads it.
    expect(remove).toHaveAccessibleName(/Your role cannot remove reports/);
  });
});
