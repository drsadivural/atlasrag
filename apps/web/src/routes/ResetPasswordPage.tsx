import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { Button, Card, Field, Input } from '@uxe/ui';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { BrandLockup } from '../components/Brand.js';

export function ResetPasswordPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) {
      setFieldErrors({ confirm: ['The two passwords do not match.'] });
      return;
    }

    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post('/auth/reset-password', { token, password });
      // Every session was revoked server-side, so sign-in is the only way forward.
      navigate('/login?reset=1', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not reach the server.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-4">
        <Card className="w-full max-w-[440px] p-8 text-center">
          <h1 className="text-[20px] font-bold text-[var(--uxe-text)]">That link is incomplete</h1>
          <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">
            Open the reset link from your email again, or request a new one.
          </p>
          <Button asChild variant="primary" className="mt-6">
            <Link to="/forgot-password">Request a new link</Link>
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-4">
      <main id="main" className="w-full max-w-[440px]">
        <div className="mb-6 flex justify-center">
          <BrandLockup size="md" />
        </div>
        <Card className="p-6 sm:p-8">
          <h1 className="text-[24px] font-bold text-[var(--uxe-text)]">{t('auth.setPassword')}</h1>

          {error && (
            <p role="alert" className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-3 py-2.5 text-[13px] text-[var(--uxe-danger)]">
              {error}
            </p>
          )}

          <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
            <Field label={t('auth.newPassword')} htmlFor="password" error={fieldErrors.password?.[0]} required>
              <Input
                id="password"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                invalid={Boolean(fieldErrors.password)}
                iconLeft={<Lock className="h-4 w-4" aria-hidden />}
                iconRight={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShow((v) => !v)}
                    aria-label={show ? t('auth.hidePassword') : t('auth.showPassword')}
                  >
                    {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </Button>
                }
              />
            </Field>

            <Field label={t('auth.confirmPassword')} htmlFor="confirm" error={fieldErrors.confirm?.[0]} required>
              <Input
                id="confirm"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                invalid={Boolean(fieldErrors.confirm)}
                iconLeft={<Lock className="h-4 w-4" aria-hidden />}
              />
            </Field>

            <Button type="submit" variant="primary" size="xl" full className="mt-2" loading={submitting}>
              {t('auth.setPassword')}
            </Button>
          </form>

          <p className="mt-5 text-center text-[13px] text-[var(--uxe-text-secondary)]">
            Resetting your password signs out every other device.
          </p>
        </Card>
      </main>
    </div>
  );
}
