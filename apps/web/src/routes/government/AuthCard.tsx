import { useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Building2,
  ChevronDown,
  Eye,
  EyeOff,
  Fingerprint,
  Loader2,
  Lock,
  Mail,
} from 'lucide-react';
import { ApiError, api, setCsrfToken } from '../../lib/api.js';
import { useI18n, type MessageKey } from '../../lib/i18n.js';
import { useSession } from '../../lib/session.js';
import type { GovernmentConfig } from './config.js';

type Stage = 'credentials' | 'mfa';

/**
 * The authentication card.
 *
 * Ordered by the strength of the identity behind it: UAE PASS first and most prominent,
 * then the entity's own directory, and only then an address and a password behind a
 * disclosure.
 *
 * Whether there is a route to a new account from here is the deployment's decision, and
 * the screen asks rather than assumes. Where registration is off — the Government Edition
 * as specified — access is provisioned by an entity administrator, the card says so, and
 * the federated callbacks refuse an identity that has not already been provisioned. Where
 * it is on, offering the link is the honest thing to do: the API would accept the account
 * either way, and hiding the route only means somebody cannot find it.
 */
export function AuthCard({
  config,
  onNeedHelp,
}: {
  config: GovernmentConfig | null;
  onNeedHelp: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refresh } = useSession();
  const formId = useId();

  const [stage, setStage] = useState<Stage>('credentials');
  // Expanded on desktop, which is what the approved references show, and collapsed on a
  // phone so the two federated buttons are what a small screen leads with. Read once at
  // first render rather than in an effect, so the panel never flips after paint.
  const [expanded, setExpanded] = useState(
    () => typeof matchMedia !== 'function' || matchMedia('(min-width: 48rem)').matches,
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(false);
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<{ id: string; token: string } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState<'uae_pass' | 'gov_sso' | null>(null);
  const [formError, setFormError] = useState<string | null>(() => initialNotice(searchParams, t));
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const passwordRef = useRef<HTMLInputElement>(null);

  const startFederated = async (provider: 'uae_pass' | 'gov_sso') => {
    const path = provider === 'uae_pass' ? 'uae-pass' : 'sso';
    const label = provider === 'uae_pass' ? 'UAE PASS' : t('gov.governmentSso');
    setStarting(provider);
    setFormError(null);
    try {
      const result = await api.post<{ url: string }>(`/auth/government/${path}/start`, {});
      // A full navigation: an identity provider refuses to render in a frame, and a
      // blocked popup would look like a button that does nothing.
      window.location.assign(result.url);
    } catch (error) {
      setStarting(null);
      setFormError(
        error instanceof ApiError && error.code === 'provider_unconfigured'
          ? t('gov.errorUnconfigured', { provider: label })
          : t('gov.errorProvider', { provider: label }),
      );
    }
  };

  const validate = (): boolean => {
    const errors: { email?: string; password?: string } = {};
    const trimmed = email.trim().toLowerCase();

    if (!trimmed) errors.email = t('gov.errorEmailRequired');
    else if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(trimmed)) errors.email = t('gov.errorEmailFormat');
    else if (!isAllowedDomain(trimmed, config?.allowedDomains ?? [])) {
      // A domain rule is about which addresses this deployment accepts at all, which is
      // public policy — it says nothing about whether an account exists.
      errors.email = t('gov.errorEmailDomain');
    }

    if (!password) errors.password = t('gov.errorPasswordRequired');

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);

    if (!navigator.onLine) {
      setFormError(t('gov.offline'));
      return;
    }
    if (!validate()) return;

    setSubmitting(true);
    try {
      const result = await api.post<
        | { status: 'authenticated'; session: { csrfToken: string } }
        | { status: 'mfa_required'; challengeId: string; challengeToken: string }
        | { status: 'email_verification_required' }
      >('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
        rememberMe: rememberDevice,
      });

      if (result.status === 'authenticated') {
        setCsrfToken(result.session.csrfToken);
        await refresh();
        navigate(config?.postLoginRoute ?? '/dashboard', { replace: true });
        return;
      }
      if (result.status === 'mfa_required') {
        setChallenge({ id: result.challengeId, token: result.challengeToken });
        setStage('mfa');
        return;
      }
      setFormError(t('gov.errorCredentials'));
    } catch (error) {
      setFormError(messageFor(error, t));
    } finally {
      setSubmitting(false);
    }
  };

  const submitMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (!challenge || submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const session = await api.post<{ csrfToken: string }>('/auth/mfa/verify', {
        challengeId: challenge.id,
        challengeToken: challenge.token,
        code,
        trustDevice: rememberDevice,
      });
      setCsrfToken(session.csrfToken);
      await refresh();
      navigate(config?.postLoginRoute ?? '/dashboard', { replace: true });
    } catch (error) {
      setFormError(messageFor(error, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-[33.875rem] rounded-[0.875rem] border border-[var(--gov-card-border)] bg-[var(--gov-card)] p-6 shadow-[var(--gov-card-shadow)] sm:p-8">
      <p className="text-center text-[0.6875rem] font-semibold tracking-[0.12em] text-[var(--gov-gold-card)]">
        {t('gov.eyebrow')}
      </p>
      <h1
        id="gov-signin-heading"
        className="mt-2 text-center text-[1.75rem] font-bold text-[var(--gov-text)]"
      >
        {t('gov.signInTitle')}
      </h1>
      <p className="mt-1.5 text-center text-[0.875rem] text-[var(--gov-text-secondary)]">
        {t('gov.signInSubtitle')}
      </p>

      {formError && (
        <p
          role="alert"
          className="mt-4 rounded-[0.5rem] border border-[var(--gov-danger-border)] bg-[var(--gov-danger-bg)] px-3 py-2.5 text-[0.8125rem] font-medium text-[var(--gov-danger)]"
        >
          {formError}
        </p>
      )}

      {stage === 'mfa' ? (
        <form onSubmit={submitMfa} className="mt-5 flex flex-col gap-4" noValidate>
          <h2 className="text-[0.9375rem] font-semibold text-[var(--gov-text)]">
            {t('gov.mfaTitle')}
          </h2>
          <p className="text-[0.8125rem] text-[var(--gov-text-secondary)]">{t('gov.mfaBody')}</p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-[var(--gov-text)]">
              {t('gov.mfaCode')}
            </span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              className="h-12 rounded-[0.5rem] border border-[var(--gov-field-border)] bg-[var(--gov-field)] px-3 text-[0.9375rem] tracking-[0.3em] text-[var(--gov-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
            />
          </label>
          <PrimaryButton
            busy={submitting}
            label={t('gov.mfaVerify')}
            busyLabel={t('gov.signingIn')}
          />
        </form>
      ) : (
        <>
          <div className="mt-5 flex flex-col gap-2.5">
            <FederatedButton
              icon={<Fingerprint className="h-5 w-5" aria-hidden />}
              title={t('gov.uaePass')}
              hint={t('gov.uaePassHint')}
              busy={starting === 'uae_pass'}
              available={config?.uaePass.available ?? false}
              unavailableLabel={t('gov.errorUnconfigured', { provider: 'UAE PASS' })}
              onClick={() => void startFederated('uae_pass')}
            />
            <FederatedButton
              icon={<Building2 className="h-5 w-5" aria-hidden />}
              title={t('gov.governmentSso')}
              busy={starting === 'gov_sso'}
              available={config?.sso.available ?? false}
              unavailableLabel={t('gov.errorUnconfigured', { provider: t('gov.governmentSso') })}
              onClick={() => void startFederated('gov_sso')}
            />
          </div>

          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-[var(--gov-divider)]" aria-hidden />
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
              aria-controls={`${formId}-credentials`}
              className="flex items-center gap-1.5 rounded-[0.375rem] px-1.5 py-1 text-[0.8125rem] font-medium text-[var(--gov-text-secondary)] hover:text-[var(--gov-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${expanded ? '' : '-rotate-90 rtl:rotate-90'}`}
                aria-hidden
              />
              {t('gov.otherAccess')}
            </button>
            <span className="h-px flex-1 bg-[var(--gov-divider)]" aria-hidden />
          </div>

          {/* Hidden rather than unmounted: collapsing the disclosure must not throw away
              what somebody has already typed. */}
          <form
            id={`${formId}-credentials`}
            onSubmit={submit}
            hidden={!expanded}
            className="flex flex-col gap-4"
            noValidate
          >
            <Field
              id={`${formId}-email`}
              label={t('gov.emailLabel')}
              error={fieldErrors.email}
              icon={<Mail className="h-4 w-4" aria-hidden />}
            >
              <input
                id={`${formId}-email`}
                type="email"
                inputMode="email"
                autoComplete="username"
                spellCheck={false}
                placeholder={t('gov.emailPlaceholder')}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? `${formId}-email-error` : undefined}
                required
                className="h-12 w-full rounded-[0.5rem] border border-[var(--gov-field-border)] bg-[var(--gov-field)] ps-10 pe-3 text-[0.9375rem] text-[var(--gov-text)] placeholder:text-[var(--gov-text-muted)] hover:border-[var(--gov-field-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
              />
            </Field>

            <Field
              id={`${formId}-password`}
              label={t('gov.passwordLabel')}
              error={fieldErrors.password}
              icon={<Lock className="h-4 w-4" aria-hidden />}
            >
              <input
                id={`${formId}-password`}
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder={t('gov.passwordPlaceholder')}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? `${formId}-password-error` : undefined}
                required
                className="h-12 w-full rounded-[0.5rem] border border-[var(--gov-field-border)] bg-[var(--gov-field)] ps-10 pe-11 text-[0.9375rem] text-[var(--gov-text)] placeholder:text-[var(--gov-text-muted)] hover:border-[var(--gov-field-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
              />
              <button
                type="button"
                onClick={() => {
                  // Reveal and re-place the caret where it was: changing the input type
                  // otherwise sends it to the end mid-word.
                  const input = passwordRef.current;
                  const start = input?.selectionStart ?? null;
                  const end = input?.selectionEnd ?? null;
                  setShowPassword((current) => !current);
                  requestAnimationFrame(() => {
                    if (input && start !== null && end !== null) {
                      input.focus();
                      input.setSelectionRange(start, end);
                    }
                  });
                }}
                aria-pressed={showPassword}
                className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-[0.5rem] text-[var(--gov-text-secondary)] hover:text-[var(--gov-text)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden />
                )}
                <span className="sr-only">
                  {showPassword ? t('gov.hidePassword') : t('gov.showPassword')}
                </span>
              </button>
            </Field>
            <span aria-live="polite" className="sr-only">
              {showPassword ? t('gov.passwordShown') : t('gov.passwordHidden')}
            </span>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem] text-[var(--gov-text)]">
                <input
                  type="checkbox"
                  checked={rememberDevice}
                  onChange={(event) => setRememberDevice(event.target.checked)}
                  className="h-4 w-4 accent-[var(--gov-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
                />
                {t('gov.rememberDevice')}
              </label>
              <Link
                to="/forgot-password"
                className="rounded-[0.25rem] text-[0.8125rem] font-medium text-[var(--gov-text-secondary)] underline-offset-2 hover:text-[var(--gov-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
              >
                {t('gov.forgotPassword')}
              </Link>
            </div>

            <PrimaryButton
              busy={submitting}
              label={t('gov.signIn')}
              busyLabel={t('gov.signingIn')}
            />
          </form>
        </>
      )}

      {config?.publicRegistration ? (
        <p className="mt-4 text-center text-[0.8125rem] text-[var(--gov-text-secondary)]">
          {t('gov.noAccount')}{' '}
          <Link
            to="/register"
            className="rounded-[0.25rem] font-semibold text-[var(--gov-primary)] underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
          >
            {t('gov.createAccount')}
          </Link>
        </p>
      ) : (
        <p className="mt-4 text-center text-[0.8125rem] text-[var(--gov-text-secondary)]">
          {t('gov.provisioned')}
        </p>
      )}

      <nav
        aria-label={t('gov.helpTitle')}
        className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-t border-[var(--gov-divider)] pt-4 text-[0.8125rem]"
      >
        <FooterLink to={config?.links.privacy ?? '/legal/privacy'} label={t('gov.privacy')} />
        <span className="text-[var(--gov-divider)]" aria-hidden>
          |
        </span>
        <FooterLink to={config?.links.security ?? '/legal/security'} label={t('gov.security')} />
        <span className="text-[var(--gov-divider)]" aria-hidden>
          |
        </span>
        <FooterLink
          to={config?.links.accessibility ?? '/legal/accessibility'}
          label={t('gov.accessibilityLink')}
        />
        <span className="text-[var(--gov-divider)]" aria-hidden>
          |
        </span>
        <button
          type="button"
          onClick={onNeedHelp}
          className="rounded-[0.25rem] font-medium text-[var(--gov-text-secondary)] underline-offset-2 hover:text-[var(--gov-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
        >
          {t('gov.contactSupport')}
        </button>
      </nav>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-[0.75rem] text-[var(--gov-text-muted)]">
        <Lock className="h-3.5 w-3.5" aria-hidden />
        {/* Data residency is only claimed when the deployment says it is true. */}
        {config?.dataResidency ? t('gov.securityStatement') : t('gov.securityStatementBasic')}
      </p>
    </div>
  );
}

