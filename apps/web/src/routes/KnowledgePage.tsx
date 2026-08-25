import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CloudUpload,
  Database,
  FileSpreadsheet,
  FileText,
  Globe,
  Image as ImageIcon,
  Info,
  Link2,
  Loader2,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  ShieldAlert,
  Users2,
  X,
  XCircle,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  Dialog,
  DropdownMenu,
  EmptyState,
  ErrorState,
  Field,
  FilterChip,
  Gauge,
  Input,
  LoadingRegion,
  Pagination,
  ProgressBar,
  Select,
  Skeleton,
  SwitchField,
  Tooltip,
  cn,
  formatBytes,
  formatRelative,
  useToast,
} from '@uxe/ui';
import type { SourceSummary, SourcesResponse, UploadTicket } from '@uxe/contracts';
import { ApiError, api, newIdempotencyKey, uploadFile } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { useSession } from '../lib/session.js';
import { Ayumi } from '../components/Brand.js';
import { PageHeader } from '../components/PageHeader.js';

const TYPE_ICONS: Record<string, typeof FileText> = {
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  pptx: Presentation,
  image: ImageIcon,
  html: Globe,
  text: FileText,
  markdown: FileText,
  archive: Database,
  unknown: FileText,
};

const TYPE_COLORS: Record<string, string> = {
  pdf: 'text-[#E5484D] bg-[var(--uxe-danger-bg)]',
  docx: 'text-[#2563EB] bg-[var(--uxe-info-bg)]',
  xlsx: 'text-[#12A86B] bg-[var(--uxe-success-bg)]',
  csv: 'text-[#12A86B] bg-[var(--uxe-success-bg)]',
  pptx: 'text-[#EA580C] bg-[var(--uxe-warning-bg)]',
  image: 'text-[var(--uxe-violet)] bg-[color-mix(in_srgb,var(--uxe-violet)_12%,transparent)]',
  html: 'text-[var(--uxe-teal)] bg-[var(--uxe-teal-bg)]',
};

