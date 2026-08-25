import { useSearchParams } from 'react-router-dom';
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
  Tooltip,
  formatDateTime,
} from '@uxe/ui';
import type { AuditEvent, Paginated } from '@uxe/contracts';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { PageHeader } from '../components/PageHeader.js';

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

  const query = useQuery<Paginated<AuditEvent>, ApiError>({
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
          can('audit:export') ? (
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

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by category" className="flex min-w-0 flex-1 flex-wrap gap-2">
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
          aria-label="Search activity"
          className="h-9 w-full text-[13px] sm:w-64"
        />
      </div>

      <Card flush className="mt-4 p-3 sm:p-4">
        {query.isLoading ? (
          <LoadingRegion label="Loading activity">
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : query.error ? (
          <ErrorState message={query.error.message} traceId={query.error.traceId} onRetry={() => void query.refetch()} />
        ) : (
          <>
            <DataTable
              caption="Audit events"
              rows={query.data?.items ?? []}
              rowKey={(row) => row.id}
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
                  header: 'Event',
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
                        <span className="block text-[14px] text-[var(--uxe-text)]">{row.summary}</span>
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
                  header: 'Category',
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
                    <Tooltip content={`Trace ${row.traceId}${row.ipAddress ? ` · ${row.ipAddress}` : ''}`}>
                      <span
                        tabIndex={0}
                        className="cursor-help font-[family-name:var(--uxe-font-mono)] text-[11px] text-[var(--uxe-text-tertiary)]"
                      >
                        {row.traceId.slice(0, 8)}
                      </span>
                    </Tooltip>
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
