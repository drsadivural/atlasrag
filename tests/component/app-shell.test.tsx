import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { SessionResponse } from '@uxe/contracts';
import { ROLE_PERMISSIONS, type Role } from '@uxe/contracts';
import { ToastProvider, TooltipProvider } from '@uxe/ui';
import { AppShell } from '../../apps/web/src/components/AppShell.js';
import { I18nProvider } from '../../apps/web/src/lib/i18n.js';
import { SessionProvider } from '../../apps/web/src/lib/session.js';
import { ThemeProvider } from '../../apps/web/src/lib/theme.js';

function sessionFor(role: Role): SessionResponse {
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
    workspace: {
      id: 'ws-1',
      organizationId: 'org-1',
      name: 'Marina Tower',
      slug: 'marina-tower',
      role,
      isDefault: true,
      locale: 'en',
    },
    workspaces: [
      {
        id: 'ws-1',
        organizationId: 'org-1',
        name: 'Marina Tower',
        slug: 'marina-tower',
        role,
        isDefault: true,
        locale: 'en',
      },
      {
        id: 'ws-2',
        organizationId: 'org-1',
        name: 'Downtown Mall',
        slug: 'downtown-mall',
        role,
        isDefault: false,
        locale: 'en',
      },
    ],
    permissions: [...ROLE_PERMISSIONS[role]],
    csrfToken: 'csrf-token',
    expiresAt: '2026-09-01T00:00:00.000Z',
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function renderShell(
  role: Role = 'consultant',
  route = '/dashboard',
  attention: unknown = { items: [], total: 0, truncated: false },
) {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/auth/session')) {
      return new Response(JSON.stringify(sessionFor(role)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(input).includes('/dashboard/attention')) {
      return new Response(JSON.stringify(attention), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en">
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <SessionProvider>
                <MemoryRouter initialEntries={[route]}>
                  <AppShell>
                    <h1>Dashboard</h1>
                  </AppShell>
                </MemoryRouter>
              </SessionProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('navigation', () => {
  it('renders every destination a consultant may reach, and none they may not', async () => {
    renderShell('consultant');
    const sidebar = await screen.findByRole('navigation', { name: 'Main navigation' });

    for (const label of ['Dashboard', 'Consult now', 'Reports', 'Activity']) {
      expect(within(sidebar).getByRole('link', { name: label })).toBeInTheDocument();
    }
    /*
     * Two things this asserts, both deliberate.
     *
     * The knowledge base is not a destination any more — it is a Settings tab, because
     * publishing documents is setup rather than daily work.
     *
     * Activity is a destination for a consultant even though they hold no audit
     * permission: it carries their past consultations and what needs their attention, and
     * the audit tab inside it checks separately.
     */
    expect(within(sidebar).queryByRole('link', { name: 'Knowledge base' })).not.toBeInTheDocument();
  });

  it('gives an owner the administrative destinations as well', async () => {
    renderShell('owner');
    const sidebar = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(sidebar).getByRole('link', { name: 'Users' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('link', { name: 'Activity' })).toBeInTheDocument();
    expect(within(sidebar).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('offers a read-only member exactly what their permissions allow', async () => {
    renderShell('read_only');
    const sidebar = await screen.findByRole('navigation', { name: 'Main navigation' });
    // read_only carries source:read, artifact:read, member:read and settings:read.
    for (const label of ['Dashboard', 'Consult now', 'Reports', 'Activity', 'Users', 'Settings']) {
      expect(within(sidebar).getByRole('link', { name: label })).toBeInTheDocument();
    }
    // Reaching Activity is not reading the audit log; that tab is gated inside the page.
    expect(within(sidebar).queryByRole('link', { name: 'Knowledge base' })).not.toBeInTheDocument();
  });

  it('marks the current destination for assistive technology, not with colour alone', async () => {
    renderShell('consultant', '/reports');
    const sidebar = await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(within(sidebar).getByRole('link', { name: 'Reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(sidebar).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('offers a skip link to the main region as the first tab stop', async () => {
    renderShell();
    await screen.findByRole('navigation', { name: 'Main navigation' });
    const skip = screen.getByRole('link', { name: /skip to (main )?content/i });
    expect(skip).toHaveAttribute('href', '#main');

    await userEvent.tab();
    expect(skip).toHaveFocus();
  });

  it('keeps the four primary destinations plus More in the mobile bar', async () => {
    renderShell('owner');
    const mobile = await screen.findByRole('navigation', { name: 'Primary navigation' });
    const links = within(mobile).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Dashboard',
      'Consult now',
      'Reports',
      'Activity',
    ]);
    expect(within(mobile).getByRole('button', { name: /more/i })).toBeInTheDocument();
  });

  it('puts the remaining destinations behind More rather than dropping them', async () => {
    renderShell('owner');
    const mobile = await screen.findByRole('navigation', { name: 'Primary navigation' });
    await userEvent.click(within(mobile).getByRole('button', { name: /more/i }));

    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    // Activity is a primary destination now, so what remains behind More is administration.
    expect(items).toContain('Users');
    expect(items).toContain('Settings');
  });
});

describe('the tablet drawer', () => {
  it('opens from the menu button, is a labelled modal, and closes on Escape', async () => {
    renderShell();
    await screen.findByRole('navigation', { name: 'Main navigation' });

    await userEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));
    const drawer = await screen.findByRole('dialog', { name: 'Main navigation' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).not.toBeInTheDocument();
  });

  it('closes when the scrim is used', async () => {
    renderShell();
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await userEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));
    await screen.findByRole('dialog', { name: 'Main navigation' });

    await userEvent.click(screen.getAllByRole('button', { name: /close navigation menu/i })[0]!);
    expect(screen.queryByRole('dialog', { name: 'Main navigation' })).not.toBeInTheDocument();
  });
});

describe('workspace and account', () => {
  it('names the signed-in user by their given name and honorific', async () => {
    renderShell();
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.getAllByText(/Dr Sadi/).length).toBeGreaterThan(0);
  });

  it('shows the active workspace and offers the others', async () => {
    renderShell();
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.getAllByText('Marina Tower').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: /Marina Tower/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Downtown Mall/ })).toBeInTheDocument();
  });

  it('switches workspace through the server, so the new tenant scope is authoritative', async () => {
    renderShell();
    // The endpoint answers with a full session for the new workspace, which is what the
    // client stores; a stub that returned less would not exercise that.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const session = sessionFor('consultant');
      const body = String(input).includes('/auth/switch-workspace')
        ? { ...session, workspace: session.workspaces[1]! }
        : session;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await userEvent.click(screen.getByRole('button', { name: /Marina Tower/ }));
    const menu = await screen.findByRole('menu');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Downtown Mall/ }));

    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/auth/switch-workspace'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ workspaceId: 'ws-2' });
  });

  it('renders nothing at all until the session is known, rather than an empty chrome', () => {
    const { container } = renderShell();
    expect(container.textContent).not.toContain('Dashboard');
  });
});