function FooterLink({ to, label }: { to: string; label: string }) {
  const external = /^https?:\/\//i.test(to);
  const className =
    'rounded-[0.25rem] font-medium text-[var(--gov-text-secondary)] underline-offset-2 hover:text-[var(--gov-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]';

  return external ? (
    <a href={to} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  ) : (
    <Link to={to} className={className}>
      {label}
    </Link>
  );
}

function Field({
  id,
  label,
  error,
  icon,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[0.8125rem] font-semibold text-[var(--gov-text)]"
      >
        {label}
      </label>
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 start-0 flex w-10 items-center justify-center text-[var(--gov-text-muted)]"
        >
          {icon}
        </span>
        {children}
      </div>
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-1.5 text-[0.75rem] font-medium text-[var(--gov-danger)]"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function FederatedButton({
  icon,
  title,
  hint,
  busy,
  available,
  unavailableLabel,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  busy: boolean;
  available: boolean;
  unavailableLabel: string;
  onClick: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={!available || busy}
        aria-describedby={available ? undefined : `${title}-unavailable`}
        className="flex min-h-12 w-full items-center gap-3 rounded-[0.5rem] border border-[var(--gov-field-border)] bg-[var(--gov-field)] px-4 py-3 text-start transition-colors hover:border-[var(--gov-field-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--gov-gold-card)]">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : icon}
        </span>
        <span className="min-w-0">
          <span className="block text-[0.9375rem] font-semibold text-[var(--gov-text)]">
            {title}
          </span>
          {hint && (
            <span className="block text-[0.75rem] text-[var(--gov-text-secondary)]">{hint}</span>
          )}
        </span>
      </button>
      {!available && (
        <p
          id={`${title}-unavailable`}
          className="mt-1.5 text-[0.75rem] text-[var(--gov-text-muted)]"
        >
          {unavailableLabel}
        </p>
      )}
    </div>
  );
}