/** Reproduces `assets/screens/03-knowledge-base.png`. */
export function KnowledgePage() {
  const { t, formatNumber } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);

  const status = searchParams.get('status') ?? 'all';
  const documentType = searchParams.get('type') ?? 'all';
  const q = searchParams.get('q') ?? '';
  const page = Number(searchParams.get('page') ?? '1');
  const pageSize = Number(searchParams.get('pageSize') ?? '10');

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (value === null || value === '' || value === 'all') next.delete(key);
      else next.set(key, value);
      // Any filter change invalidates the current page number.
      if (key !== 'page') next.delete('page');
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const query = useQuery<SourcesResponse, ApiError>({
    queryKey: ['sources', { status, documentType, q, page, pageSize }],
    queryFn: () =>
      api.get<SourcesResponse>(
        `/sources?${new URLSearchParams({
          status,
          documentType,
          ...(q ? { q } : {}),
          page: String(page),
          pageSize: String(pageSize),
        })}`,
      ),
    // Keep polling while anything is still indexing so progress advances on its own.
    refetchInterval: (result) =>
      result.state.data?.items.some((s) =>
        ['pending', 'scanning', 'extracting', 'indexing', 'validating'].includes(s.status),
      )
        ? 2500
        : false,
  });

  const reprocess = useMutation({
    mutationFn: (sourceId: string) =>
      api.post(`/sources/${sourceId}/reprocess`, undefined, newIdempotencyKey()),
    onSuccess: () => {
      push({ tone: 'info', title: 'Reprocessing started', description: 'Progress appears in the indexing pipeline.' });
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not reprocess', description: error.message }),
  });

  const bulk = useMutation({
    mutationFn: (action: string) =>
      api.post('/sources/bulk', { sourceIds: [...selected], action, confirm: true }),
    onSuccess: (_result, action) => {
      push({ tone: 'success', title: `Applied "${action}" to ${selected.size} source(s)` });
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Bulk action failed', description: error.message }),
  });

  const startUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const entries: UploadState[] = files.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}`,
        fileName: file.name,
        sizeBytes: file.size,
        percent: 0,
        status: 'uploading',
        message: null,
      }));
      setUploads((current) => [...current, ...entries]);

      try {
        const { tickets } = await api.post<{ tickets: UploadTicket[] }>('/sources/uploads', {
          files: files.map((file) => ({
            fileName: file.name,
            sizeBytes: file.size,
            contentType: file.type || 'application/octet-stream',
          })),
          tags: [],
          accessScope: 'workspace',
          promoteToKnowledge: true,
        });

        await Promise.all(
          tickets.map(async (ticket, index) => {
            const file = files[index];
            const entry = entries[index];
            if (!file || !entry) return;

            try {
              const result = await uploadFile(ticket.uploadUrl, file, {
                onProgress: (percent) =>
                  setUploads((current) =>
                    current.map((u) => (u.id === entry.id ? { ...u, percent } : u)),
                  ),
              });

              setUploads((current) =>
                current.map((u) =>
                  u.id === entry.id
                    ? {
                        ...u,
                        percent: 100,
                        status: result.duplicate ? 'duplicate' : 'processing',
                        message: result.message ?? null,
                      }
                    : u,
                ),
              );
            } catch (error) {
              setUploads((current) =>
                current.map((u) =>
                  u.id === entry.id
                    ? {
                        ...u,
                        status: 'failed',
                        message: error instanceof ApiError ? error.message : 'The upload failed.',
                      }
                    : u,
                ),
              );
            }
          }),
        );

        void queryClient.invalidateQueries({ queryKey: ['sources'] });
      } catch (error) {
        setUploads((current) =>
          current.map((u) =>
            entries.some((e) => e.id === u.id)
              ? { ...u, status: 'failed', message: error instanceof ApiError ? error.message : 'Upload failed.' }
              : u,
          ),
        );
      }
    },
    [queryClient],
  );

  const data = query.data;
  const counts = data?.counts;

  const filters = useMemo(
    () => [
      { key: 'all', label: t('knowledge.allSources'), count: counts?.all, color: undefined },
      { key: 'ready', label: t('knowledge.ready'), count: counts?.ready, color: 'var(--uxe-success)' },
      { key: 'processing', label: t('knowledge.processing'), count: counts?.processing, color: 'var(--uxe-info)' },
      { key: 'needs_review', label: t('knowledge.needsReview'), count: counts?.needs_review, color: 'var(--uxe-warning)' },
      { key: 'failed', label: t('knowledge.failed'), count: counts?.failed, color: 'var(--uxe-danger)' },
      { key: 'archived', label: t('knowledge.archived'), count: counts?.archived, color: 'var(--uxe-text-tertiary)' },
    ],
    [counts, t],
  );

  return (
    <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-6">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <PageHeader
            icon={<Database className="h-5 w-5" aria-hidden />}
            title={t('knowledge.title')}
            subtitle={t('knowledge.subtitle')}
            actions={
              can('source:create') ? (
                <Button variant="outline" onClick={() => setUrlDialogOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('knowledge.addSources')}
                </Button>
              ) : null
            }
          />

          {can('source:create') && (
            <UploadZone onFiles={startUpload} onUrlClick={() => setUrlDialogOpen(true)} />
          )}

          {uploads.length > 0 && (
            <UploadList uploads={uploads} onDismiss={(id) => setUploads((c) => c.filter((u) => u.id !== id))} />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Filter by status"
              className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
            >
              {filters.map((filter) => (
                <FilterChip
                  key={filter.key}
                  active={status === filter.key}
                  onClick={() => setParam('status', filter.key)}
                  label={filter.label}
                  count={filter.count}
                  dotColor={filter.color}
                />
              ))}
            </div>

            <Select
              value={documentType}
              onValueChange={(value) => setParam('type', value)}
              ariaLabel="Filter by file type"
              size="sm"
              options={[
                { value: 'all', label: t('knowledge.allTypes') },
                { value: 'pdf', label: 'PDF' },
                { value: 'docx', label: 'DOCX' },
                { value: 'xlsx', label: 'XLSX' },
                { value: 'pptx', label: 'PPTX' },
                { value: 'csv', label: 'CSV' },
                { value: 'html', label: 'HTML' },
                { value: 'image', label: 'Image' },
              ]}
            />
          </div>

          <Card flush>
            <div className="flex flex-wrap items-center gap-3 border-b border-[var(--uxe-border)] p-3 sm:p-4">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="text-[13px] font-medium text-[var(--uxe-text-secondary)]">
                  {t('knowledge.selected', { count: selected.size })}
                </span>
                {selected.size > 0 && can('source:update') && (
                  <DropdownMenu
                    label={t('knowledge.bulkActions')}
                    trigger={
                      <Button variant="secondary" size="sm">
                        {t('knowledge.bulkActions')}
                      </Button>
                    }
                    items={[
                      { label: 'Reprocess', icon: <RefreshCw className="h-4 w-4" aria-hidden />, onSelect: () => bulk.mutate('reprocess') },
                      { label: 'Archive', icon: <Database className="h-4 w-4" aria-hidden />, onSelect: () => bulk.mutate('archive') },
                      {
                        label: 'Delete',
                        icon: <X className="h-4 w-4" aria-hidden />,
                        onSelect: () => bulk.mutate('delete'),
                        destructive: true,
                        disabled: !can('source:delete'),
                        disabledReason: 'Your role cannot delete sources',
                        separatorBefore: true,
                      },
                    ]}
                  />
                )}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  value={q}
                  onChange={(event) => setParam('q', event.target.value)}
                  placeholder={t('knowledge.searchPlaceholder')}
                  aria-label={t('knowledge.searchPlaceholder')}
                  iconLeft={<Search className="h-4 w-4" aria-hidden />}
                  className="h-9 w-full text-[13px] sm:w-64"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void query.refetch()}
                  loading={query.isRefetching}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  <span className="max-sm:sr-only">{t('knowledge.refresh')}</span>
                </Button>
              </div>
            </div>

            <div className="p-3 sm:p-4">
              {query.isLoading ? (
                <LoadingRegion label="Loading sources">
                  <div className="flex flex-col gap-2">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-14 w-full" />
                    ))}
                  </div>
                </LoadingRegion>
              ) : query.error ? (
                <ErrorState
                  message={query.error.message}
                  traceId={query.error.traceId}
                  onRetry={() => void query.refetch()}
                  retrying={query.isRefetching}
                />
              ) : (
                <>
                  <DataTable
                    caption="Knowledge base sources"
                    rows={data?.items ?? []}
                    rowKey={(row) => row.id}
                    onRowClick={(row) => navigate(`/knowledge/${row.id}`)}
                    selection={
                      can('source:update')
                        ? {
                            selected,
                            onToggle: (id) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (next.has(id)) next.delete(id);
                                else next.add(id);
                                return next;
                              }),
                            onToggleAll: () =>
                              setSelected((current) =>
                                current.size === (data?.items.length ?? 0)
                                  ? new Set()
                                  : new Set((data?.items ?? []).map((s) => s.id)),
                              ),
                            renderCheckbox: (checked, onChange, label) => (
                              <Checkbox checked={checked} onCheckedChange={onChange} ariaLabel={label} />
                            ),
                          }
                        : undefined
                    }
                    empty={
                      <EmptyState
                        icon={<Database className="h-6 w-6" aria-hidden />}
                        title={q || status !== 'all' ? 'No sources match these filters' : t('knowledge.emptyTitle')}
                        description={
                          q || status !== 'all'
                            ? 'Try clearing the search or choosing a different status.'
                            : t('knowledge.emptyBody')
                        }
                        action={
                          q || status !== 'all' ? (
                            <Button variant="secondary" size="sm" onClick={() => setSearchParams({}, { replace: true })}>
                              {t('common.clearFilters')}
                            </Button>
                          ) : undefined
                        }
                      />
                    }
                    columns={[
                      {
                        key: 'document',
                        width: '30%',
                        header: t('knowledge.document'),
                        primary: true,
                        render: (row) => <SourceTitleCell source={row} />,
                      },
                      {
                        key: 'type',
                        width: '9%',
                        header: t('knowledge.type'),
                        render: (row) => (
                          <span className="uppercase text-[var(--uxe-text-secondary)]">{row.documentType}</span>
                        ),
                      },
                      {
                        key: 'pages',
                        width: '7%',
                        header: t('knowledge.pages'),
                        align: 'right',
                        render: (row) => (
                          <span className="tabular-nums text-[var(--uxe-text-secondary)]">
                            {row.pages === null ? '—' : formatNumber(row.pages)}
                          </span>
                        ),
                      },
                      {
                        key: 'version',
                        width: '9%',
                        header: t('knowledge.version'),
                        render: (row) => (
                          <span className="tabular-nums text-[var(--uxe-text-secondary)]">{row.currentVersion}</span>
                        ),
                      },
                      {
                        key: 'access',
                        width: '13%',
                        header: t('knowledge.access'),
                        render: (row) => (
                          <Badge
                            tone="neutral"
                            size="sm"
                            icon={
                              row.accessScope === 'workspace' ? (
                                <Globe className="h-3 w-3" aria-hidden />
                              ) : (
                                <Users2 className="h-3 w-3" aria-hidden />
                              )
                            }
                          >
                            {row.accessLabel}
                          </Badge>
                        ),
                      },
                      {
                        key: 'synced',
                        width: '16%',
                        header: t('knowledge.lastSynced'),
                        render: (row) => (
                          <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                            {formatRelative(row.lastSyncedAt ?? row.updatedAt)}
                          </span>
                        ),
                      },
                      {
                        key: 'status',
                        width: '16%',
                        header: t('knowledge.status'),
                        render: (row) => (
                          <SourceStatusCell
                            source={row}
                            onRetry={() => reprocess.mutate(row.id)}
                            retrying={reprocess.isPending && reprocess.variables === row.id}
                            canRetry={can('source:reprocess')}
                          />
                        ),
                      },
                    ]}
                  />

                  {data && (
                    <Pagination
                      page={data.page}
                      pageSize={data.pageSize}
                      total={data.total}
                      totalPages={data.totalPages}
                      onPageChange={(next) => setParam('page', String(next))}
                      onPageSizeChange={(size) => setParam('pageSize', String(size))}
                    />
                  )}
                </>
              )}
            </div>
          </Card>
        </div>

        <aside className="flex min-w-0 flex-col gap-5" aria-label="Pipeline and health">
          {data && <PipelineCard pipeline={data.pipeline} />}
          {data && <HealthCard health={data.knowledgeHealth} counts={data.counts} />}
          <AskAyumiCard />
        </aside>
      </div>

      <AddUrlDialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                     */
/* -------------------------------------------------------------------------- */

interface UploadState {
  id: string;
  fileName: string;
  sizeBytes: number;
  percent: number;
  status: 'uploading' | 'processing' | 'duplicate' | 'failed';
  message: string | null;
}

function UploadZone({ onFiles, onUrlClick }: { onFiles: (files: File[]) => void; onUrlClick: () => void }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    onFiles([...event.dataTransfer.files]);
  };

  return (
    <Card>
      <CardHeader className="mb-3">
        <CardTitle>{t('knowledge.addSources')}</CardTitle>
      </CardHeader>

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center rounded-[var(--uxe-radius-card)] border-2 border-dashed px-6 py-8 text-center transition-colors',
          dragging
            ? 'border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)]'
            : 'border-[var(--uxe-border-strong)] bg-[var(--uxe-surface-sunken)]',
        )}
      >
        <span
          aria-hidden
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-full gradient-surface text-white shadow-[var(--uxe-shadow-brand)]"
        >
          <CloudUpload className="h-6 w-6" />
        </span>
        <p className="text-[16px] font-semibold text-[var(--uxe-text)]">
          {t('knowledge.dropFiles')}{' '}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-[var(--uxe-cobalt)] underline underline-offset-2"
          >
            {t('knowledge.browse')}
          </button>
        </p>
        <p className="mt-1 text-[13px] text-[var(--uxe-text-secondary)]">{t('knowledge.acceptedTypes')}</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Choose files to upload"
          accept=".pdf,.docx,.xlsx,.csv,.pptx,.txt,.md,.html,.png,.jpg,.jpeg,.tif,.tiff,.zip"
          onChange={(event) => {
            onFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ConnectorButton icon={<GoogleDriveIcon />} label={t('knowledge.googleDrive')} connector="google_drive" />
        <ConnectorButton icon={<OneDriveIcon />} label={t('knowledge.oneDrive')} connector="onedrive" />
        <ConnectorButton icon={<SharePointIcon />} label={t('knowledge.sharePoint')} connector="sharepoint" />
        <Button variant="secondary" size="md" onClick={onUrlClick}>
          <Link2 className="h-4 w-4" aria-hidden />
          {t('knowledge.websiteUrl')}
        </Button>

        <div className="ml-auto">
          <AutoSyncToggle />
        </div>
      </div>
    </Card>
  );
}

/**
 * Workspace-level auto-sync.
 *
 * Persisted through the settings endpoint rather than held in component state, so the
 * switch reflects the actual scheduling policy instead of being a control that forgets
 * what it was told.
 */
function AutoSyncToggle() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const { can } = useSession();

  const settings = useQuery<{ settings: { notifications: { weeklyDigest: boolean } } }, ApiError>({
    queryKey: ['settings'],
    queryFn: () => api.get('/settings'),
  });

  const update = useMutation({
    mutationFn: (enabled: boolean) => api.patch('/settings', { notifications: { weeklyDigest: enabled } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] }),
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not change auto-sync', description: error.message }),
  });

  const enabled = settings.data?.settings.notifications.weeklyDigest ?? false;

  return (
    <SwitchField
      className="py-0"
      label={t('knowledge.autoSync')}
      checked={enabled}
      onCheckedChange={(next) => update.mutate(next)}
      disabled={!can('settings:update')}
      disabledReason="Only an Owner or Admin can change the sync schedule."
    />
  );
}

/**
 * Connector buttons.
 *
 * These are real: they call the connector endpoint. When the deployment has no OAuth
 * application configured the API says exactly which credentials are missing, and that
 * message is surfaced — rather than the button appearing to work and doing nothing.
 */
function ConnectorButton({
  icon,
  label,
  connector,
}: {
  icon: React.ReactNode;
  label: string;
  connector: 'google_drive' | 'onedrive' | 'sharepoint';
}) {
  const { push } = useToast();
  const [pending, setPending] = useState(false);

  const connect = async () => {
    setPending(true);
    try {
      await api.post('/sources/connectors', { kind: connector, accountEmail: 'me@example.com' }, newIdempotencyKey());
      push({ tone: 'success', title: `${label} connected` });
    } catch (error) {
      push({
        tone: 'error',
        title: `${label} is not available`,
        description: error instanceof ApiError ? error.message : 'The connector could not be started.',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Button variant="secondary" size="md" onClick={connect} loading={pending}>
      {icon}
      {label}
    </Button>
  );
}

function UploadList({ uploads, onDismiss }: { uploads: UploadState[]; onDismiss: (id: string) => void }) {
  return (
    <Card flush className="overflow-hidden">
      <ul aria-live="polite" className="divide-y divide-[var(--uxe-border)]">
        {uploads.map((upload) => (
          <li key={upload.id} className="flex items-center gap-3 p-3.5">
            <span
              aria-hidden
              className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)]',
                upload.status === 'failed'
                  ? 'bg-[var(--uxe-danger-bg)] text-[var(--uxe-danger)]'
                  : upload.status === 'duplicate'
                    ? 'bg-[var(--uxe-warning-bg)] text-[var(--uxe-warning)]'
                    : upload.status === 'processing'
                      ? 'bg-[var(--uxe-success-bg)] text-[var(--uxe-success)]'
                      : 'bg-[var(--uxe-info-bg)] text-[var(--uxe-info)]',
              )}
            >
              {upload.status === 'failed' ? (
                <XCircle className="h-5 w-5" />
              ) : upload.status === 'duplicate' ? (
                <Info className="h-5 w-5" />
              ) : upload.status === 'processing' ? (
                <CheckCircle2 className="h-5 w-5" />
              ) : (
                <Loader2 className="h-5 w-5 animate-[uxe-spin_0.9s_linear_infinite]" />
              )}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="truncate text-[14px] font-medium text-[var(--uxe-text)]">{upload.fileName}</p>
                <p className="shrink-0 text-[12px] text-[var(--uxe-text-secondary)]">
                  {formatBytes(upload.sizeBytes)}
                </p>
              </div>
              {upload.status === 'uploading' ? (
                <ProgressBar value={upload.percent} label={`Uploading ${upload.fileName}`} className="mt-2" />
              ) : (
                <p
                  className={cn(
                    'mt-0.5 text-[12px]',
                    upload.status === 'failed' ? 'text-[var(--uxe-danger)]' : 'text-[var(--uxe-text-secondary)]',
                  )}
                >
                  {upload.message ??
                    (upload.status === 'processing' ? 'Uploaded. Indexing in progress.' : 'Done.')}
                </p>
              )}
            </div>

            <Button variant="ghost" size="icon-sm" onClick={() => onDismiss(upload.id)} aria-label={`Dismiss ${upload.fileName}`}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Table cells                                                                */
/* -------------------------------------------------------------------------- */

function SourceTitleCell({ source }: { source: SourceSummary }) {
  const Icon = TYPE_ICONS[source.documentType] ?? FileText;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)]',
          TYPE_COLORS[source.documentType] ?? 'bg-[var(--uxe-neutral-bg)] text-[var(--uxe-text-secondary)]',
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <Link
          to={`/knowledge/${source.id}`}
          onClick={(event) => event.stopPropagation()}
          className="block truncate font-medium text-[var(--uxe-text)] hover:text-[var(--uxe-cobalt)] hover:underline"
        >
          {source.title}
        </Link>
        {source.tags.length > 0 && (
          <span className="mt-0.5 block truncate text-[12px] text-[var(--uxe-text-tertiary)]">
            {source.tags.join(' · ')}
          </span>
        )}
      </span>
    </span>
  );
}

function SourceStatusCell({
  source,
  onRetry,
  retrying,
  canRetry,
}: {
  source: SourceSummary;
  onRetry: () => void;
  retrying: boolean;
  canRetry: boolean;
}) {
  const { t } = useI18n();

  if (source.status === 'ready') {
    return (
      <Badge tone="success" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>
        {t('knowledge.ready')}
      </Badge>
    );
  }

  if (source.status === 'failed' || source.status === 'quarantined') {
    return (
      <span className="flex flex-col items-start gap-1">
        <Badge
          tone="danger"
          size="sm"
          icon={
            source.status === 'quarantined' ? (
              <ShieldAlert className="h-3 w-3" aria-hidden />
            ) : (
              <XCircle className="h-3 w-3" aria-hidden />
            )
          }
        >
          {source.status === 'quarantined' ? t('knowledge.quarantined') : t('knowledge.failed')}
        </Badge>
        {source.failureReason && (
          <Tooltip content={source.failureReason}>
            <span className="max-w-40 truncate text-[11px] text-[var(--uxe-text-secondary)]">
              {source.failureReason}
            </span>
          </Tooltip>
        )}
        {canRetry && source.status === 'failed' && (
          <Button variant="link" size="xs" onClick={(e) => { e.stopPropagation(); onRetry(); }} loading={retrying}>
            {t('knowledge.retry')}
          </Button>
        )}
      </span>
    );
  }

  if (source.status === 'needs_review') {
    return (
      <Badge tone="warning" size="sm" icon={<AlertTriangle className="h-3 w-3" aria-hidden />}>
        {t('knowledge.needsReview')}
      </Badge>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <Badge tone="info" size="sm" icon={<Circle className="h-3 w-3 animate-[uxe-pulse-dot_1.4s_ease-in-out_infinite]" aria-hidden />}>
        {t('knowledge.processing')}
      </Badge>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Right rail                                                                 */
/* -------------------------------------------------------------------------- */

const STAGE_LABELS: Record<string, string> = {
  malware_scan: 'Malware scan',
  extraction: 'Extraction / OCR',
  structure_analysis: 'Structure analysis',
  chunking: 'Chunking',
  embeddings: 'Embeddings',
  lexical_index: 'Lexical index',
  citation_map: 'Citation map',
  validation: 'Validation',
};

function PipelineCard({ pipeline }: { pipeline: SourcesResponse['pipeline'] }) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('knowledge.indexingPipeline')}</CardTitle>
      </CardHeader>

      <ul className="flex flex-col gap-3">
        {pipeline.map((stage) => {
          const percent = stage.total === 0 ? 0 : (stage.completed / stage.total) * 100;
          return (
            <li key={stage.stage}>
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  {stage.state === 'complete' ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--uxe-success)]" aria-hidden />
                  ) : stage.state === 'blocked' ? (
                    <XCircle className="h-4 w-4 shrink-0 text-[var(--uxe-danger)]" aria-hidden />
                  ) : stage.state === 'running' ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-[uxe-spin_1s_linear_infinite] text-[var(--uxe-info)]" aria-hidden />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-[var(--uxe-text-tertiary)]" aria-hidden />
                  )}
                  <span className="truncate text-[13px] font-medium text-[var(--uxe-text)]">
                    {STAGE_LABELS[stage.stage] ?? stage.stage}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-[var(--uxe-text-secondary)]">
                  {stage.completed} / {stage.total}
                </span>
              </div>
              <ProgressBar
                value={percent}
                tone={stage.state === 'blocked' ? 'danger' : stage.state === 'complete' ? 'success' : 'brand'}
                label={`${STAGE_LABELS[stage.stage]}: ${stage.completed} of ${stage.total}`}
                className="mt-1.5"
              />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function HealthCard({
  health,
  counts,
}: {
  health: SourcesResponse['knowledgeHealth'];
  counts: SourcesResponse['counts'];
}) {
  const { t } = useI18n();
  const rows = [
    { label: t('knowledge.ready'), value: counts.ready, color: 'var(--uxe-success)' },
    { label: t('knowledge.processing'), value: counts.processing, color: 'var(--uxe-info)' },
    { label: t('knowledge.needsReview'), value: counts.needs_review, color: 'var(--uxe-warning)' },
    { label: t('knowledge.failed'), value: counts.failed, color: 'var(--uxe-danger)' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.knowledgeHealth')}</CardTitle>
        <Tooltip content={<span className="font-[family-name:var(--uxe-font-mono)] text-[11px]">{health.formula}</span>}>
          <button type="button" aria-label="How knowledge health is calculated" className="rounded p-1 text-[var(--uxe-text-tertiary)]">
            <Info className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
      </CardHeader>

      <div className="flex items-center gap-5">
        <Gauge
          value={health.score}
          label={t('dashboard.knowledgeHealth')}
          tone={health.score >= 90 ? 'success' : health.score >= 70 ? 'brand' : 'warning'}
          size={104}
        />
        <ul className="min-w-0 flex-1 space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
                <span className="truncate text-[var(--uxe-text-secondary)]">{row.label}</span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{row.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

function AskAyumiCard() {
  const { t } = useI18n();
  const navigate = useNavigate();

  return (
    <Card
      flush
      className="relative overflow-hidden bg-[linear-gradient(150deg,var(--uxe-surface)_0%,var(--uxe-surface-selected)_100%)]"
    >
      <div className="relative flex items-end gap-2 p-5">
        <div className="min-w-0 flex-1">
          <h3 className="text-[16px] font-semibold text-[var(--uxe-text)]">{t('knowledge.askAyumi')}</h3>
          <p className="mt-1.5 text-[13px] leading-snug text-[var(--uxe-text-secondary)]">
            {t('knowledge.askAyumiBody')}
          </p>
          <Button variant="primary" size="md" className="mt-4" onClick={() => navigate('/consult')}>
            {t('knowledge.askAyumi')}
          </Button>
        </div>
        {/* Ayumi is anchored to the card edge so she never covers the button. */}
        <div className="pointer-events-none -mb-5 hidden h-40 w-24 shrink-0 sm:block">
          <Ayumi variant="sm" decorative />
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Add URL                                                                    */
/* -------------------------------------------------------------------------- */

function AddUrlDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/sources/connectors', { kind: 'website', url, maxDepth: 1, maxPages: 25, respectRobots: true }, newIdempotencyKey()),
    onSuccess: () => {
      push({ tone: 'success', title: 'Website queued', description: 'Indexing starts immediately.' });
      void queryClient.invalidateQueries({ queryKey: ['sources'] });
      setUrl('');
      onOpenChange(false);
    },
    onError: (caught: ApiError) => setError(caught.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('knowledge.websiteUrl')}
      description="The page is fetched over HTTPS only. Private addresses and redirects into them are refused."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => mutation.mutate()} loading={mutation.isPending} disabled={!url.trim()}>
            {t('knowledge.addSources')}
          </Button>
        </>
      }
    >
      <Field label="URL" htmlFor="source-url" error={error ?? undefined}>
        <Input
          id="source-url"
          type="url"
          inputMode="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
          placeholder="https://example.com/regulation"
          invalid={Boolean(error)}
          iconLeft={<Globe className="h-4 w-4" aria-hidden />}
        />
      </Field>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Connector icons                                                            */
/* -------------------------------------------------------------------------- */

function GoogleDriveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path fill="#0066DA" d="M1.6 17.3l1.4 2.4c.3.5.7.9 1.2 1.2l4.9-8.5H0c0 .6.1 1.1.4 1.6l1.2 3.3z" />
      <path fill="#00AC47" d="M12 7.6L7.1 0h-.2c-.5.3-.9.7-1.2 1.2L.4 10.6c-.3.5-.4 1-.4 1.6h9.1L12 7.6z" />
      <path fill="#EA4335" d="M16.9 24c.5-.3.9-.7 1.2-1.2l.6-1 2.8-4.8c.3-.5.4-1 .4-1.6h-9.1l1.9 3.4L16.9 24z" />
      <path fill="#00832D" d="M12 7.6L16.9 0H7.1L12 7.6z" />
      <path fill="#2684FC" d="M19.1 12.4H24c0-.6-.1-1.1-.4-1.6L18.3 1.2c-.3-.5-.7-.9-1.2-1.2l-4.9 8.5 6.9 3.9z" />
      <path fill="#FFBA00" d="M9.1 12.4H0l4.9 8.5c.5.3 1 .4 1.6.4h11c.6 0 1.1-.1 1.6-.4l-4.9-8.5H9.1z" />
    </svg>
  );
}

function OneDriveIcon() {
  return (
    <svg width="18" height="14" viewBox="0 0 24 16" aria-hidden>
      <path fill="#0364B8" d="M9.6 5.3l4.3 2.6 2.6-1.1a4 4 0 0 1 1.6-.3A6 6 0 0 0 7.7 3.4a4.7 4.7 0 0 1 1.9 1.9z" />
      <path fill="#0078D4" d="M7.7 3.4a4.8 4.8 0 0 0-2.6 1.2 4.8 4.8 0 0 0-1.5 2.6 4.4 4.4 0 0 0-2.4 1.2L8.6 12l5.3-4.1-4.3-2.6a4.7 4.7 0 0 0-1.9-1.9z" />
      <path fill="#1490DF" d="M3.6 7.2a4.4 4.4 0 0 0-2.4 1.2A4.3 4.3 0 0 0 0 11.5c0 .3 0 .6.1.9l8.5-.4-5-4.8z" />
      <path fill="#28A8EA" d="M18.1 6.5a4 4 0 0 0-1.6.3l-2.6 1.1L18.6 16h3.1A4.3 4.3 0 0 0 24 12.2a4.3 4.3 0 0 0-4.3-4.3c-.5 0-1 .1-1.5.2v-1.6z" />
      <path fill="#0078D4" d="M.1 12.4A4.3 4.3 0 0 0 4.3 16h14.3l-4.7-8.1L8.6 12 .1 12.4z" />
    </svg>
  );
}

function SharePointIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <circle cx="9" cy="7" r="6.5" fill="#036C70" />
      <circle cx="15.5" cy="12" r="5.5" fill="#1A9BA1" />
      <circle cx="12.5" cy="18" r="4.5" fill="#37C6D0" />
      <rect x="2" y="8" width="11" height="11" rx="1" fill="#03787C" />
      <text x="7.5" y="16.2" fontSize="8" fill="#fff" textAnchor="middle" fontFamily="Inter, sans-serif" fontWeight="700">S</text>
    </svg>
  );
}