/*
 * The bell is the only notification surface in the product, and it sits on every screen.
 * That places two requirements on it that nothing else here has: the number it shows must
 * be the number of things actually waiting, and it must never be able to take the page
 * down with it.
 */
describe('the notification bell', () => {
  const item = (id: string) => ({
    id,
    kind: 'failed_job' as const,
    title: 'source ingest failed',
    detail: 'The job could not be completed.',
    severity: 'critical' as const,
    href: '/activity',
  });

  it('carries no badge when nothing needs attention', async () => {
    renderShell('owner');
    const bell = await screen.findByRole('link', {
      name: 'Notifications — nothing needs attention',
    });
    expect(bell).toHaveAttribute('href', '/activity');
    expect(bell).toHaveTextContent('');
  });

  it('shows how many things are waiting, and says so out loud', async () => {
    renderShell('owner', '/dashboard', {
      items: [item('a'), item('b'), item('c')],
      total: 3,
      truncated: false,
    });
    const bell = await screen.findByRole('link', { name: 'Notifications — 3 need attention' });
    expect(bell).toHaveTextContent('3');
  });

  it('caps the badge but not the meaning', async () => {
    renderShell('owner', '/dashboard', {
      items: Array.from({ length: 14 }, (_, i) => item(`i${i}`)),
      total: 14,
      truncated: false,
    });
    // The digit is abbreviated to keep the badge round; the label is not.
    const bell = await screen.findByRole('link', { name: 'Notifications — 14 need attention' });
    expect(bell).toHaveTextContent('9+');
  });

  it('stays standing when the response is not the shape it expects', async () => {
    // It renders on every screen, so a bad payload must cost the badge, not the app.
    renderShell('owner', '/dashboard', { unexpected: true });
    expect(
      await screen.findByRole('link', { name: 'Notifications — nothing needs attention' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });
});
