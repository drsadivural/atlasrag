import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  ErrorState,
  LoadingRegion,
  Skeleton,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  formatBytes,
  formatDateTime,
  formatRelative,
  useToast,
} from '@uxe/ui';
import type { SourceDetail } from '@uxe/contracts';
import { ApiError, api, newIdempotencyKey } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { PageHeader } from '../components/PageHeader.js';

export function KnowledgeSourcePage() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const { t } = useI18n();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [tab, setTab] = useState('overview');
  const [deleting, setDeleting] = useState(false);

  const query = useQuery<SourceDetail, ApiError>({
    queryKey: ['source', sourceId],
    queryFn: () => api.get<SourceDetail>(`/sources/${sourceId}`),
    enabled: Boolean(sourceId),
    refetchInterval: (result) =>
      ['pending', 'scanning', 'extracting', 'indexing', 'validating'].includes(result.state.data?.status ?? '')
        ? 2500
        : false,
  });

  const reprocess = useMutation({
    mutationFn: () => api.post(`/sources/${sourceId}/reprocess`, undefined, newIdempotencyKey()),
    onSuccess: () => {
      push({ tone: 'info', title: 'Reprocessing started' });
      void queryClient.invalidateQueries({ queryKey: ['source', sourceId] });
    },
    onError: (error: ApiError) => push({ tone: 'error', title: 'Could not reprocess', description: error.message }),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/sources/${sourceId}`),
    onSuccess: () => {
      push({
        tone: 'success',
        title: 'Source deleted',
        description: 'Existing citations stay resolvable for audit until the retention purge runs.',
      });
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (error: ApiError) => push({ tone: 'error', title: 'Could not delete', description: error.message }),
  });

  if (query.isLoading) {
    return (
      <LoadingRegion label="Loading source">
        <div className="mx-auto w-full max-w-[1200px] p-6">
          <Skeleton className="h-9 w-80" />
          <Skeleton className="mt-4 h-64 w-full" />
        </div>
      </LoadingRegion>
    );
  }

  if (query.error) {
    return (
      <div className="p-6">
        <ErrorState message={query.error.message} traceId={query.error.traceId} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const source = query.data;
  if (!source) return null;

  return (
    <div className="mx-auto w-full max-w-[1200px] p-4 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link to="/knowledge">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('knowledge.title')}
        </Link>
      </Button>

      <PageHeader
        icon={<FileText className="h-5 w-5" aria-hidden />}
        title={source.title}
        subtitle={`${source.documentType.toUpperCase()} · ${source.currentVersion}${source.pages ? ` · ${source.pages} pages` : ''} · ${source.accessLabel}`}
        actions={
          <>
            {can('source:reprocess') && (
              <Button variant="secondary" onClick={() => reprocess.mutate()} loading={reprocess.isPending}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Reprocess
              </Button>
            )}
            {can('source:delete') && (
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                <Trash2 className="h-4 w-4" aria-hidden />
                {t('common.delete')}
              </Button>
            )}
          </>
        }
      />

      {source.quarantine && (
        <Card className="mt-4 border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)]">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--uxe-danger)]" aria-hidden />
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-[var(--uxe-danger)]">Quarantined</p>
              <p className="mt-1 text-[13px] text-[var(--uxe-text)]">{source.quarantine.reason}</p>
              {source.quarantine.excerpt && (
                <p className="mt-2 rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface)] p-2 font-[family-name:var(--uxe-font-mono)] text-[11px] text-[var(--uxe-text-secondary)]">
                  {source.quarantine.excerpt}
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {source.failureReason && !source.quarantine && (
        <Card className="mt-4 border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)]">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--uxe-warning)]" aria-hidden />
            <p className="text-[13px] text-[var(--uxe-text)]">{source.failureReason}</p>
          </div>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab} className="mt-5">
        <TabList ariaLabel="Source details">
          <Tab value="overview">Overview</Tab>
          <Tab value="versions" count={source.versions.length}>
            Versions
          </Tab>
          <Tab value="permissions" count={source.permissions.length}>
            Permissions
          </Tab>
          <Tab value="log" count={source.processingLog.length}>
            Processing log
          </Tab>
        </TabList>

        <TabPanel value="overview" className="pt-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Structure</CardTitle>
              </CardHeader>
              <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
                <Row label="Headings">{source.structure.headings}</Row>
                <Row label="Clauses">{source.structure.clauses}</Row>
                <Row label="Tables">{source.structure.tables}</Row>
                <Row label="Definitions">{source.structure.definitions}</Row>
                <Row label="Indexed chunks">{source.structure.chunks}</Row>
              </dl>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Metadata</CardTitle>
              </CardHeader>
              <dl className="grid grid-cols-2 gap-y-2 text-[13px]">
                <Row label="Owner">{source.ownerName}</Row>
                <Row label="Size">{formatBytes(source.sizeBytes)}</Row>
                <Row label="Created">{formatDateTime(source.createdAt)}</Row>
                <Row label="Last synced">{source.lastSyncedAt ? formatRelative(source.lastSyncedAt) : '—'}</Row>
                <Row label="Effective date">{source.effectiveDate ? formatDateTime(source.effectiveDate) : '—'}</Row>
                <Row label="In knowledge base">{source.isPromotedUpload ? 'Yes' : 'No — consultation input'}</Row>
              </dl>
              {source.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {source.tags.map((tag) => (
                    <Badge key={tag} tone="neutral" size="sm">
                      {tag}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="versions" className="pt-5">
          <Card flush>
            <ul className="divide-y divide-[var(--uxe-border)]">
              {source.versions.map((version) => (
                <li key={version.id} className="flex flex-wrap items-center gap-3 p-4">
                  <span
                    aria-hidden
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)] ${
                      version.isCurrent
                        ? 'bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]'
                        : 'bg-[var(--uxe-neutral-bg)] text-[var(--uxe-text-secondary)]'
                    }`}
                  >
                    <Database className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-[var(--uxe-text)]">
                      {version.version}
                      {version.isCurrent && (
                        <Badge tone="success" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>
                          Current
                        </Badge>
                      )}
                      {version.ocrApplied && (
                        <Badge tone="info" size="sm">
                          OCR{version.ocrConfidence ? ` ${Math.round(version.ocrConfidence * 100)}%` : ''}
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--uxe-text-secondary)]">
                      {formatBytes(version.sizeBytes)}
                      {version.pages ? ` · ${version.pages} pages` : ''}
                      {version.extractionCoverage !== null
                        ? ` · ${Math.round(version.extractionCoverage * 100)}% extraction coverage`
                        : ''}
                      {` · ${formatDateTime(version.createdAt)} by ${version.createdByName}`}
                    </p>
                    <p className="mt-0.5 font-[family-name:var(--uxe-font-mono)] text-[11px] text-[var(--uxe-text-tertiary)]">
                      {version.sha256.slice(0, 24)}…
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <p className="mt-3 text-[12px] text-[var(--uxe-text-secondary)]">
            Existing consultations keep citing the exact version they used. A new version is indexed separately and
            promoted only after validation.
          </p>
        </TabPanel>

        <TabPanel value="permissions" className="pt-5">
          <Card flush>
            <ul className="divide-y divide-[var(--uxe-border)]">
              {source.permissions.map((permission) => (
                <li key={permission.id} className="flex items-center justify-between gap-3 p-4">
                  <span className="text-[14px] text-[var(--uxe-text)]">{permission.subjectLabel}</span>
                  <Badge tone="neutral" size="sm">
                    {permission.capability}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        </TabPanel>

        <TabPanel value="log" className="pt-5">
          <Card flush>
            {source.processingLog.length === 0 ? (
              <p className="p-6 text-center text-[14px] text-[var(--uxe-text-secondary)]">
                No processing attempts recorded.
              </p>
            ) : (
              <ol className="divide-y divide-[var(--uxe-border)]">
                {source.processingLog.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 p-4">
                    <span aria-hidden className="mt-0.5">
                      {entry.status === 'succeeded' ? (
                        <CheckCircle2 className="h-4 w-4 text-[var(--uxe-success)]" />
                      ) : entry.status === 'failed' || entry.status === 'dead_letter' ? (
                        <XCircle className="h-4 w-4 text-[var(--uxe-danger)]" />
                      ) : (
                        <Clock className="h-4 w-4 text-[var(--uxe-info)]" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-[var(--uxe-text)]">
                        {entry.stage.replace(/_/g, ' ')} · attempt {entry.attempt}
                      </p>
                      <p className="text-[12px] text-[var(--uxe-text-secondary)]">{entry.message}</p>
                    </div>
                    <span className="shrink-0 text-[12px] text-[var(--uxe-text-tertiary)]">
                      {formatRelative(entry.at)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </TabPanel>
      </Tabs>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete "${source.title}"?`}
        description="It is removed from retrieval immediately. Existing citations stay resolvable for authorised audit until the retention purge runs."
        confirmLabel={t('common.delete')}
        confirmWord="DELETE"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--uxe-text-secondary)]">{label}</dt>
      <dd className="text-right font-medium text-[var(--uxe-text)]">{children}</dd>
    </>
  );
}
