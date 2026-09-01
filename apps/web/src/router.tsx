import { Suspense, useEffect, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { EmptyState, Button, LoadingRegion, Skeleton } from '@uxe/ui';
import { useSession } from './lib/session.js';
import { clearChunkRetries, lazyRoute } from './lib/lazy-route.js';
import { AppShell } from './components/AppShell.js';
import { RouteErrorBoundary } from './components/ErrorBoundary.js';
import { I18nProvider, useI18n } from './lib/i18n.js';
import { PreferencesProvider, usePreferences } from './lib/preferences.js';
import { GovernmentLoginPage } from './routes/government/GovernmentLoginPage.js';
import { PolicyPage } from './routes/PolicyPage.js';
import { RegisterPage } from './routes/RegisterPage.js';
import { ForgotPasswordPage } from './routes/ForgotPasswordPage.js';
import { DashboardPage } from './routes/DashboardPage.js';
import { ConsultPage } from './routes/ConsultPage.js';

// Routes below the fold of the primary experience are split, so the first authenticated
// paint does not pay for the settings forms or the audit log.
const ReportsPage = lazyRoute('ReportsPage', () =>
  import('./routes/ReportsPage.js').then((m) => ({ default: m.ReportsPage })),
);
const ActivityPage = lazyRoute('ActivityPage', () =>
  import('./routes/ActivityPage.js').then((m) => ({ default: m.ActivityPage })),
);
const UsersPage = lazyRoute('UsersPage', () =>
  import('./routes/UsersPage.js').then((m) => ({ default: m.UsersPage })),
);
const SettingsPage = lazyRoute('SettingsPage', () =>
  import('./routes/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
);
const KnowledgeSourcePage = lazyRoute('KnowledgeSourcePage', () =>
  import('./routes/KnowledgeSourcePage.js').then((m) => ({ default: m.KnowledgeSourcePage })),
);
const ReportDetailPage = lazyRoute('ReportDetailPage', () =>
  import('./routes/ReportDetailPage.js').then((m) => ({ default: m.ReportDetailPage })),
);
const AcceptInvitePage = lazyRoute('AcceptInvitePage', () =>
  import('./routes/AcceptInvitePage.js').then((m) => ({ default: m.AcceptInvitePage })),
);
const VerifyEmailPage = lazyRoute('VerifyEmailPage', () =>
  import('./routes/VerifyEmailPage.js').then((m) => ({ default: m.VerifyEmailPage })),
);
const ResetPasswordPage = lazyRoute('ResetPasswordPage', () =>
  import('./routes/ResetPasswordPage.js').then((m) => ({ default: m.ResetPasswordPage })),
);

function RouteFallback() {
  // Rendered while the route chunk is still loading, which can be before any I18nProvider
  // exists — so this one label stays literal rather than reaching for a catalogue that is
  // not mounted yet.
  return (
    <LoadingRegion label="Loading page">
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </LoadingRegion>
  );
}

function Boundary({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Gate for authenticated routes.
 *
 * While the session is still loading it renders a skeleton rather than redirecting — a
 * redirect here would bounce a signed-in user to the login screen on every hard refresh.
 * The intended path is preserved so sign-in returns them where they were going.
 */
function RequireAuth() {
  const { session, isLoading } = useSession();
  const location = useLocation();

  // Getting this far means the chunks resolved, so any reload marks left by a deploy that
  // landed under an open tab have done their job and should not outlast the session.
  useEffect(() => clearChunkRetries(), []);

  if (isLoading) return <RouteFallback />;
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  /*
   * The workspace's language, not the account's.
   *
   * Settings → General is the only place the language can be changed, and it changes the
   * workspace. Rendering from a per-account field that no screen can edit meant picking
   * Arabic there did nothing at all — the setting saved, and the application carried on in
   * English. The account's own locale stands in only while a workspace is not loaded.
   */
  const locale = session.workspace?.locale ?? session.user.locale;

  return (
    <I18nProvider locale={locale}>
      <AppShell>
        <Boundary>
          <Outlet />
        </Boundary>
      </AppShell>
    </I18nProvider>
  );
}

/**
 * Keeps a signed-in user out of the authentication screens.
 *
 * Language on these screens is the visitor's own choice rather than a stored profile
 * setting — nobody has signed in yet, so there is no profile to read it from.
 */
function RequireAnonymous() {
  const { session, isLoading } = useSession();
  if (isLoading) return <RouteFallback />;
  if (session) return <Navigate to="/dashboard" replace />;
  return (
    <PreferencesProvider>
      <SignedOutLocale>
        <Boundary>
          <Outlet />
        </Boundary>
      </SignedOutLocale>
    </PreferencesProvider>
  );
}

function SignedOutLocale({ children }: { children: ReactNode }) {
  const { locale } = usePreferences();
  return <I18nProvider locale={locale}>{children}</I18nProvider>;
}

function NotFoundBody() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-6">
      <EmptyState
        title={t('common.notFound')}
        description={t('common.notFoundBody')}
        action={
          <Button variant="primary" asChild>
            <a href="/dashboard">{t('common.goToDashboard')}</a>
          </Button>
        }
      />
    </div>
  );
}

function NotFoundPage() {
  // The provider has to be mounted before anything can read from it, so the body is its
  // own component rather than JSX that calls t() from outside the tree it creates.
  return (
    <I18nProvider locale="en">
      <NotFoundBody />
    </I18nProvider>
  );
}

/** Sends a bookmark to its new home with its search string intact. */
function RedirectKeepingQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

/** `/knowledge/:sourceId` -> `/settings/knowledge/:sourceId`. */
function RedirectSourceToSettings() {
  const { sourceId } = useParams<{ sourceId: string }>();
  return <Navigate to={`/settings/knowledge/${sourceId ?? ''}`} replace />;
}

export const router = createBrowserRouter([
  {
    element: <RequireAnonymous />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/login', element: <GovernmentLoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
      { path: '/accept-invite', element: <AcceptInvitePage /> },
      { path: '/legal/privacy', element: <PolicyPage policy="privacy" /> },
      { path: '/legal/security', element: <PolicyPage policy="security" /> },
      { path: '/legal/accessibility', element: <PolicyPage policy="accessibility" /> },
      { path: '/support', element: <PolicyPage policy="support" /> },
    ],
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/consult', element: <ConsultPage /> },
      { path: '/consult/:consultationId', element: <ConsultPage /> },
      /*
       * The knowledge base moved under Settings, and the old addresses still work.
       *
       * A workspace's documents are configuration — set up once, revisited rarely — and it
       * shared a sidebar with the two screens people are in all day. Redirecting rather
       * than renaming keeps every bookmark, every link in an email, and every `href` this
       * server has ever handed out pointing somewhere real. The query string comes along,
       * so a saved search still lands on that search.
       */
      { path: '/knowledge', element: <RedirectKeepingQuery to="/settings/knowledge" /> },
      { path: '/knowledge/:sourceId', element: <RedirectSourceToSettings /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/reports/:reportId', element: <ReportDetailPage /> },
      { path: '/activity', element: <ActivityPage /> },
      { path: '/users', element: <UsersPage /> },
      { path: '/settings', element: <Navigate to="/settings/general" replace /> },
      { path: '/settings/knowledge/:sourceId', element: <KnowledgeSourcePage /> },
      { path: '/settings/:section', element: <SettingsPage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
