import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Eye, EyeOff, Lock, Mail, ShieldCheck, FileText, PenLine } from 'lucide-react';
import { Badge, Button, Card, Checkbox, Field, Input, cn } from '@uxe/ui';
import type { LoginResponse } from '@uxe/contracts';
import { ApiError, api, setCsrfToken } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { useI18n } from '../lib/i18n.js';
import { Ayumi, BrandLockup } from '../components/Brand.js';

type Stage = 'credentials' | 'mfa' | 'verify_email';

/**
 * Sign-in.
 *
 * Reproduces `assets/screens/01-login.png`: brand and trust cues on the left with Ayumi
 * anchored to the bottom, the sign-in card on the right. On mobile the left panel collapses
 * to a compact header so the form is reachable without scrolling.
 */
export function LoginPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [searchParams] = useSearchParams();
  const { refresh } = useSession();

  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; token: string } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A redirect carrying `?expired` means the previous session died mid-session; say so
  // rather than presenting a bare login form as if nothing happened.
  useEffect(() => {
    if (searchParams.get('expired')) setNotice(t('auth.sessionExpired'));
    if (searchParams.get('sso') === 'failed') setFormError(t('auth.ssoFailed'));
    if (searchParams.get('verified')) setNotice('Your email is confirmed. Sign in to continue.');
  }, [searchParams, t]);

  // Count the rate-limit window down so the user can see when to try again.
  useEffect(() => {
    if (retryAfter === null || retryAfter <= 0) return;
    const timer = setTimeout(() => setRetryAfter((value) => (value === null ? null : value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  const handleApiError = (error: unknown) => {
    if (error instanceof ApiError) {
      setFieldErrors(error.fieldErrors);
      setFormError(error.message);
      if (error.code === 'rate_limited') {
        const seconds = Number(error.details.retryAfterSeconds ?? 0);
        setRetryAfter(Number.isFinite(seconds) && seconds > 0 ? seconds : 60);
      }
    } else {
      setFormError('We could not reach the server. Check your connection and try again.');
    }
  };

  async function submitCredentials(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const result = await api.post<LoginResponse & { challengeToken?: string }>('/auth/login', {
        email,
        password,
        rememberMe,
      });

      if (result.status === 'authenticated') {
        setCsrfToken(result.session.csrfToken);
        await refresh();
        navigate(location.state?.from ?? '/dashboard', { replace: true });
        return;
      }

      if (result.status === 'mfa_required') {
        setChallenge({ id: result.challengeId, token: result.challengeToken ?? '' });
        setStage('mfa');
        return;
      }

      setStage('verify_email');
    } catch (error) {
      handleApiError(error);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitMfa(event: FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    setSubmitting(true);
    setFormError(null);

    try {
      const session = await api.post<{ csrfToken: string }>('/auth/mfa/verify', {
        challengeId: challenge.id,
        challengeToken: challenge.token,
        code,
        trustDevice: false,
      });
      setCsrfToken(session.csrfToken);
      await refresh();
      navigate(location.state?.from ?? '/dashboard', { replace: true });
    } catch (error) {
      handleApiError(error);
      setCode('');
    } finally {
      setSubmitting(false);
    }
  }

  const rateLimited = retryAfter !== null && retryAfter > 0;

  return (
    <div className="min-h-dvh bg-[var(--uxe-bg)]">
      <div className="mx-auto grid min-h-dvh w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[55fr_45fr]">
        <BrandPanel />

        <main
          id="main"
          className="flex items-center justify-center px-4 py-10 sm:px-8 lg:px-12"
        >
          <Card className="w-full max-w-[440px] p-6 sm:p-8" flush>
            <div className="p-6 sm:p-8">
              {stage === 'verify_email' ? (
                <VerifyEmailNotice email={email} onBack={() => setStage('credentials')} />
              ) : (
                <>
                  <h1 className="text-center text-[26px] font-bold text-[var(--uxe-text)] sm:text-[30px]">
                    {stage === 'mfa' ? t('auth.mfaTitle') : t('auth.welcomeBack')}
                  </h1>

                  {notice && (
                    <p
                      role="status"
                      className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-info-border)] bg-[var(--uxe-info-bg)] px-3 py-2.5 text-[13px] text-[var(--uxe-info)]"
                    >
                      {notice}
                    </p>
                  )}

                  {formError && (
                    <p
                      role="alert"
                      className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-3 py-2.5 text-[13px] font-medium text-[var(--uxe-danger)]"
                    >
                      {formError}
                      {rateLimited && ` You can try again in ${retryAfter}s.`}
                    </p>
                  )}

                  {stage === 'credentials' ? (
                    <>
                      <div className="mt-6 flex flex-col gap-2.5">
                        <SsoButton provider="google" label={t('auth.continueGoogle')} />
                        <SsoButton provider="microsoft" label={t('auth.continueMicrosoft')} />
                      </div>

                      <div className="my-6 flex items-center gap-4" aria-hidden>
                        <span className="h-px flex-1 bg-[var(--uxe-border)]" />
                        <span className="text-[13px] text-[var(--uxe-text-secondary)]">{t('auth.or')}</span>
                        <span className="h-px flex-1 bg-[var(--uxe-border)]" />
                      </div>

                      <form onSubmit={submitCredentials} className="flex flex-col gap-4" noValidate>
                        <Field
                          label={t('auth.workEmail')}
                          htmlFor="email"
                          error={fieldErrors.email?.[0]}
                        >
                          <Input
                            id="email"
                            name="email"
                            type="email"
                            autoComplete="username"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder={t('auth.emailPlaceholder')}
                            invalid={Boolean(fieldErrors.email)}
                            iconLeft={<Mail className="h-4 w-4" aria-hidden />}
                          />
                        </Field>

                        <Field
                          label={t('auth.password')}
                          htmlFor="password"
                          error={fieldErrors.password?.[0]}
                        >
                          <Input
                            id="password"
                            name="password"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="current-password"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={t('auth.passwordPlaceholder')}
                            invalid={Boolean(fieldErrors.password)}
                            iconLeft={<Lock className="h-4 w-4" aria-hidden />}
                            iconRight={
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setShowPassword((v) => !v)}
                                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
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

                        <div className="flex items-center justify-between gap-3">
                          <Checkbox
                            checked={rememberMe}
                            onCheckedChange={setRememberMe}
                            label={t('auth.rememberMe')}
                          />
                          <Link
                            to="/forgot-password"
                            className="text-[13px] font-medium text-[var(--uxe-cobalt)] hover:underline"
                          >
                            {t('auth.forgotPassword')}
                          </Link>
                        </div>

                        <Button
                          type="submit"
                          variant="primary"
                          size="xl"
                          full
                          className="mt-2"
                          loading={submitting}
                          loadingLabel="Signing in"
                          disabled={rateLimited}
                        >
                          {t('auth.signIn')}
                        </Button>
                      </form>

                      <p className="mt-6 text-center text-[14px] text-[var(--uxe-text-secondary)]">
                        {t('auth.noAccount')}{' '}
                        <Link to="/register" className="font-semibold text-[var(--uxe-cobalt)] hover:underline">
                          {t('auth.createAccount')}
                        </Link>
                      </p>
                    </>
                  ) : (
                    <form onSubmit={submitMfa} className="mt-6 flex flex-col gap-4" noValidate>
                      <p className="text-[14px] text-[var(--uxe-text-secondary)]">
                        {t('auth.mfaDescription')}
                      </p>
                      <Field label={t('auth.mfaCode')} htmlFor="mfa-code" hint={t('auth.mfaRecoveryHint')}>
                        <Input
                          id="mfa-code"
                          name="one-time-code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          maxLength={11}
                          required
                          value={code}
                          onChange={(e) => setCode(e.target.value)}
                          className="text-center font-[family-name:var(--uxe-font-mono)] text-[20px] tracking-[0.3em]"
                        />
                      </Field>
                      <Button type="submit" variant="primary" size="xl" full loading={submitting}>
                        {t('auth.mfaVerify')}
                      </Button>
                      <Button type="button" variant="ghost" onClick={() => setStage('credentials')}>
                        {t('auth.backToSignIn')}
                      </Button>
                    </form>
                  )}
                </>
              )}
            </div>
          </Card>
        </main>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Left panel                                                                 */
/* -------------------------------------------------------------------------- */

function BrandPanel() {
  const { t } = useI18n();

  return (
    <section
      className={cn(
        'relative overflow-hidden px-6 pt-8 sm:px-10 lg:px-14 lg:pt-12',
        'bg-[linear-gradient(160deg,#FFFFFF_0%,#F4F7FF_55%,#EEF2FF_100%)]',
        'dark:bg-[linear-gradient(160deg,#0E1320_0%,#131829_55%,#161D33_100%)]',
      )}
    >
      {/* Decorative ground: soft brand glow, kept behind everything and hidden from AT. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-1/3 h-[420px] w-[420px] rounded-full bg-[var(--uxe-cobalt)]/[0.07] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-0 top-0 h-[360px] w-[360px] rounded-full bg-[var(--uxe-violet)]/[0.07] blur-3xl"
      />

      <div className="relative flex h-full flex-col">
        <div>
          <BrandLockup size="lg" className="max-lg:!text-[28px]" />
          <p className="mt-3 max-w-xl text-[15px] font-medium text-[var(--uxe-text-secondary)] sm:text-[17px]">
            {t('app.promise')}
          </p>
        </div>

        <ul className="mt-8 grid gap-5 sm:grid-cols-3 lg:mt-10">
          <TrustCue
            icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
            tone="info"
            title={t('auth.enterpriseSecurity')}
            detail={t('auth.enterpriseSecurityDetail')}
          />
          <TrustCue
            icon={<CheckCircle2 className="h-5 w-5" aria-hidden />}
            tone="success"
            title={t('auth.trustedBy')}
            detail={t('auth.trustedByDetail')}
          />
          <TrustCue
            icon={<Lock className="h-5 w-5" aria-hidden />}
            tone="violet"
            title={t('auth.secureConfidential')}
            detail={t('auth.secureConfidentialDetail')}
          />
        </ul>

        {/* Ayumi + the floating proof cards. Hidden below `lg` so the sign-in form is the
            first thing a phone user sees. */}
        <div className="relative mt-auto hidden min-h-[380px] lg:block">
          <div className="absolute inset-x-0 bottom-0 flex h-[440px] items-end justify-center">
            <div className="h-full w-[380px]">
              <Ayumi variant="lg" priority />
            </div>
          </div>

          <FloatingCard
            className="absolute left-0 top-[34%] w-[232px]"
            icon={<ShieldCheck className="h-5 w-5 text-[var(--uxe-cobalt)]" aria-hidden />}
            title={t('auth.complianceCheck')}
            badge={{ label: t('auth.compliant'), tone: 'success' }}
          />
          <FloatingCard
            className="absolute right-[8%] top-[24%] w-[248px]"
            icon={<FileText className="h-5 w-5 text-[var(--uxe-violet)]" aria-hidden />}
            title={t('auth.evidenceMatch')}
            badge={{ label: t('auth.verified'), tone: 'success' }}
          />
          <FloatingCard
            className="absolute right-[4%] bottom-[16%] w-[248px]"
            icon={<PenLine className="h-5 w-5 text-[var(--uxe-cobalt)]" aria-hidden />}
            title={t('auth.documentCorrection')}
            badge={{ label: t('auth.ready'), tone: 'success' }}
          />
        </div>
      </div>
    </section>
  );
}

function TrustCue({
  icon,
  title,
  detail,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone: 'info' | 'success' | 'violet';
}) {
  const tones = {
    info: 'bg-[var(--uxe-info-bg)] text-[var(--uxe-info)]',
    success: 'bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]',
    violet: 'bg-[color-mix(in_srgb,var(--uxe-violet)_12%,transparent)] text-[var(--uxe-violet)]',
  } as const;

  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control-lg)]', tones[tone])}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold leading-snug text-[var(--uxe-text)]">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-[var(--uxe-text-secondary)]">{detail}</span>
      </span>
    </li>
  );
}

/**
 * The restrained proof cards from the concept.
 *
 * Purely decorative, so the whole group is hidden from assistive technology: the same
 * three capabilities are already stated in the trust cues above in real text.
 */
function FloatingCard({
  className,
  icon,
  title,
  badge,
}: {
  className?: string;
  icon: React.ReactNode;
  title: string;
  badge: { label: string; tone: 'success' };
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)]',
        'p-4 shadow-[var(--uxe-shadow-lg)] backdrop-blur-sm',
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface-selected)]">
          {icon}
        </span>
        <span className="text-[13px] font-semibold text-[var(--uxe-text)]">{title}</span>
      </div>
      <div className="mt-3 space-y-1.5">
        <span className="block h-1.5 w-full rounded-full bg-[var(--uxe-surface-sunken)]" />
        <span className="block h-1.5 w-4/5 rounded-full bg-[var(--uxe-surface-sunken)]" />
      </div>
      <Badge tone="success" size="sm" className="mt-3" icon={<CheckCircle2 className="h-3 w-3" />}>
        {badge.label}
      </Badge>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* SSO                                                                        */
