import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { AttentionItem, AuditEvent, SessionResponse } from '@uxe/contracts';
import { ROLE_PERMISSIONS, type Role } from '@uxe/contracts';
import { ToastProvider, TooltipProvider } from '@uxe/ui';
import { ActivityPage } from '../../apps/web/src/routes/ActivityPage.js';
import { I18nProvider } from '../../apps/web/src/lib/i18n.js';
import { SessionProvider } from '../../apps/web/src/lib/session.js';

const ITEM: AttentionItem = {
  id: '01JQ8Z9CT2K5V6W7X8Y9Z0ABCD',
  kind: 'critical_gap',
  title: 'Marina Tower Evacuation Plan',
  detail: '2 critical gaps',
  severity: 'critical',
  href: '/consult/con-1',
};

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

const CONSULTATION = {
  id: 'con-1',
  title: 'UAE Fire Code Review',
  status: 'report_ready',
  taskMode: 'check_compliance',
  documentCount: 2,
  sourceCount: 1,
  complianceScore: 74,
  pinned: false,
  ownerId: 'usr-1',
  ownerName: 'Dr Sadi Vural',
  lastMessageAt: '2026-08-30T09:00:00.000Z',
  updatedAt: '2026-08-30T09:00:00.000Z',
  createdAt: '2026-08-01T09:00:00.000Z',
};

const AUDIT_EVENT: AuditEvent = {
  id: '01JQ8Z9CT2K5V6W7X8Y9Z0AUDT',
  at: '2026-08-30T09:15:00.000Z',
  actorId: 'usr-1',
  actorName: 'Dr Sadi Vural',
  actorType: 'user',
  action: 'consultation.deleted',
  category: 'deletion',
  targetType: 'consultation',
  targetId: '01JQ8Z9CT2K5V6W7X8Y9Z0CONS',
  targetLabel: 'Marina Tower Evacuation Plan',
  result: 'success',
  ipAddress: '203.0.113.42',
  userAgent: 'Mozilla/5.0 (Macintosh)',
  traceId: '9f2c1b7e-4a55-4d0e-8f1a-2b6c9d0e3f41',
  summary: 'Archived consultation "Marina Tower Evacuation Plan".',
  before: null,
  after: null,
};