function PrimaryButton({
  busy,
  label,
  busyLabel,
}: {
  busy: boolean;
  label: string;
  busyLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="flex min-h-12 w-full items-center justify-center gap-2 rounded-[0.5rem] bg-[var(--gov-primary)] px-4 text-[0.9375rem] font-semibold text-[var(--gov-primary-text)] transition-colors hover:bg-[var(--gov-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)] disabled:cursor-progress disabled:opacity-80"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {busy ? busyLabel : label}
    </button>
  );
}

function isAllowedDomain(email: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return allowed.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

/**
 * A failure, said in words the person reading it can act on.
 *
 * Invalid credentials always produce the same sentence whether or not the address exists,
 * so this screen cannot be used to discover who has an account.
 */
function messageFor(
  error: unknown,
  t: (key: MessageKey, values?: Record<string, string>) => string,
): string {
  if (!(error instanceof ApiError)) return t('gov.errorNetwork');
  if (error.code === 'rate_limited') return t('gov.errorLocked');
  if (error.code === 'session_expired') return t('gov.sessionExpired');
  if (error.code === 'password_expired') return t('gov.errorExpired');
  if (error.status === 0) return t('gov.errorNetwork');
  return t('gov.errorCredentials');
}

function initialNotice(
  params: URLSearchParams,
  t: (key: MessageKey, values?: Record<string, string>) => string,
): string | null {
  if (params.get('expired')) return t('gov.sessionExpired');
  if (params.get('sso') !== 'failed') return null;
  const reason = params.get('reason');
  if (reason === 'not_provisioned') return t('gov.provisioned');
  if (reason === 'not_configured') {
    return t('gov.errorUnconfigured', { provider: 'UAE PASS / Government SSO' });
  }
  return t('gov.errorProvider', { provider: 'UAE PASS / Government SSO' });
}