/* -------------------------------------------------------------------------- */

function SsoButton({ provider, label }: { provider: 'google' | 'microsoft'; label: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const start = async () => {
    setPending(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(`/auth/oauth/${provider}/start`, {});
      window.location.assign(url);
    } catch (caught) {
      // A deployment without OAuth credentials says so plainly instead of leaving a
      // button that appears to do nothing.
      setError(caught instanceof ApiError ? caught.message : t('auth.ssoUnavailable'));
      setPending(false);
    }
  };

  return (
    <div>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        full
        onClick={start}
        loading={pending}
        className="justify-center gap-3 font-medium"
      >
        {provider === 'google' ? <GoogleIcon /> : <MicrosoftIcon />}
        {label}
      </Button>
      {error && (
        <p role="alert" className="mt-1.5 text-[12px] text-[var(--uxe-text-secondary)]">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <rect x="0" y="0" width="8.2" height="8.2" fill="#F25022" />
      <rect x="9.8" y="0" width="8.2" height="8.2" fill="#7FBA00" />
      <rect x="0" y="9.8" width="8.2" height="8.2" fill="#00A4EF" />
      <rect x="9.8" y="9.8" width="8.2" height="8.2" fill="#FFB900" />
    </svg>
  );
}

function VerifyEmailNotice({ email, onBack }: { email: string; onBack: () => void }) {
  const { t } = useI18n();
  return (
    <div className="text-center">
      <span
        aria-hidden
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]"
      >
        <Mail className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-[22px] font-bold text-[var(--uxe-text)]">{t('auth.checkInbox')}</h1>
      <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">
        {t('auth.verifyEmailSent', { email })}
      </p>
      <Button variant="ghost" className="mt-6" onClick={onBack}>
        {t('auth.backToSignIn')}
      </Button>
    </div>
  );
}
