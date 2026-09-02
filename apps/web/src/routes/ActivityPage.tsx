import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Download, ShieldAlert, XCircle } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  FilterChip,
  Input,
  LoadingRegion,
  Pagination,
  Skeleton,
  SlideOver,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  formatDateTime,
} from '@uxe/ui';
import type { AuditEvent, Paginated } from '@uxe/contracts';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { PageHeader } from '../components/PageHeader.js';
import { DetailField, NeedsAttention, useAttention } from '../components/NeedsAttention.js';
import { PastConsultations } from '../components/PastConsultations.js';

const TABS = ['attention', 'consultations', 'audit'] as const;
type Tab = (typeof TABS)[number];

const CATEGORIES = [
  'all',
  'auth',
  'permission',
  'source',
  'consultation',
  'review',
  'artifact',
  'configuration',
  'deletion',
  'export',
] as const;

export function ActivityPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const attention = useAttention();
  const [openEvent, setOpenEvent] = useState<AuditEvent | null>(null);

  /*
   * Three things belong on this page and only one fits above the fold, so they are tabs.
   *
   * The order is what a person is most likely to want: what is outstanding, then what has
   * been done, then the record of everything. The bell links here without a tab, which
   * lands on the first — which is what it promises.
   *
   * The choice is in the URL so it survives a reload and can be linked to, and unknown
   * values fall back rather than rendering nothing.
   */
  const requestedTab = searchParams.get('tab');
  const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : 'attention';

  const category = searchParams.get('category') ?? 'all';
  const result = searchParams.get('result') ?? 'all';
  const q = searchParams.get('q') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all') next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  /*
   * The audit log is for people who may read it; what needs attention is for everybody.
   *
   * The bell points every role at this page, and a consultant holds no audit permission —
   * so asking for the log regardless would greet them with a red error about a record they
   * were never entitled to see, next to the list they actually came for. The page shows
   * each half to whoever may have it.
   */
  const mayReadAudit = can('audit:read');

  const query = useQuery<Paginated<AuditEvent>, ApiError>({
    // Only when the tab showing it is the one on screen: the other two tabs never display
    // an audit row, so asking for twenty-five of them is a request with no reader.
    enabled: mayReadAudit && tab === 'audit',
    queryKey: ['audit', { category, result, q, page }],
    queryFn: () =>
      api.get<Paginated<AuditEvent>>(
        `/audit-events?${new URLSearchParams({
          category,
          result,
          ...(q ? { q } : {}),
          page: String(page),
          pageSize: '25',
        })}`,
      ),
  });

  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        icon={<Activity className="h-5 w-5" aria-hidden />}
        title={t('activity.title')}
        subtitle={t('activity.subtitle')}
        actions={
          tab === 'audit' && can('audit:export') ? (
            <Button asChild variant="secondary">
              {/* Server-rendered CSV so the export matches exactly what the filters select. */}
              <a href={`/api/v1/audit-events/export?category=${category}&result=${result}`}>
                <Download className="h-4 w-4" aria-hidden />
                {t('activity.export')}
              </a>
            </Button>
          ) : null
        }
      />

      <Tabs value={tab} onValueChange={(next) => setParam('tab', next)} className="mt-5">
        <TabList ariaLabel={t('activity.title')}>
          <Tab value="attention" count={attention.data?.items?.length}>
            {t('activity.needsAttentionTab')}
          </Tab>
          <Tab value="consultations">{t('activity.pastConsultations')}</Tab>
          {mayReadAudit && <Tab value="audit">{t('activity.auditLogTab')}</Tab>}
        </TabList>

        <TabPanel value="attention" className="mt-4">
          <NeedsAttention />
        </TabPanel>

        <TabPanel value="consultations" className="mt-4">
          <PastConsultations />
        </TabPanel>

        <TabPanel value="audit" className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label={t('activity.filterCategory')}
              className="flex min-w-0 flex-1 flex-wrap gap-2"
            >
              {CATEGORIES.map((value) => (
                <FilterChip
                  key={value}
                  active={category === value}
                  onClick={() => setParam('category', value)}
                  label={value === 'all' ? t('common.all') : value.replace(/_/g, ' ')}
                />
              ))}
            </div>
            <Input
              value={q}
              onChange={(event) => setParam('q', event.target.value)}
              placeholder={t('common.search')}
              aria-label={t('activity.search')}
              className="h-9 w-full text-[13px] sm:w-64"
            />
          </div>

          <Card flush className="mt-4 p-3 sm:p-4">
            {query.isLoading ? (
              <LoadingRegion label={t('activity.loading')}>
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
              />
            ) : (
              <>
                <DataTable
                  caption={t('activity.tableCaption')}
                  rows={query.data?.items ?? []}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => setOpenEvent(row)}
                  empty={
                    <EmptyState
                      icon={<Activity className="h-6 w-6" aria-hidden />}
                      title={t('activity.emptyTitle')}
                      description={t('activity.emptyBody')}
                    />
                  }
                  columns={[
                    {
                      key: 'summary',
                      header: t('table.event'),
                      primary: true,
                      render: (row) => (
                        <span className="flex min-w-0 items-start gap-2.5">
                          <span aria-hidden className="mt-0.5">
                            {row.result === 'success' ? (
                              <CheckCircle2 className="h-4 w-4 text-[var(--uxe-success)]" />
                            ) : row.result === 'denied' ? (
                              <ShieldAlert className="h-4 w-4 text-[var(--uxe-warning)]" />
                            ) : (
                              <XCircle className="h-4 w-4 text-[var(--uxe-danger)]" />
                            )}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[14px] text-[var(--uxe-text)]">
                              {row.summary}
                            </span>
                            <span className="block font-[family-name:var(--uxe-font-mono)] text-[11px] text-[var(--uxe-text-tertiary)]">
                              {row.action}
                            </span>
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: 'actor',
                      header: t('activity.actor'),
                      render: (row) => (
                        <span className="flex items-center gap-2">
                          <Avatar name={row.actorName} size={22} />
                          <span className="truncate">{row.actorName}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'category',
                      header: t('table.category'),
                      render: (row) => (
                        <Badge tone="neutral" size="sm">
                          {row.category}
                        </Badge>
                      ),
                    },
                    {
                      key: 'when',
                      header: t('activity.when'),
                      render: (row) => (
                        <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                          {formatDateTime(row.at)}
                        </span>
                      ),
                    },
                    {
                      key: 'trace',
                      header: t('activity.trace'),
                      hideOnMobile: true,
                      render: (row) => (
                        <span className="font-[family-name:var(--uxe-font-mono)] text-[11px] text-[var(--uxe-text-tertiary)]">
                          {row.traceId.slice(0, 8)}
                        </span>
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
        </TabPanel>
      </Tabs>

      <AuditEventPanel event={openEvent} onOpenChange={(next) => !next && setOpenEvent(null)} />
    </div>
  );
}

/**
 * One audit event, in full.
 *
 * The table shows what fits in a row. Everything the record actually holds — who, from
 * where, against what, and the trace that ties it to the request — is here, because an
 * audit line is only worth keeping if the whole of it can be read.
 */
function AuditEventPanel({
  event,
  onOpenChange,
}: {
  event: AuditEvent | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <SlideOver
      open={event !== null}
      onOpenChange={onOpenChange}
      title={event?.summary ?? ''}
      description={event ? formatDateTime(event.at) : ''}
      width="md"
      footer={
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t('common.close')}
        </Button>
      }
    >
      {event && (
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              tone={
                event.result === 'success'
                  ? 'success'
                  : event.result === 'denied'
                    ? 'warning'
                    : 'danger'
              }
              size="sm"
              icon={
                event.result === 'success' ? (
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                ) : event.result === 'denied' ? (
                  <ShieldAlert className="h-3 w-3" aria-hidden />
                ) : (
                  <XCircle className="h-3 w-3" aria-hidden />
                )
              }
            >
              {RESULT_LABELS[event.result]}
            </Badge>
            <Badge tone="neutral" size="sm">
              {event.category}
            </Badge>
          </div>

          <DetailField label={t('activity.action')}>
            <span className="font-[family-name:var(--uxe-font-mono)] text-[13px]">
              {event.action}
            </span>
          </DetailField>

          <DetailField label={t('activity.actor')}>
            <span className="flex items-center gap-2">
              <Avatar name={event.actorName} size={22} />
              {event.actorName}
              <span className="text-[12px] text-[var(--uxe-text-tertiary)]">
                ({event.actorType})
              </span>
            </span>
          </DetailField>

          <DetailField label={t('activity.target')}>
            {event.targetLabel ?? event.targetType ?? null}
          </DetailField>

          <DetailField label={t('activity.when')}>{formatDateTime(event.at)}</DetailField>

          <DetailField label={t('activity.trace')}>
            <span className="font-[family-name:var(--uxe-font-mono)] text-[12px]">
              {event.traceId}
            </span>
          </DetailField>

          <DetailField label={t('activity.ipAddress')}>{event.ipAddress}</DetailField>

          {/* Long, and only ever read when something looks wrong, so it stays small. */}
          <DetailField label={t('activity.userAgent')}>
            {event.userAgent && (
              <span className="text-[12px] text-[var(--uxe-text-secondary)]">
                {event.userAgent}
              </span>
            )}
          </DetailField>

          {event.targetId && event.targetType === 'consultation' && (
            <Button variant="secondary" asChild className="self-start">
              <Link to={`/consult/${event.targetId}`}>{t('dashboard.openIt')}</Link>
            </Button>
          )}
        </div>
      )}
    </SlideOver>
  );
}

const RESULT_LABELS = {
  success: 'Succeeded',
  failure: 'Failed',
  denied: 'Denied',
} as const;
