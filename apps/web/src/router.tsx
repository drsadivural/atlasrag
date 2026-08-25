import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';
import { EmptyState, Button, LoadingRegion, Skeleton } from '@uxe/ui';
import { useSession } from './lib/session.js';
import { AppShell } from './components/AppShell.js';
import { RouteErrorBoundary } from './components/ErrorBoundary.js';
import { I18nProvider } from './lib/i18n.js';
import { LoginPage } from './routes/LoginPage.js';
import { RegisterPage } from './routes/RegisterPage.js';
import { ForgotPasswordPage } from './routes/ForgotPasswordPage.js';
import { DashboardPage } from './routes/DashboardPage.js';
import { KnowledgePage } from './routes/KnowledgePage.js';
import { ConsultPage } from './routes/ConsultPage.js';

// Routes below the fold of the primary experience are split, so the first authenticated
// paint does not pay for the settings forms or the audit log.
const ReportsPage = lazy(() => import('./routes/ReportsPage.js').then((m) => ({ default: m.ReportsPage })));
const ActivityPage = lazy(() => import('./routes/ActivityPage.js').then((m) => ({ default: m.ActivityPage })));
const UsersPage = lazy(() => import('./routes/UsersPage.js').then((m) => ({ default: m.UsersPage })));
const SettingsPage = lazy(() => import('./routes/SettingsPage.js').then((m) => ({ default: m.SettingsPage })));
const KnowledgeSourcePage = lazy(() =>
  import('./routes/KnowledgeSourcePage.js').then((m) => ({ default: m.KnowledgeSourcePage })),
);
const ReportDetailPage = lazy(() =>
  import('./routes/ReportDetailPage.js').then((m) => ({ default: m.ReportDetailPage })),
);
const VerifyEmailPage = lazy(() =>
  import('./routes/VerifyEmailPage.js').then((m) => ({ default: m.VerifyEmailPage })),
);
const ResetPasswordPage = lazy(() =>
  import('./routes/ResetPasswordPage.js').then((m) => ({ default: m.ResetPasswordPage })),
);

function RouteFallback() {
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

  if (isLoading) return <RouteFallback />;
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return (
    <I18nProvider locale={session.user.locale}>
      <AppShell>
        <Boundary>
          <Outlet />
        </Boundary>
      </AppShell>
    </I18nProvider>
  );
}

/** Keeps a signed-in user out of the authentication screens. */
function RequireAnonymous() {
  const { session, isLoading } = useSession();
  if (isLoading) return <RouteFallback />;
  if (session) return <Navigate to="/dashboard" replace />;
  return (
    <I18nProvider locale="en">
      <Boundary>
        <Outlet />
      </Boundary>
    </I18nProvider>
  );
}

function NotFoundPage() {
  return (
    <I18nProvider locale="en">
      <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-6">
        <EmptyState
          title="Page not found"
          description="That page does not exist, or you do not have access to it."
          action={
            <Button variant="primary" asChild>
              <a href="/dashboard">Go to dashboard</a>
            </Button>
          }
        />
      </div>
    </I18nProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <RequireAnonymous />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
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
      { path: '/knowledge', element: <KnowledgePage /> },
      { path: '/knowledge/:sourceId', element: <KnowledgeSourcePage /> },
      { path: '/reports', element: <ReportsPage /> },
      { path: '/reports/:reportId', element: <ReportDetailPage /> },
      { path: '/activity', element: <ActivityPage /> },
      { path: '/users', element: <UsersPage /> },
      { path: '/settings', element: <Navigate to="/settings/general" replace /> },
      { path: '/settings/:section', element: <SettingsPage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
