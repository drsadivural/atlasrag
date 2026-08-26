import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { GovernmentLoginPage } from '../../apps/web/src/routes/government/GovernmentLoginPage.js';
import { I18nProvider } from '../../apps/web/src/lib/i18n.js';
import { PreferencesProvider, usePreferences } from '../../apps/web/src/lib/preferences.js';
import { ThemeProvider } from '../../apps/web/src/lib/theme.js';
import { SessionProvider } from '../../apps/web/src/lib/session.js';

/**
 * The Government Edition sign-in screen.
 *
 * Everything asserted here is behaviour a person would notice: which method is offered
 * first, what happens when a provider is not configured, whether a typed password is
 * still there after collapsing the form, and whether Arabic actually turns the page
 * round rather than only translating it.
 */

const CONFIG = {
  uaePass: { available: true, environment: 'staging', requiredEnv: [] },
  sso: { available: true, requiredEnv: [] },
  dataResidency: false,
  allowedDomains: ['gov.ae'],
  links: {
    privacy: '/legal/privacy',
    security: '/legal/security',
    accessibility: '/legal/accessibility',
    support: '/support',
    status: '',
    incident: '',
    uaePassHelp: '',
    ssoHelp: '',
  },
};

function mockFetch(config: unknown = CONFIG) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/government/config')) {
      return new Response(JSON.stringify(config), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/auth/session')) {
      return new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), { status: 401 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

function LocaleProbe() {
  const { locale } = usePreferences();
  return <span data-testid="locale">{locale}</span>;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/login']}>
        <ThemeProvider>
          <PreferencesProvider>
            <SessionProvider>
              <I18nProvider locale="en">
                <GovernmentLoginPage />
                <LocaleProbe />
              </I18nProvider>
            </SessionProvider>
          </PreferencesProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no viewport, so `matchMedia` answers false to everything and the page would
  // render its small-screen shape. These cases are about the desktop layout the approved
  // references show, so the width query is answered as a desktop would answer it.
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('min-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  document.documentElement.removeAttribute('data-text-size');
  document.documentElement.removeAttribute('data-contrast');
  vi.stubGlobal('fetch', mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the sign-in screen', () => {
  it('leads with UAE PASS, and offers no way to create an account', async () => {
    renderPage();

    const uaePass = await screen.findByRole('button', { name: /sign in with uae pass/i });
    expect(uaePass).toBeInTheDocument();

    // Order matters: the national identity is the primary route, before the entity
    // directory and well before an address and a password.
    const buttons = screen.getAllByRole('button');
    const uaeIndex = buttons.indexOf(uaePass);
    const ssoIndex = buttons.findIndex((b) => /government sso/i.test(b.textContent ?? ''));
    expect(uaeIndex).toBeLessThan(ssoIndex);

    // Access is provisioned by an entity administrator, so there is no registration route
    // from this screen at all.
    expect(screen.queryByRole('link', { name: /create account|register|sign up/i })).toBeNull();
    expect(screen.getByText(/provisioned by your entity administrator/i)).toBeInTheDocument();
  });

  it('disables a provider this deployment has not configured, and says why', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        ...CONFIG,
        uaePass: { available: false, environment: 'staging', requiredEnv: [] },
      }),
    );
    renderPage();

    const uaePass = await screen.findByRole('button', { name: /sign in with uae pass/i });
    await waitFor(() => expect(uaePass).toBeDisabled());
    // A disabled button on its own tells nobody anything; the reason is on the page.
    expect(screen.getByText(/not configured for this deployment/i)).toBeInTheDocument();
  });

  it('validates the address before it reaches the network', async () => {
    renderPage();
    const user = userEvent.setup();

    await screen.findByLabelText('Government email');
    await user.type(screen.getByLabelText('Government email'), 'someone@gmail.com');
    await user.type(screen.getByLabelText(/^Password/), 'a-password');
    await user.click(screen.getByRole('button', { name: /sign in securely/i }));

    // The domain rule is deployment policy, so saying it is not an enumeration leak.
    expect(
      await screen.findByText(/government address issued by your entity/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Government email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('requires both fields, and marks the one that is missing', async () => {
    renderPage();
    const user = userEvent.setup();

    await screen.findByLabelText('Government email');
    await user.click(screen.getByRole('button', { name: /sign in securely/i }));

    expect(await screen.findByText(/enter your government email/i)).toBeInTheDocument();
    expect(screen.getByText(/enter your password/i)).toBeInTheDocument();
  });

  it('shows and hides the password, and announces which it is', async () => {
    renderPage();
    const user = userEvent.setup();

    const password = await screen.findByLabelText(/^Password/);
    expect(password).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: /show password/i }));
    expect(password).toHaveAttribute('type', 'text');
    expect(screen.getByText('Password is showing')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /hide password/i }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('keeps what was typed when the disclosure is collapsed and reopened', async () => {
    renderPage();
    const user = userEvent.setup();

    const email = await screen.findByLabelText('Government email');
    await user.type(email, 'someone@gov.ae');

    const toggle = screen.getByRole('button', { name: /other approved access/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);

    // Hidden rather than unmounted, so nothing typed is thrown away.
    expect(screen.getByLabelText('Government email')).toHaveValue('someone@gov.ae');
  });

  it('does not claim data residency unless the deployment asserts it', async () => {
    renderPage();
    expect(await screen.findByText(/encrypted session • monitored access$/i)).toBeInTheDocument();

    vi.stubGlobal('fetch', mockFetch({ ...CONFIG, dataResidency: true }));
    renderPage();
    expect(await screen.findAllByText(/uae data residency/i)).not.toHaveLength(0);
  });
});

describe('language', () => {
  it('turns the page round rather than only translating it', async () => {
    renderPage();
    const user = userEvent.setup();

    // jsdom applies no media queries, so both the desktop pair and the small-screen
    // toggle are in the tree; a real viewport shows exactly one of them.
    await user.click((await screen.findAllByRole('button', { name: 'العربية' }))[0]!);

    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(document.documentElement.lang).toBe('ar');
    expect(screen.getByTestId('locale')).toHaveTextContent('ar');
  });

  it('remembers the choice without storing anything about the person', async () => {
    renderPage();
    const user = userEvent.setup();

    await user.click((await screen.findAllByRole('button', { name: 'العربية' }))[0]!);
    await waitFor(() => expect(localStorage.getItem('uxe-preferences')).toContain('"ar"'));

    // Presentation only: nothing identifying is written alongside it.
    const stored = JSON.parse(localStorage.getItem('uxe-preferences') ?? '{}') as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored).sort()).toEqual(['contrast', 'locale', 'motion', 'textSize']);
  });
});

describe('the accessibility panel', () => {
  it('opens, traps Escape, and applies each preference to the document', async () => {
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /accessibility options/i }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Large' }));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-text-size')).toBe('large'),
    );

    await user.click(within(dialog).getByLabelText(/high contrast/i));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-contrast')).toBe('high'),
    );

    await user.click(within(dialog).getByLabelText(/reduce motion/i));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-motion')).toBe('reduced'),
    );

    await user.click(within(dialog).getByRole('button', { name: /reset accessibility/i }));
    await waitFor(() => expect(document.documentElement.getAttribute('data-contrast')).toBeNull());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('offers light, dark and system, and records the choice', async () => {
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /accessibility options/i }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));

    await user.click(within(dialog).getByRole('radio', { name: 'System' }));
    // System removes the pin entirely so a later OS change is still followed.
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBeNull());
  });
});

describe('the help panel', () => {
  it('lists only destinations this deployment has configured', async () => {
    renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /help and support/i }));
    const dialog = await screen.findByRole('dialog');

    // Support and password recovery are always available; a status page this deployment
    // has not configured is left out rather than linked to nothing.
    expect(within(dialog).getByRole('link', { name: /contact support/i })).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: /reset your password/i }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /service status/i })).toBeNull();
  });
});