function renderActivity(
  role: Role,
  items: AttentionItem[] = [],
  route = '/activity',
  auditEvents: AuditEvent[] = [],
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (url.includes('/auth/session')) return json(sessionFor(role));
    if (url.includes('/dashboard/attention')) {
      return json({ items, total: items.length, truncated: false });
    }
    if (url.includes('/audit-events')) {
      return json({
        items: auditEvents,
        total: auditEvents.length,
        page: 1,
        pageSize: 25,
        totalPages: 1,
      });
    }
    if (url.includes('/consultations')) {
      return json({ items: [CONSULTATION], total: 1, page: 1, pageSize: 20, totalPages: 1 });
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
              <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
            </SessionProvider>
          </ToastProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );

  return { fetchMock, ...render(<ActivityPage />, { wrapper: Providers }) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * This is where the bell lands, for every role. That makes two things load-bearing: what
 * is outstanding has to be the first thing on the page, and the audit log — which most
 * roles may not read — must not turn the page into an error for them.
 */
describe('the page the bell opens', () => {
  it('leads with what needs attention', async () => {
    renderActivity('owner', [ITEM]);
    const attention = await screen.findByText('Needs attention');
    expect(attention).toBeInTheDocument();
    expect(await screen.findByText('Marina Tower Evacuation Plan')).toBeInTheDocument();
    expect(await screen.findByText('2 critical gaps')).toBeInTheDocument();
  });

  it('says so plainly when there is nothing outstanding', async () => {
    renderActivity('owner', []);
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('offers the fix, and is honest that acknowledging is not fixing', async () => {
    const user = userEvent.setup();
    renderActivity('owner', [ITEM]);

    await user.click(await screen.findByRole('button', { name: /Marina Tower Evacuation Plan/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Mark as handled' })).toBeInTheDocument();
    // The wording a compliance product cannot get wrong: this changes the reminder, not
    // the finding.
    expect(within(dialog).getByText(/nothing here makes it compliant/i)).toBeInTheDocument();
  });

  /*
   * The row is a title and one line. The panel is where the rest of it lives: what kind of
   * thing this is, and how serious — neither of which the list had room to say.
   */
  it('opens an item in a side panel carrying more than the row showed', async () => {
    const user = userEvent.setup();
    renderActivity('owner', [ITEM]);

    await user.click(await screen.findByRole('button', { name: /Marina Tower Evacuation Plan/ }));

    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('A finding recorded as non-compliant')).toBeInTheDocument();
    expect(within(panel).getByText('Critical')).toBeInTheDocument();
    expect(within(panel).getByText('Severity')).toBeInTheDocument();
  });

  it('opens an audit row and shows the whole record, not the part that fitted', async () => {
    const user = userEvent.setup();
    renderActivity('owner', [], '/activity?tab=audit', [AUDIT_EVENT]);

    // The table renders a row and a card, one per breakpoint; either opens the same event.
    await user.click((await screen.findAllByText('consultation.deleted'))[0]!);

    const panel = await screen.findByRole('dialog');
    // The trace was a truncated tooltip on a button that did nothing else; it is readable
    // now, in full, beside where the request came from.
    expect(within(panel).getByText('9f2c1b7e-4a55-4d0e-8f1a-2b6c9d0e3f41')).toBeInTheDocument();
    expect(within(panel).getByText('203.0.113.42')).toBeInTheDocument();
    expect(within(panel).getByText('Marina Tower Evacuation Plan')).toBeInTheDocument();
    expect(within(panel).getByText('Succeeded')).toBeInTheDocument();
  });

  it('shows the audit log to a role that may read it', async () => {
    renderActivity('owner');
    expect(await screen.findByText('Audit log')).toBeInTheDocument();
  });

  it('shows a consultant their attentions without a log they may not read', async () => {
    const { fetchMock } = renderActivity('consultant', [ITEM]);

    expect(await screen.findByText('Marina Tower Evacuation Plan')).toBeInTheDocument();
    expect(screen.queryByText('Audit log')).not.toBeInTheDocument();

    // Not merely hidden: never requested. A 403 the page then has to explain away is not
    // the same as not asking for something you were not entitled to.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const askedForAudit = fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/audit-events'),
    );
    expect(askedForAudit).toBe(false);
  });
});

/*
 * Past consultations moved off the Consult rail and onto this page as a tab. That makes
 * the tab strip the only way back to a conversation, so what it offers and which tab it
 * opens on both matter.
 */
describe('the Activity tabs', () => {
  it('opens on what needs attention, which is what the bell promises', async () => {
    renderActivity('owner', [ITEM]);
    expect(await screen.findByRole('tab', { name: /Needs attention/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText('Marina Tower Evacuation Plan')).toBeInTheDocument();
  });

  it('carries past consultations, and opens straight onto them when linked that way', async () => {
    renderActivity('owner', [], '/activity?tab=consultations');
    expect(await screen.findByRole('tab', { name: 'Past consultations' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // DataTable renders a desktop row and a mobile card from the same data, so each cell
    // appears twice in the DOM; one of them is always hidden by CSS.
    expect((await screen.findAllByText('UAE Fire Code Review')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/2 document\(s\) reviewed/)).length).toBeGreaterThan(0);
  });

  it('gives a consultant their consultations without the audit tab', async () => {
    // The whole destination used to need audit:read. Past consultations living here would
    // have left a consultant with no way to reach their own conversations.
    renderActivity('consultant', [], '/activity?tab=consultations');
    expect((await screen.findAllByText('UAE Fire Code Review')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('tab', { name: 'Audit log' })).not.toBeInTheDocument();
  });

  it('falls back to the first tab rather than rendering nothing for a bad value', async () => {
    renderActivity('owner', [ITEM], '/activity?tab=nonsense');
    expect(await screen.findByRole('tab', { name: /Needs attention/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
