import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Building2, CheckCircle2, Eye, EyeOff, Lock, Mail, User } from 'lucide-react';
import { Button, Card, Checkbox, Field, Input } from '@uxe/ui';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { BrandLockup } from '../components/Brand.js';
import { MIN_PASSWORD_LENGTH } from '@uxe/contracts';
import { BACKDROPS, timeOfDay } from '../lib/backdrop.js';

export function RegisterPage() {
  const { t } = useI18n();
  const [form, setForm] = useState({
    fullName: '',
    email: '',
    organizationName: '',
    password: '',
    acceptedTerms: false,
  });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Null until the server answers. It decides whether a confirmation email is part of
  // this deployment's flow, so the page does not have to guess.
  const [done, setDone] = useState<'registered' | 'email_verification_required' | null>(null);
  const backdrop = BACKDROPS[timeOfDay()];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const result = await api.post<{ status?: string }>('/auth/register', {
        ...form,
        locale: 'en',
      });
      setDone(result?.status === 'registered' ? 'registered' : 'email_verification_required');
    } catch (error) {
      if (error instanceof ApiError) {
        setFieldErrors(error.fieldErrors);
        setFormError(error.message);
      } else {
        setFormError('We could not reach the server. Try again in a moment.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh bg-[var(--uxe-bg)]">
      <div className="mx-auto grid min-h-dvh w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[55fr_45fr]">
        {/* The same desert as sign-in, so moving between the two does not change the room. */}
        <section
          className="relative hidden overflow-hidden px-14 pt-12 lg:block"
          style={{
            ['--uxe-text' as string]: backdrop.text,
            ['--uxe-text-secondary' as string]: backdrop.textSecondary,
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: backdrop.ground }}
          />
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%]">
            <img
              src={backdrop.image}
              alt=""
              decoding="async"
              className="h-full w-full object-cover object-right-bottom select-none"
              draggable={false}
            />
            <div
              className="absolute inset-x-0 top-0 h-1/2"
              style={{ backgroundImage: backdrop.scrim }}
            />
          </div>

          <BrandLockup size="lg" className="relative" />
          <p className="relative mt-3 max-w-[500px] text-[17px] font-medium text-[var(--uxe-text-secondary)]">
            {t('app.promise')}
          </p>
        </section>

        <main id="main" className="flex items-center justify-center px-4 py-10 sm:px-8 lg:px-12">
          <Card className="w-full max-w-[460px] p-6 sm:p-8">
            <div className="mb-6 lg:hidden">
              <BrandLockup size="sm" />
            </div>

            {done ? (
              <div className="text-center">
                <span
                  aria-hidden
                  className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--uxe-success-bg)] text-[var(--uxe-success-text)]"
                >
                  {done === 'registered' ? (
                    <CheckCircle2 className="h-6 w-6" />
                  ) : (
                    <Mail className="h-6 w-6" />
                  )}
                </span>
                <h1 className="mt-4 text-[22px] font-bold text-[var(--uxe-text)]">
                  {done === 'registered' ? t('auth.accountCreated') : t('auth.checkInbox')}
                </h1>
                <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">
                  {done === 'registered'
                    ? t('auth.accountCreatedHint')
                    : t('auth.verifyEmailSent', { email: form.email })}
                </p>
                <Button
                  asChild
                  className="mt-6"
                  variant={done === 'registered' ? 'primary' : 'secondary'}
                >
                  <Link
                    to={
                      done === 'registered'
                        ? `/login?registered=${encodeURIComponent(form.email)}`
                        : '/login'
                    }
                  >
                    {done === 'registered' ? t('auth.signIn') : t('auth.backToSignIn')}
                  </Link>
                </Button>
              </div>
            ) : (
              <>
                <h1 className="text-[26px] font-bold text-[var(--uxe-text)]">
                  {t('auth.createAccount')}
                </h1>
                <p className="mt-1.5 text-[14px] text-[var(--uxe-text-secondary)]">
                  {t('auth.registerHint')}
                </p>

                {formError && (
                  <p
                    role="alert"
                    className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-3 py-2.5 text-[13px] font-medium text-[var(--uxe-danger-text)]"
                  >
                    {formError}
                  </p>
                )}

                <form onSubmit={submit} className="mt-6 flex flex-col gap-4" noValidate>
                  <Field
                    label={t('auth.fullName')}
                    htmlFor="fullName"
                    error={fieldErrors.fullName?.[0]}
                    required
                  >
                    <Input
                      id="fullName"
                      autoComplete="name"
                      required
                      value={form.fullName}
                      onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                      invalid={Boolean(fieldErrors.fullName)}
                      iconLeft={<User className="h-4 w-4" aria-hidden />}
                    />
                  </Field>

                  <Field
                    label={t('auth.workEmail')}
                    htmlFor="email"
                    error={fieldErrors.email?.[0]}
                    required
                  >
                    <Input
                      id="email"
                      type="email"
                      autoComplete="username"
                      required
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      placeholder={t('auth.emailPlaceholder')}
                      invalid={Boolean(fieldErrors.email)}
                      iconLeft={<Mail className="h-4 w-4" aria-hidden />}
                    />
                  </Field>

                  <Field
                    label={t('auth.organizationName')}
                    htmlFor="organizationName"
                    error={fieldErrors.organizationName?.[0]}
                    required
                  >
                    <Input
                      id="organizationName"
                      autoComplete="organization"
                      required
                      value={form.organizationName}
                      onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
                      invalid={Boolean(fieldErrors.organizationName)}
                      iconLeft={<Building2 className="h-4 w-4" aria-hidden />}
                    />
                  </Field>

                  <Field
                    label={t('auth.password')}
                    htmlFor="password"
                    error={fieldErrors.password?.[0]}
                    hint={t('auth.passwordHint', { min: MIN_PASSWORD_LENGTH })}
                    required
                  >
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                      value={form.password}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      invalid={Boolean(fieldErrors.password)}
                      iconLeft={<Lock className="h-4 w-4" aria-hidden />}
                      iconRight={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setShowPassword((v) => !v)}
                          aria-label={
                            showPassword ? t('auth.hidePassword') : t('auth.showPassword')
                          }
                          aria-pressed={showPassword}
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" aria-hidden />
                          ) : (
                            <Eye className="h-4 w-4" aria-hidden />
                          )}
                        </Button>
                      }
                    />
                  </Field>

                  <Checkbox
                    checked={form.acceptedTerms}
                    onCheckedChange={(checked) => setForm({ ...form, acceptedTerms: checked })}
                    label={t('auth.acceptTerms')}
                  />
                  {fieldErrors.acceptedTerms && (
                    <p role="alert" className="text-[12px] font-medium text-[var(--uxe-danger)]">
                      {fieldErrors.acceptedTerms[0]}
                    </p>
                  )}

                  <Button
                    type="submit"
                    variant="primary"
                    size="xl"
                    full
                    className="mt-2"
                    loading={submitting}
                  >
                    {t('auth.createAccount')}
                  </Button>
                </form>

                <p className="mt-6 text-center text-[14px] text-[var(--uxe-text-secondary)]">
                  {t('auth.haveAccount')}{' '}
                  <Link
                    to="/login"
                    className="font-semibold text-[var(--uxe-cobalt)] hover:underline"
                  >
                    {t('auth.signIn')}
                  </Link>
                </p>
              </>
            )}
          </Card>
        </main>
      </div>
    </div>
  );
}
