import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Button, Card, Skeleton } from '@uxe/ui';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { BrandLockup } from '../components/Brand.js';

export function VerifyEmailPage() {
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [state, setState] = useState<'pending' | 'ok' | 'failed'>(token ? 'pending' : 'failed');
  const [message, setMessage] = useState('That verification link is incomplete.');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    void api
      .post('/auth/verify-email', { token })
      .then(() => {
        if (!cancelled) setState('ok');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState('failed');
        setMessage(
          error instanceof ApiError
            ? error.message
            : 'We could not confirm that link. Request a new one from the sign-in page.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-4">
      <main id="main" className="w-full max-w-[440px]">
        <div className="mb-6 flex justify-center">
          <BrandLockup size="md" />
        </div>
        <Card className="p-8 text-center">
          {state === 'pending' ? (
            <div role="status" aria-live="polite">
              <Skeleton className="mx-auto h-14 w-14 rounded-full" />
              <Skeleton className="mx-auto mt-4 h-6 w-48" />
              <span className="sr-only">Confirming your email address</span>
            </div>
          ) : state === 'ok' ? (
            <>
              <span
                aria-hidden
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--uxe-success-bg)] text-[var(--uxe-success-text)]"
              >
                <CheckCircle2 className="h-7 w-7" />
              </span>
              <h1 className="mt-4 text-[22px] font-bold text-[var(--uxe-text)]">Email confirmed</h1>
              <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">
                Your workspace is ready. Sign in to get started.
              </p>
              <Button asChild variant="primary" className="mt-6">
                <Link to="/login?verified=1">{t('auth.signIn')}</Link>
              </Button>
            </>
          ) : (
            <>
              <span
                aria-hidden
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--uxe-danger-bg)] text-[var(--uxe-danger-text)]"
              >
                <XCircle className="h-7 w-7" />
              </span>
              <h1 className="mt-4 text-[22px] font-bold text-[var(--uxe-text)]">
                That link did not work
              </h1>
              <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">{message}</p>
              <Button asChild variant="secondary" className="mt-6">
                <Link to="/login">{t('auth.backToSignIn')}</Link>
              </Button>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}
