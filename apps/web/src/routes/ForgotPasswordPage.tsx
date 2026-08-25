import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { Button, Card, Field, Input } from '@uxe/ui';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { BrandLockup } from '../components/Brand.js';

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/forgot-password', { email });
      // The response is deliberately identical whether or not the address exists, so this
      // form cannot be used to discover which emails have accounts.
      setSent(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'We could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-4">
      <main id="main" className="w-full max-w-[440px]">
        <div className="mb-6 flex justify-center">
          <BrandLockup size="md" />
        </div>

        <Card className="p-6 sm:p-8">
          {sent ? (
            <div className="text-center">
              <span
                aria-hidden
                className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]"
              >
                <Mail className="h-6 w-6" />
              </span>
              <h1 className="mt-4 text-[22px] font-bold text-[var(--uxe-text)]">{t('auth.checkInbox')}</h1>
              <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">{t('auth.resetSent')}</p>
              <Button asChild variant="secondary" className="mt-6">
                <Link to="/login">{t('auth.backToSignIn')}</Link>
              </Button>
            </div>
          ) : (
            <>
              <h1 className="text-[24px] font-bold text-[var(--uxe-text)]">{t('auth.resetTitle')}</h1>
              <p className="mt-1.5 text-[14px] text-[var(--uxe-text-secondary)]">{t('auth.resetDescription')}</p>

              {error && (
                <p role="alert" className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-3 py-2.5 text-[13px] text-[var(--uxe-danger)]">
                  {error}
                </p>
              )}

              <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
                <Field label={t('auth.workEmail')} htmlFor="email" required>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('auth.emailPlaceholder')}
                    iconLeft={<Mail className="h-4 w-4" aria-hidden />}
                  />
                </Field>
                <Button type="submit" variant="primary" size="xl" full loading={submitting}>
                  Send reset link
                </Button>
              </form>

              <p className="mt-6 text-center text-[14px]">
                <Link to="/login" className="font-semibold text-[var(--uxe-cobalt)] hover:underline">
                  {t('auth.backToSignIn')}
                </Link>
              </p>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}
