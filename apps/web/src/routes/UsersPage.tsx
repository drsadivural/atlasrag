import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Mail, ShieldCheck, UserPlus, Users, UserX } from 'lucide-react';
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
  Select,
  Skeleton,
  formatRelative,
  useToast,
} from '@uxe/ui';
import { ROLE_LABELS, type Role, type WorkspaceUser } from '@uxe/contracts';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { PageHeader } from '../components/PageHeader.js';

export function UsersPage() {
  const { t } = useI18n();
  const { can, session } = useSession();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [suspending, setSuspending] = useState<WorkspaceUser | null>(null);

  const query = useQuery<WorkspaceUser[], ApiError>({
    queryKey: ['users'],
    queryFn: () => api.get<WorkspaceUser[]>('/users'),
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
          can('member:invite') ? (
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden />
              {t('users.invite')}
            </Button>
          ) : null
        }
      />

      <Card flush className="mt-5 p-3 sm:p-4">
        {query.isLoading ? (
          <LoadingRegion label="Loading members">
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : query.error ? (
          <ErrorState message={query.error.message} traceId={query.error.traceId} onRetry={() => void query.refetch()} />
        ) : (
          <DataTable
            caption="Workspace members"
            rows={query.data ?? []}
            rowKey={(row) => row.id}
            empty={<EmptyState title="No members" description="Invite a colleague to collaborate." />}
            columns={[
              {
                key: 'name',
                header: t('users.name'),
                primary: true,
                render: (row) => (
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={row.fullName} src={row.avatarUrl} size={32} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-[var(--uxe-text)]">{row.fullName}</span>
                      <span className="block truncate text-[12px] text-[var(--uxe-text-secondary)]">{row.email}</span>
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
                      onValueChange={(value) => update.mutate({ id: row.id, patch: { role: value } })}
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
                    tone={row.status === 'active' ? 'success' : row.status === 'invited' ? 'info' : 'danger'}
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
                    <Badge tone="success" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden />}>
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
                render: (row) => <span className="tabular-nums">{row.accessibleSourceCount}</span>,
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
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.fullName}`}>
                        <KeyRound className="h-4 w-4" aria-hidden />
                      </Button>
                    }
                    items={[
                      {
                        label: t('users.revokeSessions'),
                        icon: <KeyRound className="h-4 w-4" aria-hidden />,
                        onSelect: () => update.mutate({ id: row.id, patch: { revokeSessions: true } }),
                        disabled: !can('member:update'),
                        disabledReason: 'Your role cannot change member access',
                      },
                      {
                        label: row.status === 'suspended' ? t('users.reactivate') : t('users.suspend'),
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
                    ]}
                  />
                ),
              },
            ]}
          />
        )}
      </Card>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <ConfirmDialog
        open={suspending !== null}
        onOpenChange={(open) => !open && setSuspending(null)}
        title={`Suspend ${suspending?.fullName ?? ''}?`}
        description="They lose access immediately and every active session is revoked. You can reactivate them later."
        confirmLabel={t('users.suspend')}
        destructive
        loading={update.isPending}
        onConfirm={() => suspending && update.mutate({ id: suspending.id, patch: { status: 'suspended' } })}
      />
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [message, setMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const invite = useMutation({
    mutationFn: () => api.post('/users/invite', { email, role, groupIds: [], message: message || undefined }),
    onSuccess: () => {
      push({ tone: 'success', title: 'Invitation sent', description: `${email} has been invited.` });
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      setEmail('');
      setMessage('');
      setFieldErrors({});
      onOpenChange(false);
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
      description="They receive an email with a single-use link that expires in seven days."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => invite.mutate()} loading={invite.isPending} disabled={!email.trim()}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('auth.workEmail')} htmlFor="invite-email" error={fieldErrors.email?.[0]} required>
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
              { value: 'read_only', label: ROLE_LABELS.read_only, description: 'Can view but not change anything.' },
              { value: 'member', label: ROLE_LABELS.member, description: 'Can run consultations.' },
              { value: 'reviewer', label: ROLE_LABELS.reviewer, description: 'Can approve findings and read every consultation.' },
              { value: 'knowledge_manager', label: ROLE_LABELS.knowledge_manager, description: 'Owns the knowledge base.' },
              { value: 'consultant', label: ROLE_LABELS.consultant, description: 'Full client-facing workflow.' },
              { value: 'admin', label: ROLE_LABELS.admin, description: 'Manages members and settings.' },
            ]}
          />
        </Field>

        <Field label="Message (optional)" htmlFor="invite-message">
          <Input
            id="invite-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Joining us on the Tower A review"
          />
        </Field>
      </div>
    </Dialog>
  );
}
