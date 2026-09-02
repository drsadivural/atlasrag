import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowRight, MessageSquare, MoreHorizontal, Plus } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  DropdownMenu,
  EmptyState,
  ErrorState,
  Input,
  LoadingRegion,
  Pagination,
  Skeleton,
  formatRelative,
  useToast,
} from '@uxe/ui';
import type { ConsultationSummary, Paginated } from '@uxe/contracts';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { StatusBadge } from '../routes/DashboardPage.js';
import { ATTENTION_QUERY_KEY } from './NeedsAttention.js';

/**
 * Every consultation the caller can see, as a page rather than a rail.
 *
 * It used to be a 300px column pinned to the left of the workspace, which is a lot of
 * permanent screen for a list somebody opens when they want to go back to something. As a
 * full-width table it can show what the rail could not — status, how many documents were
 * reviewed, who owns it — and it pages, so a workspace with three hundred consultations is
 * not a fifty-item scroll that silently stops.
 */
export function PastConsultations() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { session } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const page = positiveInt(searchParams.get('page'), 1);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (!value) next.delete(key);
    else next.set(key, value);
    // Any change to the search invalidates whichever page you were on.
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const query = useQuery<Paginated<ConsultationSummary>, ApiError>({
    queryKey: ['consultations', { q, page }],
    queryFn: () =>
      api.get<Paginated<ConsultationSummary>>(
        `/consultations?${new URLSearchParams({
          ...(q ? { q } : {}),
          page: String(page),
          pageSize: '20',
          status: 'all',
        })}`,
      ),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/consultations', { title: 'New consultation', taskMode: 'ask' }),
    onSuccess: (created) => navigate(`/consult/${created.id}`),
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(event) => setParam('q', event.target.value)}
          placeholder={t('consult.searchConversations')}
          aria-label={t('consult.searchConversations')}
          className="h-9 w-full text-[13px] sm:w-72"
        />
        <span className="ms-auto" />
        <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('consult.newConsultation')}
        </Button>
      </div>

      <Card flush className="p-3 sm:p-4">
        {query.isLoading ? (
          <LoadingRegion label={t('consult.loadingList')}>
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : query.error && !query.data ? (
          <ErrorState
            labels={{ retry: t('common.retry'), reference: t('common.reference') }}
            message={query.error.message}
            traceId={query.error.traceId}
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        ) : (
          <>
            <DataTable
              caption={t('activity.pastConsultations')}
              rows={query.data?.items ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/consult/${row.id}`)}
              empty={
                <EmptyState
                  icon={<MessageSquare className="h-6 w-6" aria-hidden />}
                  title={q ? t('activity.noConsultationsMatch') : t('activity.noConsultations')}
                  description={
                    q ? t('activity.noConsultationsMatchBody') : t('activity.noConsultationsBody')
                  }
                />
              }
              columns={[
                {
                  key: 'title',
                  header: t('table.consultation'),
                  primary: true,
                  render: (row) => (
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[14px] font-medium text-[var(--uxe-text)]">
                        {row.title}
                      </span>
                      <span className="truncate text-[12px] text-[var(--uxe-text-secondary)]">
                        {t('activity.consultationScope', {
                          documents: String(row.documentCount),
                          sources: String(row.sourceCount),
                        })}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'status',
                  header: t('table.status'),
                  render: (row) => <StatusBadge status={row.status} />,
                },
                {
                  key: 'score',
                  header: t('table.compliance'),
                  hideOnMobile: true,
                  render: (row) =>
                    row.complianceScore === null ? (
                      <span className="text-[var(--uxe-text-tertiary)]">—</span>
                    ) : (
                      <Badge
                        tone={
                          row.complianceScore >= 90
                            ? 'success'
                            : row.complianceScore >= 60
                              ? 'warning'
                              : 'danger'
                        }
                        size="sm"
                      >
                        {Math.round(row.complianceScore)}%
                      </Badge>
                    ),
                },
                {
                  key: 'owner',
                  header: t('table.owner'),
                  hideOnMobile: true,
                  render: (row) => (
                    <span className="flex items-center gap-2">
                      <Avatar name={row.ownerName} size={22} />
                      <span className="truncate">{row.ownerName}</span>
                    </span>
                  ),
                },
                {
                  key: 'when',
                  header: t('table.updated'),
                  render: (row) => (
                    <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                      {formatRelative(row.lastMessageAt ?? row.updatedAt)}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  render: (row) => (
                    <RowActions consultation={row} canDelete={canArchive(session, row)} />
                  ),
                },
              ]}
            />

            {query.data && (
              <Pagination
                page={query.data.page}
                pageSize={query.data.pageSize}
                total={query.data.total}
                totalPages={query.data.totalPages}
                onPageChange={(next) => setParam('page', String(next))}
              />
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * Deleting is offered, but the server decides.
 *
 * Hiding the control for somebody who would be refused saves them a pointless click; it is
 * not the check. `DELETE /consultations/:id` enforces ownership and permission itself, as
 * every route here does.
 */
function RowActions({
  consultation,
  canDelete,
}: {
  consultation: ConsultationSummary;
  canDelete: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const { push } = useToast();
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: () => api.delete(`/consultations/${consultation.id}`),
    onSuccess: () => {
      push({
        tone: 'success',
        title: t('consult.moved'),
        description: t('consult.movedBody', { title: consultation.title }),
      });
      void queryClient.invalidateQueries({ queryKey: ['consultations'] });
      void queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY });
      setConfirming(false);
    },
    /*
     * This had no failure branch at all.
     *
     * A refused delete answered with a 404 and nothing caught it, so the row stayed where
     * it was and the person was told "Consultation not found" about something still on
     * their screen. The server now refuses with a reason; this shows the reason.
     */
    onError: (error: ApiError) => {
      push({ tone: 'error', title: t('consult.couldNotArchive'), description: error.message });
      setConfirming(false);
    },
  });

  return (
    <>
      <DropdownMenu
        label={`Actions for ${consultation.title}`}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${consultation.title}`}
            // The row itself navigates, so the menu must not also trigger that.
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
          </Button>
        }
        items={[
          {
            label: 'Open',
            icon: <ArrowRight className="h-4 w-4" aria-hidden />,
            onSelect: () => navigate(`/consult/${consultation.id}`),
          },
          ...(canDelete
            ? [
                {
                  label: t('consult.moveToArchive'),
                  icon: <Archive className="h-4 w-4" aria-hidden />,
                  onSelect: () => setConfirming(true),
                  destructive: true,
                  separatorBefore: true,
                },
              ]
            : []),
        ]}
      />

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('consult.moveToArchive')}
        description={t('consult.moveToArchiveBody', { title: consultation.title })}
        confirmLabel={t('consult.moveToArchive')}
        cancelLabel={t('common.cancel')}
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

/**
 * Whether this person may archive this consultation.
 *
 * Mirrors the server exactly: the permission, and then either owning it or holding
 * `workspace:update`. The old version checked only the permission, which every member
 * holds — so a reviewer, who can see the whole workspace, was offered the action on all
 * three hundred consultations and refused on every one that was not theirs.
 */
function canArchive(
  session: ReturnType<typeof useSession>['session'],
  consultation: ConsultationSummary,
): boolean {
  if (!session?.permissions.includes('consultation:delete')) return false;
  return (
    consultation.ownerId === session.user.id || session.permissions.includes('workspace:update')
  );
}

/** Anything in the URL is text, not a number: `Number('')` is 0 and `Number('x')` is NaN. */
function positiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
