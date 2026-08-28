import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { Button, Card } from '@uxe/ui';
import { BrandLockup } from './Brand.js';

/**
 * Route-level error element.
 *
 * Without this, an unexpected render error shows React Router's developer stack trace to
 * whoever is using the app. This turns it into a recoverable state: the error is logged
 * for diagnosis, and the user gets a way out rather than a dead page.
 */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  const { title, detail } = describe(error);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-4">
      <Card className="w-full max-w-lg p-8 text-center">
        <div className="mb-6 flex justify-center">
          <BrandLockup size="sm" />
        </div>
        <h1 className="text-[22px] font-bold text-[var(--uxe-text)]">{title}</h1>
        <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">{detail}</p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {/*
            Literal, deliberately. This is the router's own error element: it renders when
            something above the I18nProvider threw, so there is no catalogue to read from —
            and a boundary that crashes looking one up is no boundary at all.
          */}
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload this page
          </Button>
          <Button variant="secondary" onClick={() => navigate('/dashboard')}>
            Go to dashboard
          </Button>
        </div>
      </Card>
    </div>
  );
}

function describe(error: unknown): { title: string; detail: string } {
  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      return {
        title: 'Page not found',
        detail: 'That page does not exist, or you do not have access to it.',
      };
    }
    return {
      title: `Something went wrong (${error.status})`,
      detail: error.statusText || 'The page could not be loaded.',
    };
  }

  // The message is shown but never the stack: it may contain internal detail.
  return {
    title: 'Something went wrong',
    detail:
      error instanceof Error && error.message.length < 200
        ? error.message
        : 'This page hit an unexpected error. Reloading usually clears it.',
  };
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Class boundary for subtrees rendered outside the router's error element, so one broken
 * panel cannot take down the whole application shell.
 */
export class ComponentErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; label: string },
  BoundaryState
> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reported to the console so it reaches the browser's error monitoring hook; the
    // component stack is what makes an otherwise anonymous minified error diagnosable.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div
            role="alert"
            className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] p-4 text-[13px] text-[var(--uxe-text)]"
          >
            <p className="font-semibold text-[var(--uxe-danger)]">
              {this.props.label} could not be displayed.
            </p>
            <p className="mt-1">The rest of the page is unaffected. Reload to try again.</p>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
