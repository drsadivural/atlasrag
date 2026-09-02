import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileBarChart, FileText, Info, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FilterChip,
  LoadingRegion,
  Pagination,
  Skeleton,
  Tooltip,
  formatBytes,
  formatRelative,
  useToast,
} from '@uxe/ui';
import type { ArtifactSummary, Paginated } from '@uxe/contracts';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { PageHeader } from '../components/PageHeader.js';

const KIND_LABELS: Record<string, string> = {
  compliance_report: 'Compliance report',
  summary: 'Summary',
  evidence_matrix: 'Evidence matrix',
  corrected_document: 'Corrected document',
  redline: 'Change report',
  export: 'Export',
};

export function ReportsPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [removing, setRemoving] = useState<ArtifactSummary | null>(null);

  const kind = searchParams.get('kind') ?? 'all';
  const page = Number(searchParams.get('page') ?? '1');

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'all' || !value) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const query = useQuery<Paginated<ArtifactSummary>, ApiError>({
    queryKey: ['artifacts', { kind, page }],
    queryFn: () =>
      api.get<Paginated<ArtifactSummary>>(`/artifacts?kind=${kind}&page=${page}&pageSize=20`),
  });

  const download = useMutation({
    mutationFn: (id: string) =>
      api.get<{ url: string; fileName: string }>(`/artifacts/${id}/download`),
    onSuccess: (result) => {
      // A short-lived signed URL; navigating to it starts the download immediately.
      const anchor = document.createElement('a');
      anchor.href = result.url;
      anchor.download = result.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Download failed', description: error.message }),
  });

  /**
   * Removing a report archives it.
   *
   * `DELETE /artifacts/:id` marks the row archived and stamps `deleted_at`; the file itself
   * stays until retention collects it. The wording says archive rather than delete, because
   * that is what happens, and a compliance report is not a thing to be vague about.
   */
  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/artifacts/${id}`),
    onSuccess: (_result, id) => {
      const title = removing?.id === id ? removing.title : null;
      push({
        tone: 'success',
        title: t('reports.removed'),
        description: title ? t('reports.removedBody', { title }) : undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
      setRemoving(null);
    },
    onError: (error: ApiError) => {
      push({ tone: 'error', title: t('reports.couldNotRemove'), description: error.message });
      setRemoving(null);
    },
  });

  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        icon={<FileBarChart className="h-5 w-5" aria-hidden />}
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
      />

      <div
        role="group"
        aria-label={t('report.filterKind')}
        className="mt-5 flex flex-wrap items-center gap-2"
      >
        {[
          'all',
          'compliance_report',
          'summary',
          'evidence_matrix',
          'corrected_document',
          'redline',
        ].map((value) => (
          <FilterChip
            key={value}
            active={kind === value}
            onClick={() => setParam('kind', value)}
            label={value === 'all' ? t('common.all') : (KIND_LABELS[value] ?? value)}
          />
        ))}
      </div>

      <Card flush className="mt-4 p-3 sm:p-4">
        {query.isLoading ? (
          <LoadingRegion label={t('report.loadingList')}>
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
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
          <>
            <DataTable
              caption={t('report.tableCaption')}
              rows={query.data?.items ?? []}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  icon={<FileBarChart className="h-6 w-6" aria-hidden />}
                  title={t('reports.emptyTitle')}
                  description={t('reports.emptyBody')}
                  action={
                    <Button asChild variant="primary" size="sm">
                      <Link to="/consult">{t('dashboard.startConsultation')}</Link>
                    </Button>
                  }
                />
              }
              columns={[
                {
                  key: 'title',
                  header: t('table.artifact'),
                  primary: true,
                  render: (row) => (
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]"
                      >
                        <FileText className="h-4 w-4" />
                      </span>
                      <span className="min-w-0">
                        <Link
                          to={`/reports/${row.id}`}
                          className="block truncate font-medium text-[var(--uxe-text)] hover:text-[var(--uxe-cobalt)] hover:underline"
                        >
                          {row.title}
                        </Link>
                        {row.consultationTitle && (
                          <span className="block truncate text-[12px] text-[var(--uxe-text-tertiary)]">
                            {row.consultationTitle}
                          </span>
                        )}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'kind',
                  header: t('table.kind'),
                  render: (row) => (
                    <Badge tone={row.kind === 'corrected_document' ? 'brand' : 'neutral'} size="sm">
                      {KIND_LABELS[row.kind] ?? row.kind}
                    </Badge>
                  ),
                },
                {
                  key: 'format',
                  header: t('table.format'),
                  render: (row) => (
                    <span className="text-[var(--uxe-text-secondary)] uppercase">
                      {row.documentType}
                    </span>
                  ),
                },
                {
                  key: 'size',
                  header: t('table.size'),
                  align: 'right',
                  render: (row) => (
                    <span className="text-[var(--uxe-text-secondary)] tabular-nums">
                      {formatBytes(row.sizeBytes)}
                    </span>
                  ),
                },
                {
                  key: 'disclosures',
                  header: t('table.notes'),
                  render: (row) =>
                    row.disclosures.length > 0 ? (
                      <Tooltip
                        content={
                          <ul className="space-y-1">
                            {row.disclosures.map((note, index) => (
                              <li key={index}>{note}</li>
                            ))}
                          </ul>
                        }
                      >
                        <button type="button" className="cursor-help">
                          <Badge
                            tone="warning"
                            size="sm"
                            icon={<Info className="h-3 w-3" aria-hidden />}
                          >
                            {row.disclosures.length}
                          </Badge>
                        </button>
                      </Tooltip>
                    ) : (
                      <span className="text-[var(--uxe-text-tertiary)]">—</span>
                    ),
                },
                {
                  key: 'created',
                  header: t('table.generated'),
                  render: (row) => (
                    <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                      {formatRelative(row.createdAt)}
                    </span>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  align: 'right',
                  /*
                   * Both actions are buttons, on every width.
                   *
                   * They used to be a menu behind a download-arrow trigger, which read as a
                   * download button and hid removing a report two clicks deep — and the
                   * whole column disappeared on a phone, so on a phone there was no way to
                   * remove anything at all.
                   */
                  render: (row) => {
                    const noDownload =
                      row.status !== 'ready'
                        ? t('reports.stillGenerating')
                        : can('artifact:download')
                          ? null
                          : t('reports.cannotDownload');
                    const noRemove = can('artifact:delete') ? null : t('reports.cannotRemove');

                    return (
                      <span className="flex items-center justify-end gap-1">
                        <RowAction
                          label={t('reports.download')}
                          title={row.title}
                          reason={noDownload}
                          loading={download.isPending && download.variables === row.id}
                          onClick={() => download.mutate(row.id)}
                        >
                          <Download className="h-4 w-4" aria-hidden />
                        </RowAction>

                        <RowAction
                          label={t('reports.remove')}
                          title={row.title}
                          reason={noRemove}
                          destructive
                          loading={archive.isPending && archive.variables === row.id}
                          onClick={() => setRemoving(row)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </RowAction>
                      </span>
                    );
                  },
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

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t('reports.remove')}
        description={t('reports.removeBody', { title: removing?.title ?? '' })}
        confirmLabel={t('reports.remove')}
        cancelLabel={t('common.cancel')}
        destructive
        loading={archive.isPending}
        onConfirm={() => removing && archive.mutate(removing.id)}
      />
    </div>
  );
}

/**
 * One icon button in a row, with the reason it is unavailable.
 *
 * The tooltip hangs on a wrapper rather than on the button, because a disabled button
 * carries `pointer-events-none` and would never fire it — so the explanation for why the
 * control is greyed out would be the one thing nobody could read. The reason is repeated
 * into the accessible name for the same reason: a disabled control cannot be focused, so
 * the tooltip alone reaches only a mouse.
 */
function RowAction({
  label,
  title,
  reason,
  destructive,
  loading,
  onClick,
  children,
}: {
  label: string;
  title: string;
  reason: string | null;
  destructive?: boolean;
  loading: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={reason ?? label}>
      <span className="inline-flex">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={reason ? `${label}: ${title} — ${reason}` : `${label}: ${title}`}
          disabled={reason !== null}
          loading={loading}
          onClick={onClick}
          className={
            destructive ? 'text-[var(--uxe-danger)] hover:bg-[var(--uxe-danger-bg)]' : undefined
          }
        >
          {children}
        </Button>
      </span>
    </Tooltip>
  );
}
