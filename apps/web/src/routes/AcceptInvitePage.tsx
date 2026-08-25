import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Skeleton } from '@uxe/ui';
import type { InvitationPreview } from '@uxe/contracts';
import { type ApiError, api, setCsrfToken } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { BrandLockup } from '../components/Brand.js';

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  consultant: 'Consultant',
  knowledge_manager: 'Knowledge Manager',
  reviewer: 'Reviewer',
  member: 'Member',
  read_only: 'Read Only',
};

/**
 * Accepting a workspace invitation.
 *
 * The invitation is previewed before anything is committed, so the person can see which
 * workspace and which role they are about to join rather than accepting blind.
 */
export function AcceptInvitePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const preview = useQuery<InvitationPreview, ApiError>({
    queryKey: ['invitation', token],
    queryFn: () => api.get<InvitationPreview>(`/auth/invitations/${encodeURIComponent(token)}`),
    enabled: token.length > 0,
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      api.post<{ csrfToken: string }>('/auth/invitations/accept', {
        token,
        ...(fullName.trim() ? { fullName: fullName.trim() } : {}),
        ...(password ? { password } : {}),
      }),
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken);
      void queryClient.invalidateQueries({ queryKey: ['session'] });
      navigate('/dashboard', { replace: true });
    },
    onError: (error: ApiError) => {
      setFieldErrors(error.fieldErrors);
      setFormError(error.message);
    },
  });

  if (!token) {
    return (
      <Shell>
        <InvalidLink message="That invitation link is incomplete. Ask for a new one." />
      </Shell>
    );
  }

  if (preview.isLoading) {
    return (
      <Shell>
        <Card className="p-8">
          <div role="status" aria-live="polite">
            <span className="sr-only">Checking your invitation</span>
            <Skeleton className="h-7 w-56" />
            <Skeleton className="mt-3 h-5 w-72" />
            <Skeleton className="mt-6 h-11 w-full" />
          </div>
        </Card>
      </Shell>
    );
  }

  if (preview.error || !preview.data) {
    return (
      <Shell>
        <InvalidLink
          message={
            preview.error?.message ??
            'That invitation has expired or has already been used. Ask for a new one.'
          }
        />
      </Shell>
    );
  }

  const invitation = preview.data;
  const needsPassword = !invitation.hasAccount;

  return (
    <Shell>
      <Card className="p-8">
        <h1 className="text-[24px] font-bold text-[var(--uxe-text)]">
          Join {invitation.workspaceName}
        </h1>
        <p className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">
          {invitation.invitedByName} invited <strong>{invitation.email}</strong> as{' '}
          <Badge tone="brand" size="sm">
            {ROLE_LABELS[invitation.role] ?? invitation.role}
          </Badge>
        </p>

        {invitation.message && (
          <p className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] bg-[var(--uxe-surface-sunken)] p-3 text-[13px] text-[var(--uxe-text)]">
            “{invitation.message}”
          </p>
        )}

        {formError && (
          <p
            role="alert"
            className="mt-4 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] px-3 py-2.5 text-[13px] font-medium text-[var(--uxe-danger)]"
          >
            {formError}
          </p>
        )}

        <form
          className="mt-6 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFormError(null);
            setFieldErrors({});
            accept.mutate();
          }}
        >
          {needsPassword && (
            <>
              <Field label="Your name" htmlFor="invite-name" error={fieldErrors.fullName?.[0]}>
                <Input
                  id="invite-name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  autoComplete="name"
                  placeholder="How your name appears to colleagues"
                />
              </Field>

              <Field
                label={t('auth.password')}
                htmlFor="invite-password"
                error={fieldErrors.password?.[0]}
                hint="At least 12 characters, and not something you use elsewhere."
                required
              >
                <Input
                  id="invite-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                  iconRight={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
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
            </>
          )}

          <Button type="submit" variant="primary" size="lg" full loading={accept.isPending}>
            {needsPassword ? 'Create account and join' : 'Join workspace'}
          </Button>
        </form>

        <p className="mt-5 text-center text-[13px] text-[var(--uxe-text-secondary)]">
          Not you?{' '}
          <Link to="/login" className="font-medium text-[var(--uxe-cobalt)] hover:underline">
            Sign in with a different account
          </Link>
        </p>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--uxe-bg)] p-4">
      <main id="main" className="w-full max-w-[460px]">
        <div className="mb-6 flex justify-center">
          <BrandLockup size="md" />
        </div>
        {children}
      </main>
    </div>
  );
}

function InvalidLink({ message }: { message: string }) {
  return (
    <Card className="p-8 text-center">
      <span
        aria-hidden
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--uxe-warning-bg)] text-[var(--uxe-warning)]"
      >
        <AlertTriangle className="h-7 w-7" />
      </span>
      <h1 className="mt-4 text-[20px] font-bold text-[var(--uxe-text)]">Invitation unavailable</h1>
      <p role="alert" className="mt-2 text-[14px] text-[var(--uxe-text-secondary)]">
        {message}
      </p>
      <Button asChild variant="secondary" className="mt-6">
        <Link to="/login">Go to sign in</Link>
      </Button>
    </Card>
  );
}
