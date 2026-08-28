import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InviteUserResponse } from '@uxe/contracts';
import { KeyRound, Mail, Pencil, ShieldCheck, Trash2, UserPlus, Users, UserX } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  DropdownMenu,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingRegion,
  SegmentedControl,
  Select,
  Skeleton,
  formatRelative,
  useToast,
} from '@uxe/ui';
import {
  ROLE_LABELS,
  type PasswordResetResponse,
  type PlatformUser,
  type PlatformUsersResponse,
  type Role,
  type WorkspaceUser,
} from '@uxe/contracts';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * Every account on the deployment, for somebody who administers accounts.
 *
 * A separate table rather than a mode of the workspace one, because the two answer
 * different questions. "Who is in this workspace" has a single role and status that mean
 * something; across the deployment somebody can be an Owner in one workspace and read-only
 * in another, so the row is about the person and the memberships are a list.
 *
 * Nothing here reaches tenant data. The API behind it administers identities only — a
 * platform administrator who wants to read a workspace's documents has to be given a
 * membership like anybody else.
 */
function PlatformUsers() {
  const { t } = useI18n();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const { session } = useSession();
  const [search, setSearch] = useState('');
  const [issued, setIssued] = useState<{ email: string; url: string } | null>(null);

  const query = useQuery<PlatformUsersResponse, ApiError>({
    queryKey: ['platform-users', search],
    queryFn: () =>
      api.get<PlatformUsersResponse>(
        `/platform/users?pageSize=100${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ''}`,
      ),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch(`/platform/users/${id}`, patch),
    onSuccess: () => {
      push({ tone: 'success', title: 'Account updated' });
      void queryClient.invalidateQueries({ queryKey: ['platform-users'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not update the account', description: error.message }),
  });

  const reset = useMutation({
    mutationFn: (user: PlatformUser) =>
      api
        .post<PasswordResetResponse>(`/platform/users/${user.id}/password-reset`)
        .then((result) => ({ result, user })),
    onSuccess: ({ result, user }) => {
      if (result.delivery.status === 'sent') {
        push({
          tone: 'success',
          title: 'Reset link sent',
          description: `${user.email} can choose a new password from the link in their inbox.`,
        });
        return;
      }
      push({
        tone: 'warning',
        title: 'No email was sent',
        description: result.delivery.detail ?? 'Send the link below to them yourself.',
      });
      if (result.delivery.resetUrl) setIssued({ email: user.email, url: result.delivery.resetUrl });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not issue a reset', description: error.message }),
  });

  return (
    <Card flush className="mt-4 p-3 sm:p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('users.searchPlaceholder')}
          className="max-w-xs"
          aria-label={t('users.searchAccounts')}
        />
        <span className="text-[13px] text-[var(--uxe-text-secondary)]">
          {query.data ? `${query.data.total} account(s)` : ''}
        </span>
      </div>

      {issued && (
        <div
          role="status"
          className="mb-3 flex flex-col gap-2 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] p-3"
        >
          <p className="text-[13px] font-semibold text-[var(--uxe-warning-text)]">
            Reset link for {issued.email}
          </p>
          <code className="overflow-x-auto rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface)] px-2 py-1.5 font-[family-name:var(--uxe-font-mono)] text-[12px] break-all">
            {issued.url}
          </code>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard
                  .writeText(issued.url)
                  .then(() => push({ tone: 'success', title: 'Link copied' }))
                  .catch(() => push({ tone: 'error', title: 'Could not copy' }));
              }}
            >
              {t('users.copyLink')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {query.isLoading ? (
        <LoadingRegion label={t('users.loadingAccounts')}>
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </LoadingRegion>
      ) : query.error && !query.data ? (
        <ErrorState
          labels={{ retry: t('common.retry'), reference: t('common.reference') }}
          message={query.error.message}
          traceId={query.error.traceId}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <DataTable
          caption={t('users.everyAccount')}
          rows={query.data?.items ?? []}
          rowKey={(row) => row.id}
          empty={
            <EmptyState title={t('users.noAccounts')} description={t('users.noAccountsHint')} />
          }
          columns={[
            {
              key: 'name',
              header: 'Account',
              primary: true,
              render: (row) => (
                <div className="flex items-center gap-3">
                  <Avatar name={row.fullName} src={row.avatarUrl} size={32} />
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-[var(--uxe-text)]">
                      {row.fullName}
                    </p>
                    <p className="truncate text-[12px] text-[var(--uxe-text-secondary)]">
                      {row.email}
                    </p>
                  </div>
                </div>
              ),
            },
            {
              key: 'workspaces',
              header: 'Workspaces',
              render: (row) =>
                row.memberships.length === 0 ? (
                  <span className="text-[13px] text-[var(--uxe-text-secondary)]">None</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {row.memberships.map((m) => (
                      <Badge key={m.workspaceId} tone="neutral" size="sm">
                        {m.workspaceName} · {ROLE_LABELS[m.role]}
                        {m.status !== 'active' ? ` (${m.status})` : ''}
                      </Badge>
                    ))}
                  </div>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row) => (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={row.status === 'active' ? 'success' : 'danger'} size="sm">
                    {row.status === 'active' ? 'Active' : 'Suspended'}
                  </Badge>
                  {row.isPlatformAdmin && (
                    <Badge tone="brand" size="sm" icon={<ShieldCheck className="h-3 w-3" />}>
                      {t('users.platformAdmin')}
                    </Badge>
                  )}
                  {!row.hasPassword && (
                    <Badge tone="warning" size="sm">
                      {t('users.noPassword')}
                    </Badge>
                  )}
                </div>
              ),
            },
            {
              key: 'actions',
              header: '',
              align: 'right',
              render: (row) => {
                const isSelf = row.id === session?.user.id;
                return (
                  <DropdownMenu
                    label={`Actions for ${row.fullName}`}
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${row.fullName}`}
                      >
                        <KeyRound className="h-4 w-4" aria-hidden />
                      </Button>
                    }
                    items={[
                      {
                        label: 'Send a password reset link',
                        icon: <KeyRound className="h-4 w-4" aria-hidden />,
                        onSelect: () => reset.mutate(row),
                      },
                      {
                        label:
                          row.status === 'suspended' ? 'Reactivate account' : 'Suspend account',
                        icon: <UserX className="h-4 w-4" aria-hidden />,
                        onSelect: () =>
                          update.mutate({
                            id: row.id,
                            patch: { status: row.status === 'suspended' ? 'active' : 'suspended' },
                          }),
                        destructive: row.status !== 'suspended',
                        disabled: isSelf,
                        disabledReason: 'Change your own account from your profile',
                        separatorBefore: true,
                      },
                      {
                        label: row.isPlatformAdmin
                          ? 'Revoke platform administration'
                          : 'Make platform administrator',
                        icon: <ShieldCheck className="h-4 w-4" aria-hidden />,
                        onSelect: () =>
                          update.mutate({
                            id: row.id,
                            patch: { isPlatformAdmin: !row.isPlatformAdmin },
                          }),
                        destructive: row.isPlatformAdmin,
                        disabled: isSelf,
                        disabledReason: 'You cannot change your own platform authority',
                        separatorBefore: true,
                      },
                    ]}
                  />
                );
              },
            },
          ]}
        />
      )}
    </Card>
  );
}

/**
 * Creating an account outright.
 *
 * The difference from an invitation is who chooses the password. Left blank — which is the
 * default and the better path — the account is created and a link is sent for them to
 * choose their own, and nobody else ever knows it. Typed here, they can sign in at once
 * and the administrator knows their password, which is sometimes what a situation needs
 * and is said plainly rather than left to be discovered.
 */
function AddUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [issued, setIssued] = useState<{ email: string; url: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ user: PlatformUser; delivery: PasswordResetResponse['delivery'] | null }>(
        '/platform/users',
        { email, fullName, role, ...(password ? { password } : {}) },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['platform-users'] });
      setFieldErrors({});

      if (password) {
        push({
          tone: 'success',
          title: 'Account created',
          description: `${email} can sign in with the password you set.`,
        });
        close();
        return;
      }

      if (result.delivery?.status === 'sent') {
        push({
          tone: 'success',
          title: 'Account created',
          description: `${email} has been sent a link to choose a password.`,
        });
        close();
        return;
      }

      push({
        tone: 'warning',
        title: 'Account created, but no email was sent',
        description: result.delivery?.detail ?? 'Send the link below to them yourself.',
      });
      if (result.delivery?.resetUrl) setIssued({ email, url: result.delivery.resetUrl });
    },
    onError: (error: ApiError) => {
      setFieldErrors(error.fieldErrors);
      push({ tone: 'error', title: 'Could not create the account', description: error.message });
    },
  });

  function close() {
    setEmail('');
    setFullName('');
    setPassword('');
    setIssued(null);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={t('users.addTitle')}
      description={t('users.addHint')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!email.trim() || !fullName.trim()}
            onClick={() => create.mutate()}
          >
            {t('users.createAccount')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {issued && (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] p-3"
          >
            <p className="text-[13px] font-semibold text-[var(--uxe-warning-text)]">
              {issued.email} was created, but no email was sent
            </p>
            <code className="overflow-x-auto rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface)] px-2 py-1.5 font-[family-name:var(--uxe-font-mono)] text-[12px] break-all">
              {issued.url}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(issued.url)
                    .then(() => push({ tone: 'success', title: 'Link copied' }))
                    .catch(() => push({ tone: 'error', title: 'Could not copy' }));
                }}
              >
                {t('users.copyLink')}
              </Button>
              <Button variant="ghost" size="sm" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        )}

        <Field
          label={t('auth.workEmail')}
          htmlFor="add-email"
          error={fieldErrors.email?.[0]}
          required
        >
          <Input
            id="add-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            invalid={Boolean(fieldErrors.email)}
            iconLeft={<Mail className="h-4 w-4" aria-hidden />}
          />
        </Field>

        <Field
          label={t('auth.fullName')}
          htmlFor="add-name"
          error={fieldErrors.fullName?.[0]}
          required
        >
          <Input
            id="add-name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            invalid={Boolean(fieldErrors.fullName)}
          />
        </Field>

        <Field label={t('users.role')} htmlFor="add-role">
          <Select
            value={role}
            onValueChange={(value) => setRole(value as Role)}
            ariaLabel={t('users.role')}
            className="w-full"
            options={EDITABLE_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }))}
          />
        </Field>

        <Field
          label={t('users.passwordOptional')}
          htmlFor="add-password"
          hint="Leave blank and they are sent a link to choose their own, which nobody else ever sees. Type one and they can sign in at once — but you will know it, so ask them to change it."
          error={fieldErrors.password?.[0]}
        >
          <Input
            id="add-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t('users.sendLinkInstead')}
            invalid={Boolean(fieldErrors.password)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

/** Owner is excluded: transferring ownership is its own operation, not a dropdown. */
const EDITABLE_ROLES: Role[] = [
  'read_only',
  'member',
  'reviewer',
  'knowledge_manager',
  'consultant',
  'admin',
];

export function UsersPage() {
  const { t } = useI18n();
  const { can, session } = useSession();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [suspending, setSuspending] = useState<WorkspaceUser | null>(null);
  const [editing, setEditing] = useState<WorkspaceUser | null>(null);
  const [removing, setRemoving] = useState<WorkspaceUser | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [view, setView] = useState<'workspace' | 'platform'>('workspace');
  const isPlatformAdmin = session?.user.isPlatformAdmin === true;

  const query = useQuery<WorkspaceUser[], ApiError>({
    queryKey: ['users'],
    queryFn: () => api.get<WorkspaceUser[]>('/users'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      push({ tone: 'success', title: 'Member removed' });
      setRemoving(null);
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not remove them', description: error.message }),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      api.patch(`/users/${id}`, patch),
    onSuccess: () => {
      push({ tone: 'success', title: 'Member updated' });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setSuspending(null);
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not update member', description: error.message }),
  });

  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        icon={<Users className="h-5 w-5" aria-hidden />}
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isPlatformAdmin && (
              <Button variant="secondary" onClick={() => setAddOpen(true)}>
                <UserPlus className="h-4 w-4" aria-hidden />
                {t('users.addUser')}
              </Button>
            )}
            {can('member:invite') && (
              <Button variant="primary" onClick={() => setInviteOpen(true)}>
                <Mail className="h-4 w-4" aria-hidden />
                {t('users.invite')}
              </Button>
            )}
          </div>
        }
      />

      {isPlatformAdmin && (
        <div className="mt-4">
          <SegmentedControl
            value={view}
            onValueChange={(value) => setView(value as 'workspace' | 'platform')}
            ariaLabel={t('users.whichAccounts')}
            options={[
              { value: 'workspace', label: t('users.thisWorkspace') },
              { value: 'platform', label: t('users.everyone') },
            ]}
          />
        </div>
      )}

      {view === 'platform' ? (
        <PlatformUsers />
      ) : (
        <>
          <Card flush className="mt-5 p-3 sm:p-4">
            {query.isLoading ? (
              <LoadingRegion label={t('users.loadingMembers')}>
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              </LoadingRegion>
            ) : query.error && !query.data ? (
              <ErrorState
                labels={{ retry: t('common.retry'), reference: t('common.reference') }}
                message={query.error.message}
                traceId={query.error.traceId}
                onRetry={() => void query.refetch()}
              />
            ) : (
              <DataTable
                caption={t('users.workspaceMembers')}
                rows={query.data ?? []}
                rowKey={(row) => row.id}
                empty={
                  <EmptyState title={t('users.noMembers')} description={t('users.noMembersHint')} />
                }
                columns={[
                  {
                    key: 'name',
                    header: t('users.name'),
                    primary: true,
                    render: (row) => (
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={row.fullName} src={row.avatarUrl} size={32} />
                        <span className="min-w-0">
                          <span className="block truncate font-medium text-[var(--uxe-text)]">
                            {row.fullName}
                          </span>
                          <span className="block truncate text-[12px] text-[var(--uxe-text-secondary)]">
                            {row.email}
                          </span>
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: 'role',
                    header: t('users.role'),
                    render: (row) =>
                      can('member:update') && row.id !== session?.user.id ? (
                        <Select
                          value={row.role}
                          onValueChange={(value) =>
                            update.mutate({ id: row.id, patch: { role: value } })
                          }
                          ariaLabel={`Role for ${row.fullName}`}
                          size="sm"
                          options={(Object.keys(ROLE_LABELS) as Role[]).map((role) => ({
                            value: role,
                            label: ROLE_LABELS[role],
                          }))}
                        />
                      ) : (
                        <Badge tone="neutral" size="sm">
                          {ROLE_LABELS[row.role]}
                        </Badge>
                      ),
                  },
                  {
                    key: 'status',
                    header: t('users.status'),
                    render: (row) => (
                      <Badge
                        tone={
                          row.status === 'active'
                            ? 'success'
                            : row.status === 'invited'
                              ? 'info'
                              : 'danger'
                        }
                        size="sm"
                      >
                        {row.status}
                      </Badge>
                    ),
                  },
                  {
                    key: 'mfa',
                    header: t('users.mfa'),
                    render: (row) =>
                      row.mfaEnabled ? (
                        <Badge
                          tone="success"
                          size="sm"
                          icon={<ShieldCheck className="h-3 w-3" aria-hidden />}
                        >
                          On
                        </Badge>
                      ) : (
                        <Badge tone="neutral" size="sm">
                          Off
                        </Badge>
                      ),
                  },
                  {
                    key: 'sources',
                    header: t('users.sources'),
                    align: 'right',
                    render: (row) => (
                      <span className="tabular-nums">{row.accessibleSourceCount}</span>
                    ),
                  },
                  {
                    key: 'lastActive',
                    header: t('users.lastActive'),
                    render: (row) => (
                      <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                        {row.lastActiveAt ? formatRelative(row.lastActiveAt) : '—'}
                      </span>
                    ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    hideOnMobile: true,
                    render: (row) => (
                      <DropdownMenu
                        label={`Actions for ${row.fullName}`}
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${row.fullName}`}
                          >
                            <KeyRound className="h-4 w-4" aria-hidden />
                          </Button>
                        }
                        items={[
                          {
                            label: t('users.revokeSessions'),
                            icon: <KeyRound className="h-4 w-4" aria-hidden />,
                            onSelect: () =>
                              update.mutate({ id: row.id, patch: { revokeSessions: true } }),
                            disabled: !can('member:update'),
                            disabledReason: 'Your role cannot change member access',
                          },
                          {
                            label: t('common.edit'),
                            icon: <Pencil className="h-4 w-4" aria-hidden />,
                            onSelect: () => setEditing(row),
                            disabled: !can('member:update'),
                            disabledReason: 'Your role cannot change member access',
                            separatorBefore: true,
                          },
                          {
                            label:
                              row.status === 'suspended'
                                ? t('users.reactivate')
                                : t('users.suspend'),
                            icon: <UserX className="h-4 w-4" aria-hidden />,
                            onSelect: () =>
                              row.status === 'suspended'
                                ? update.mutate({ id: row.id, patch: { status: 'active' } })
                                : setSuspending(row),
                            destructive: row.status !== 'suspended',
                            disabled: !can('member:suspend') || row.id === session?.user.id,
                            disabledReason:
                              row.id === session?.user.id
                                ? 'You cannot suspend your own account'
                                : 'Your role cannot suspend members',
                            separatorBefore: true,
                          },
                          {
                            label: t('users.remove'),
                            icon: <Trash2 className="h-4 w-4" aria-hidden />,
                            onSelect: () => setRemoving(row),
                            destructive: true,
                            disabled: !can('member:remove') || row.id === session?.user.id,
                            disabledReason:
                              row.id === session?.user.id
                                ? 'You cannot remove your own account'
                                : 'Your role cannot remove members',
                          },
                        ]}
                      />
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </>
      )}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <AddUserDialog open={addOpen} onOpenChange={setAddOpen} />

      <EditMemberDialog member={editing} onOpenChange={(open) => !open && setEditing(null)} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.fullName ?? ''} from this workspace?`}
        description={`${removing?.email ?? 'They'} loses access immediately, every session is revoked, and their group memberships here are cleared. Their name stays on the audit trail. You can invite them again later, but nothing they had is restored.`}
        confirmLabel={t('users.remove')}
        destructive
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
      />

      <ConfirmDialog
        open={suspending !== null}
        onOpenChange={(open) => !open && setSuspending(null)}
        title={`Suspend ${suspending?.fullName ?? ''}?`}
        description="They lose access immediately and every active session is revoked. You can reactivate them later."
        confirmLabel={t('users.suspend')}
        destructive
        loading={update.isPending}
        onConfirm={() =>
          suspending && update.mutate({ id: suspending.id, patch: { status: 'suspended' } })
        }
      />
    </div>
  );
}

/**
 * Changing what somebody can do here.
 *
 * Role and status only. A name and an address belong to the person, not to the workspace
 * that admitted them, and an administrator quietly editing either would produce an audit
 * trail attributing actions to a name its owner never chose.
 */
function EditMemberDialog({
  member,
  onOpenChange,
}: {
  member: WorkspaceUser | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { session } = useSession();
  const [role, setRole] = useState<Role>('member');
  const [status, setStatus] = useState<WorkspaceUser['status']>('active');

  // Re-seeded during render on the open transition: an effect would show the previous
  // member's role for a frame before correcting itself.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (member && member.id !== openedFor) {
    setOpenedFor(member.id);
    setRole(member.role);
    setStatus(member.status === 'suspended' ? 'suspended' : 'active');
  }
  if (!member && openedFor !== null) setOpenedFor(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/users/${member?.id ?? ''}`, {
        role,
        // An invitation that has not been accepted has no active/suspended state to set,
        // and sending one would activate a membership nobody has claimed.
        ...(member?.status === 'invited' ? {} : { status }),
      }),
    onSuccess: () => {
      push({
        tone: 'success',
        title: 'Member updated',
        description:
          role !== member?.role
            ? 'Their sessions were revoked so the new role takes effect immediately.'
            : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onOpenChange(false);
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not update them', description: error.message }),
  });

  const isSelf = member?.id === session?.user.id;

  return (
    <Dialog
      open={member !== null}
      onOpenChange={onOpenChange}
      title={member ? `Edit ${member.fullName}` : 'Edit member'}
      description={member?.email}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('users.role')} htmlFor="edit-role" hint={t('users.roleChangeHint')}>
          <Select
            value={role}
            onValueChange={(value) => setRole(value as Role)}
            ariaLabel={t('users.role')}
            className="w-full"
            options={EDITABLE_ROLES.map((value) => ({
              value,
              label: ROLE_LABELS[value],
            }))}
          />
        </Field>

        {member?.status !== 'invited' && (
          <Field
            label={t('users.status')}
            htmlFor="edit-status"
            hint={isSelf ? 'You cannot suspend your own account.' : undefined}
          >
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as WorkspaceUser['status'])}
              ariaLabel={t('users.status')}
              className="w-full"
              disabled={isSelf}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'suspended', label: 'Suspended' },
              ]}
            />
          </Field>
        )}

        {member?.status === 'invited' && (
          <p className="text-[13px] text-[var(--uxe-text-secondary)]">
            {t('users.notAcceptedYet')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  /*
   * The link, kept on screen when nothing was emailed.
   *
   * An invitation is a membership and a message. The membership always succeeds; the
   * message needs a mail transport this deployment may not have, and saying "invitation
   * sent" regardless is how somebody waits a week for an email that was written to a log
   * file. When it was not sent the dialog stays open holding the link to pass on.
   */
  const [undelivered, setUndelivered] = useState<{ email: string; url: string } | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      api.post<InviteUserResponse>('/users/invite', {
        email,
        role,
        groupIds: [],
        message: message || undefined,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setFieldErrors({});

      if (result.delivery.status === 'sent') {
        push({
          tone: 'success',
          title: 'Invitation sent',
          description: `${email} has been invited.`,
        });
        setEmail('');
        setMessage('');
        onOpenChange(false);
        return;
      }

      push({
        tone: 'warning',
        title: 'Invited, but no email was sent',
        description: result.delivery.detail ?? 'Send the link below to them yourself.',
      });
      if (result.delivery.acceptUrl) {
        setUndelivered({ email, url: result.delivery.acceptUrl });
      }
    },
    onError: (error: ApiError) => {
      setFieldErrors(error.fieldErrors);
      push({ tone: 'error', title: 'Invitation failed', description: error.message });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('users.invite')}
      description={t('users.inviteHint')}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => invite.mutate()}
            loading={invite.isPending}
            disabled={!email.trim()}
          >
            {t('users.sendInvitation')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {undelivered && (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] p-3"
          >
            <p className="text-[13px] font-semibold text-[var(--uxe-warning-text)]">
              {undelivered.email} is invited, but no email was sent
            </p>
            <p className="text-[13px] text-[var(--uxe-text)]">
              This deployment has no mail transport configured. Send them this link — it is
              single-use and expires in seven days.
            </p>
            <code className="overflow-x-auto rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface)] px-2 py-1.5 font-[family-name:var(--uxe-font-mono)] text-[12px] break-all">
              {undelivered.url}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(undelivered.url)
                    .then(() => push({ tone: 'success', title: 'Link copied' }))
                    .catch(() =>
                      push({
                        tone: 'error',
                        title: 'Could not copy',
                        description: 'Select the link above and copy it by hand.',
                      }),
                    );
                }}
              >
                {t('users.copyLink')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setUndelivered(null);
                  setEmail('');
                  setMessage('');
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}

        <Field
          label={t('auth.workEmail')}
          htmlFor="invite-email"
          error={fieldErrors.email?.[0]}
          required
        >
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('auth.emailPlaceholder')}
            invalid={Boolean(fieldErrors.email)}
            iconLeft={<Mail className="h-4 w-4" aria-hidden />}
          />
        </Field>

        <Field label={t('users.role')} htmlFor="invite-role">
          <Select
            value={role}
            onValueChange={(value) => setRole(value as Role)}
            ariaLabel={t('users.role')}
            className="w-full"
            options={[
              {
                value: 'read_only',
                label: ROLE_LABELS.read_only,
                description: 'Can view but not change anything.',
              },
              { value: 'member', label: ROLE_LABELS.member, description: 'Can run consultations.' },
              {
                value: 'reviewer',
                label: ROLE_LABELS.reviewer,
                description: 'Can approve findings and read every consultation.',
              },
              {
                value: 'knowledge_manager',
                label: ROLE_LABELS.knowledge_manager,
                description: 'Owns the knowledge base.',
              },
              {
                value: 'consultant',
                label: ROLE_LABELS.consultant,
                description: 'Full client-facing workflow.',
              },
              {
                value: 'admin',
                label: ROLE_LABELS.admin,
                description: 'Manages members and settings.',
              },
            ]}
          />
        </Field>

        <Field label={t('users.messageOptional')} htmlFor="invite-message">
          <Input
            id="invite-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={t('users.messagePlaceholder')}
          />
        </Field>
      </div>
    </Dialog>
  );
}
