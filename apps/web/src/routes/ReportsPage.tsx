import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileBarChart, FileText, Info, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  DropdownMenu,
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
import { ApiError, api } from '../lib/api.js';
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
    queryFn: () => api.get<Paginated<ArtifactSummary>>(`/artifacts?kind=${kind}&page=${page}&pageSize=20`),
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

  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/artifacts/${id}`),
    onSuccess: () => {
      push({ tone: 'success', title: 'Artifact archived' });
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
    onError: (error: ApiError) => push({ tone: 'error', title: 'Could not archive', description: error.message }),
  });

  return (
    <div className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">
      <PageHeader
        icon={<FileBarChart className="h-5 w-5" aria-hidden />}
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
      />

      <div role="group" aria-label="Filter by kind" className="mt-5 flex flex-wrap items-center gap-2">
        {['all', 'compliance_report', 'summary', 'evidence_matrix', 'corrected_document', 'redline'].map((value) => (
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
          <LoadingRegion label="Loading reports">
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : query.error ? (
          <ErrorState
            message={query.error.message}
            traceId={query.error.traceId}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            <DataTable
              caption="Generated reports and documents"
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
                  header: 'Artifact',
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
                  header: 'Kind',
                  render: (row) => (
                    <Badge tone={row.kind === 'corrected_document' ? 'brand' : 'neutral'} size="sm">
                      {KIND_LABELS[row.kind] ?? row.kind}
                    </Badge>
                  ),
                },
                {
                  key: 'format',
                  header: 'Format',
                  render: (row) => <span className="uppercase text-[var(--uxe-text-secondary)]">{row.documentType}</span>,
                },
                {
                  key: 'size',
                  header: 'Size',
                  align: 'right',
                  render: (row) => (
                    <span className="tabular-nums text-[var(--uxe-text-secondary)]">{formatBytes(row.sizeBytes)}</span>
                  ),
                },
                {
                  key: 'disclosures',
                  header: 'Notes',
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
                        <span tabIndex={0}>
                          <Badge tone="warning" size="sm" icon={<Info className="h-3 w-3" aria-hidden />}>
                            {row.disclosures.length}
                          </Badge>
                        </span>
                      </Tooltip>
                    ) : (
                      <span className="text-[var(--uxe-text-tertiary)]">—</span>
                    ),
                },
                {
                  key: 'created',
                  header: 'Generated',
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
                  hideOnMobile: true,
                  render: (row) => (
                    <DropdownMenu
                      label={`Actions for ${row.title}`}
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.title}`}>
                          <Download className="h-4 w-4" aria-hidden />
                        </Button>
                      }
                      items={[
                        {
                          label: t('reports.download'),
                          icon: <Download className="h-4 w-4" aria-hidden />,
                          onSelect: () => download.mutate(row.id),
                          disabled: !can('artifact:download') || row.status !== 'ready',
                          disabledReason:
                            row.status !== 'ready' ? 'Still generating' : 'Your role cannot download artifacts',
                        },
                        {
                          label: t('reports.archive'),
                          icon: <Trash2 className="h-4 w-4" aria-hidden />,
                          onSelect: () => archive.mutate(row.id),
                          destructive: true,
                          disabled: !can('artifact:delete'),
                          disabledReason: 'Your role cannot archive artifacts',
                          separatorBefore: true,
                        },
                      ]}
                    />
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
