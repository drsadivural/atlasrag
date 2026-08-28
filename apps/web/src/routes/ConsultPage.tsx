import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasStalled } from '../lib/staleness.js';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  FileEdit,
  FileText,
  HelpCircle,
  Link2,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Table2,
  Square,
  X,
} from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  DropdownMenu,
  EmptyState,
  ErrorState,
  StaleNotice,
  Field,
  Gauge,
  Input,
  LoadingRegion,
  SegmentedControl,
  Select,
  Skeleton,
  SlideOver,
  SwitchField,
  Textarea,
  Tooltip,
  cn,
  formatRelative,
  useToast,
} from '@uxe/ui';
import type {
  AnswerStyle,
  ConsultationDetail,
  ConsultationSummary,
  Paginated,
  SourcesResponse,
  TaskMode,
  UploadTicket,
} from '@uxe/contracts';
import { ApiError, api, newIdempotencyKey, uploadFile } from '../lib/api.js';
import { subscribeToConsultation } from '../lib/stream.js';
import {
  CorrectionReviewDialog,
  type CorrectionPlanSummary,
} from '../components/CorrectionReview.js';
import { useSyncedState } from '../lib/forms.js';
import { useI18n } from '../lib/i18n.js';
import { Ayumi } from '../components/Brand.js';
import { AnswerView } from '../components/AnswerView.js';
import { CitationViewer } from '../components/CitationViewer.js';

const TASK_MODES: Array<{ value: TaskMode; icon: typeof HelpCircle; labelKey: 'consult.ask' }> = [
  { value: 'ask', icon: HelpCircle, labelKey: 'consult.ask' },
  { value: 'summarize', icon: FileText, labelKey: 'consult.summarize' as never },
  { value: 'check_compliance', icon: CheckCircle2, labelKey: 'consult.checkCompliance' as never },
  { value: 'correct_document', icon: FileEdit, labelKey: 'consult.correctDocument' as never },
];

/** Reproduces `assets/screens/04-consult-now.png` and `assets/reference/consultant-main.png`. */
export function ConsultPage() {
  const { consultationId } = useParams<{ consultationId?: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const [historyOpen, setHistoryOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [openCitationId, setOpenCitationId] = useState<string | null>(null);

  const list = useQuery<Paginated<ConsultationSummary>, ApiError>({
    queryKey: ['consultations'],
    queryFn: () => api.get<Paginated<ConsultationSummary>>('/consultations?pageSize=50'),
  });

  const detail = useQuery<ConsultationDetail, ApiError>({
    queryKey: ['consultation', consultationId],
    queryFn: () => api.get<ConsultationDetail>(`/consultations/${consultationId}`),
    enabled: Boolean(consultationId),
    /*
     * A backstop while an answer is being produced.
     *
     * The stream is the fast path and does the work; this is what makes it safe for the
     * stream to miss something. Sending a question and receiving the answer can both
     * happen before the EventSource for a freshly created consultation has finished
     * connecting, and with the stream as the only update path that window left the screen
     * saying "Ayumi is reviewing your sources" over an answer that had already arrived.
     *
     * It stops as soon as nothing is outstanding, so a settled conversation is not polled.
     */
    refetchInterval: (result) =>
      result.state.data?.messages.some(
        (message) => message.jobStatus === 'queued' || message.jobStatus === 'running',
      )
        ? 2000
        : false,
  });

  // Seeded from the consultation's stored preference, so the panel opens in the mode the
  // conversation was left in rather than snapping to it a frame later.
  const [answerStyle, setAnswerStyle] = useSyncedState<AnswerStyle>(
    detail.data?.answerStyle ?? 'optimal',
  );
  const [taskMode, setTaskMode] = useSyncedState<TaskMode>(detail.data?.taskMode ?? 'ask');

  const create = useMutation({
    mutationFn: () =>
      // No sourceIds: the server starts from every approved source this person can see.
      // Sending an empty list would mean "none", which is a different thing and is what
      // left every new consultation unable to answer until somebody opened Manage sources.
      api.post<ConsultationDetail>('/consultations', {
        title: 'New consultation',
        taskMode: 'ask',
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['consultations'] });
      navigate(`/consult/${created.id}`);
      setHistoryOpen(false);
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not start a consultation', description: error.message }),
  });

  // Live job progress. Every event is already persisted, so a reconnect just re-reads.
  useEffect(() => {
    if (!consultationId) return;
    const controller = subscribeToConsultation(consultationId, {
      onStage: () =>
        void queryClient.invalidateQueries({ queryKey: ['consultation', consultationId] }),
      onMessage: () => {
        void queryClient.invalidateQueries({ queryKey: ['consultation', consultationId] });
        void queryClient.invalidateQueries({ queryKey: ['consultations'] });
      },
      onJob: (event) => {
        if (event.job.error) {
          push({
            tone: 'error',
            title: 'That job did not finish',
            description: event.job.error.message,
            action: event.job.error.retryable
              ? {
                  label: 'Retry',
                  onClick: () => {
                    void api
                      .post(`/jobs/${event.job.id}/retry`, undefined, newIdempotencyKey())
                      .then(() =>
                        queryClient.invalidateQueries({
                          queryKey: ['consultation', consultationId],
                        }),
                      );
                  },
                }
              : undefined,
          });
        }
      },
      onDone: () =>
        void queryClient.invalidateQueries({ queryKey: ['consultation', consultationId] }),
    });
    return () => controller.close();
  }, [consultationId, queryClient, push]);

  const consultation = detail.data ?? null;
  const detailStalled = consultation !== null && hasStalled(detail);

  return (
    <div className="flex h-[calc(100dvh-var(--uxe-header-height))] min-h-0 flex-col md:flex-row">
      {/* Left: history. A drawer below xl. */}
      <HistoryPanel
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        consultations={list.data?.items ?? []}
        loading={list.isLoading}
        activeId={consultationId ?? null}
        onCreate={() => create.mutate()}
        creating={create.isPending}
      />

      {/* Centre: workspace. */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t('consult.title')}>
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--uxe-border)] bg-[var(--uxe-surface)] px-3 py-2.5 xl:hidden">
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('consult.consultations')}
          </Button>
          <span className="ms-auto" />
          {consultation && (
            <Button variant="secondary" size="sm" onClick={() => setRailOpen(true)}>
              <Settings2 className="h-4 w-4" aria-hidden />
              {t('consult.evidenceOutput')}
            </Button>
          )}
        </div>

        {!consultationId ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            <EmptyState
              icon={<Sparkles className="h-7 w-7" aria-hidden />}
              title={t('consult.emptyTitle')}
              description={t('consult.emptyBody')}
              action={
                <Button
                  variant="primary"
                  onClick={() => create.mutate()}
                  loading={create.isPending}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('consult.newConsultation')}
                </Button>
              }
            />
          </div>
        ) : detail.isLoading ? (
          <ConsultSkeleton />
        ) : detail.error && !consultation ? (
          <div className="p-6">
            <ErrorState
              labels={{ retry: t('common.retry'), reference: t('common.reference') }}
              message={detail.error.message}
              traceId={detail.error.traceId}
              onRetry={() => void detail.refetch()}
            />
          </div>
        ) : consultation ? (
          <>
            {detailStalled && (
              <StaleNotice
                labels={{ paused: t('common.updatesPaused'), retry: t('common.retryNow') }}
                className="mx-4 mt-4 sm:mx-6"
                message={detail.error?.message ?? 'This conversation has stopped refreshing.'}
                onRetry={() => void detail.refetch()}
                retrying={detail.isFetching}
              />
            )}
            <ConsultationWorkspace
              consultation={consultation}
              answerStyle={answerStyle}
              onAnswerStyleChange={setAnswerStyle}
              taskMode={taskMode}
              onTaskModeChange={setTaskMode}
              onManageSources={() => setSourceDialogOpen(true)}
              onOpenCitation={setOpenCitationId}
            />
          </>
        ) : null}
      </section>

      {/* Right: evidence and output. A slide-over below xl. */}
      {consultation && (
        <EvidencePanel
          consultation={consultation}
          answerStyle={answerStyle}
          onAnswerStyleChange={setAnswerStyle}
          open={railOpen}
          onOpenChange={setRailOpen}
        />
      )}

      {consultation && (
        <SourceSelectorDialog
          open={sourceDialogOpen}
          onOpenChange={setSourceDialogOpen}
          consultation={consultation}
        />
      )}

      <CitationViewer
        citationId={openCitationId}
        onClose={() => setOpenCitationId(null)}
        onNavigate={setOpenCitationId}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

function HistoryPanel({
  open,
  onOpenChange,
  consultations,
  loading,
  activeId,
  onCreate,
  creating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consultations: ConsultationSummary[];
  loading: boolean;
  activeId: string | null;
  onCreate: () => void;
  creating: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matched = term
      ? consultations.filter((c) => c.title.toLowerCase().includes(term))
      : consultations;
    // Pinned first, then most recently touched.
    return [...matched].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [consultations, query]);

  const content = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 p-4">
        <h2 className="text-[12px] font-semibold tracking-wider text-[var(--uxe-text-secondary)] uppercase">
          {t('consult.consultations')}
        </h2>
        <Button
          variant="primary"
          size="icon-sm"
          onClick={onCreate}
          loading={creating}
          aria-label={t('consult.newConsultation')}
        >
          <Plus className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      <div className="shrink-0 px-4 pb-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('consult.searchConversations')}
          aria-label={t('consult.searchConversations')}
          iconLeft={<Search className="h-4 w-4" aria-hidden />}
          className="h-9 text-[13px]"
        />
      </div>

      <nav
        aria-label={t('consult.consultations')}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
      >
        {loading ? (
          <LoadingRegion label={t('consult.loadingList')}>
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </LoadingRegion>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[13px] text-[var(--uxe-text-secondary)]">
            {query ? 'No conversations match that search.' : 'No consultations yet.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((consultation) => (
              <li key={consultation.id}>
                <ConsultationListItem
                  consultation={consultation}
                  active={consultation.id === activeId}
                  onSelected={() => onOpenChange(false)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>

      <AyumiStatusCard />
    </div>
  );

  return (
    <>
      <aside
        className="hidden w-[300px] shrink-0 border-e border-[var(--uxe-border)] bg-[var(--uxe-surface)] xl:block"
        aria-label={t('consult.consultations')}
      >
        {content}
      </aside>

      <SlideOver
        open={open}
        onOpenChange={onOpenChange}
        title={t('consult.consultations')}
        width="sm"
      >
        {content}
      </SlideOver>
    </>
  );
}

function ConsultationListItem({
  consultation,
  active,
  onSelected,
}: {
  consultation: ConsultationSummary;
  active: boolean;
  /** Called after navigation, so the drawer closes instead of covering the conversation. */
  onSelected?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const remove = useMutation({
    mutationFn: () => api.delete(`/consultations/${consultation.id}`),
    onSuccess: () => {
      push({ tone: 'success', title: 'Consultation deleted' });
      void queryClient.invalidateQueries({ queryKey: ['consultations'] });
      if (active) navigate('/consult');
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not delete', description: error.message }),
  });

  const statusDot =
    consultation.status === 'action_required'
      ? 'bg-[var(--uxe-danger)]'
      : consultation.status === 'report_ready'
        ? 'bg-[var(--uxe-success)]'
        : consultation.status === 'processing'
          ? 'bg-[var(--uxe-info)] animate-[uxe-pulse-dot_1.4s_ease-in-out_infinite]'
          : 'bg-[var(--uxe-border-strong)]';

  return (
    <div
      className={cn(
        'group flex items-start gap-2.5 rounded-[var(--uxe-radius-card)] border p-3 transition-colors',
        active
          ? 'border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)]'
          : 'border-transparent hover:bg-[var(--uxe-surface-hover)]',
      )}
    >
      <button
        type="button"
        onClick={() => {
          navigate(`/consult/${consultation.id}`);
          onSelected?.();
        }}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-start"
        aria-current={active ? 'page' : undefined}
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)]',
            active
              ? 'bg-[var(--uxe-cobalt)]/12 text-[var(--uxe-cobalt)]'
              : 'bg-[var(--uxe-neutral-bg)] text-[var(--uxe-text-secondary)]',
          )}
        >
          <FileText className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-[var(--uxe-text)]">
            {consultation.title}
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-[var(--uxe-text-secondary)]">
            {consultation.documentCount > 0 && `${consultation.documentCount} documents · `}
            {formatRelative(consultation.lastMessageAt ?? consultation.updatedAt)}
          </span>
        </span>
        <span aria-hidden className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', statusDot)} />
      </button>

      <DropdownMenu
        label={`Actions for ${consultation.title}`}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Actions for ${consultation.title}`}
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        }
        items={[
          {
            label: 'Open',
            icon: <ArrowRight className="h-4 w-4" aria-hidden />,
            onSelect: () => {
              navigate(`/consult/${consultation.id}`);
              onSelected?.();
            },
          },
          {
            label: 'Delete',
            icon: <X className="h-4 w-4" aria-hidden />,
            onSelect: () => remove.mutate(),
            destructive: true,
            separatorBefore: true,
          },
        ]}
      />
    </div>
  );
}

function AyumiStatusCard() {
  const { t } = useI18n();
  return (
    <div className="relative shrink-0 overflow-hidden border-t border-[var(--uxe-border)] bg-[linear-gradient(180deg,var(--uxe-surface)_0%,var(--uxe-surface-selected)_100%)]">
      <div className="relative flex h-[188px] items-end justify-center">
        <div className="h-full w-full">
          <Ayumi variant="md" decorative />
        </div>
        <span
          aria-hidden
          className="absolute top-4 right-4 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--uxe-success)] text-white shadow-[var(--uxe-shadow-sm)]"
        >
          <CheckCircle2 className="h-4 w-4" />
        </span>
      </div>
      <div className="px-4 pb-4 text-center">
        <p className="text-[15px] font-semibold text-[var(--uxe-text)]">
          {t('app.consultant')} is <span className="text-[var(--uxe-success)]">online</span>
        </p>
        <p className="mt-1 text-[12px] leading-snug text-[var(--uxe-text-secondary)]">
          {t('consult.groundedIn')}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* -------------------------------------------------------------------------- */

function ConsultationWorkspace({
  consultation,
  answerStyle,
  onAnswerStyleChange,
  taskMode,
  onTaskModeChange,
  onManageSources,
  onOpenCitation,
}: {
  consultation: ConsultationDetail;
  answerStyle: AnswerStyle;
  onAnswerStyleChange: (style: AnswerStyle) => void;
  taskMode: TaskMode;
  onTaskModeChange: (mode: TaskMode) => void;
  onManageSources: () => void;
  onOpenCitation: (id: string) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [title, setTitle] = useSyncedState(consultation.title);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the conversation as it grows.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [consultation.messages.length]);

  const rename = useMutation({
    mutationFn: (next: string) =>
      api.patch(`/consultations/${consultation.id}`, {
        title: next,
        version: consultation.version,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['consultation', consultation.id] });
      void queryClient.invalidateQueries({ queryKey: ['consultations'] });
    },
    onError: (error: ApiError) => {
      setTitle(consultation.title);
      push({ tone: 'error', title: 'Could not rename', description: error.message });
    },
  });

  const busy = consultation.messages.some(
    (message) => message.jobStatus === 'queued' || message.jobStatus === 'running',
  );

  return (
    <>
      <div className="shrink-0 border-b border-[var(--uxe-border)] bg-[var(--uxe-surface)] px-4 py-3.5 sm:px-6">
        <label htmlFor="consultation-title" className="sr-only">
          {t('consult.consultationTitle')}
        </label>
        <input
          id="consultation-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => title.trim() && title !== consultation.title && rename.mutate(title.trim())}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setTitle(consultation.title);
          }}
          className="w-full truncate rounded-[var(--uxe-radius-control)] bg-transparent text-[22px] font-bold text-[var(--uxe-text)] outline-none focus-visible:bg-[var(--uxe-surface-hover)] focus-visible:px-2 sm:text-[26px]"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {consultation.sources.slice(0, 3).map((source) => (
            <span
              key={source.sourceId}
              className="inline-flex max-w-[220px] items-center gap-2 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)] px-2.5 py-1.5 text-[13px]"
            >
              <FileText
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  source.role === 'governing'
                    ? 'text-[var(--uxe-cobalt)]'
                    : 'text-[var(--uxe-teal)]',
                )}
                aria-hidden
              />
              <span className="truncate font-medium text-[var(--uxe-text)]">{source.title}</span>
              {source.pages !== null && (
                <span className="shrink-0 text-[var(--uxe-text-secondary)]">· {source.pages}p</span>
              )}
            </span>
          ))}
          {consultation.sources.length > 3 && (
            <span className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] px-2.5 py-1.5 text-[13px] text-[var(--uxe-text-secondary)]">
              +{consultation.sources.length - 3}{' '}
              {t('consult.documents', { count: consultation.sources.length - 3 })}
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={onManageSources}>
            <Settings2 className="h-3.5 w-3.5" aria-hidden />
            {t('consult.manageSources')}
          </Button>
        </div>
      </div>

      <div className="shrink-0 border-b border-[var(--uxe-border)] bg-[var(--uxe-surface)] px-4 py-3 sm:px-6">
        <div
          role="radiogroup"
          aria-label={t('consult.task')}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {TASK_MODES.map((mode) => {
            const Icon = mode.icon;
            const active = taskMode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onTaskModeChange(mode.value)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-[var(--uxe-radius-card)] border px-3 py-3 transition-all',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uxe-cobalt)]',
                  active
                    ? 'border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)] shadow-[var(--uxe-shadow-sm)]'
                    : 'border-[var(--uxe-border)] bg-[var(--uxe-surface)] hover:bg-[var(--uxe-surface-hover)]',
                )}
              >
                <Icon
                  className={cn(
                    'h-5 w-5',
                    active ? 'text-[var(--uxe-cobalt)]' : 'text-[var(--uxe-text-secondary)]',
                  )}
                  aria-hidden
                />
                <span
                  className={cn(
                    'text-[13px] font-medium',
                    active ? 'text-[var(--uxe-cobalt)]' : 'text-[var(--uxe-text-secondary)]',
                  )}
                >
                  {t(mode.labelKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {consultation.messages.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-6 w-6" aria-hidden />}
            title={
              consultation.sources.length === 0 ? t('consult.noSources') : 'Ask your first question'
            }
            description={
              consultation.sources.length === 0
                ? t('consult.noSourcesBody')
                : 'Ayumi answers only from the sources selected above, and shows the exact clause behind every claim.'
            }
            action={
              consultation.sources.length === 0 ? (
                <Button variant="primary" onClick={onManageSources}>
                  {t('consult.manageSources')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ol className="mx-auto flex max-w-4xl flex-col gap-5">
            {consultation.messages.map((message) => (
              <li key={message.id}>
                <MessageBubble
                  message={message}
                  answerStyle={answerStyle}
                  evidenceDetail={consultation.evidenceDetail}
                  onOpenCitation={onOpenCitation}
                  consultationId={consultation.id}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      <Composer
        consultation={consultation}
        taskMode={taskMode}
        answerStyle={answerStyle}
        busy={busy}
        onStyleChange={onAnswerStyleChange}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

function MessageBubble({
  message,
  answerStyle,
  evidenceDetail,
  onOpenCitation,
  consultationId,
}: {
  message: ConsultationDetail['messages'][number];
  answerStyle: AnswerStyle;
  evidenceDetail: ConsultationDetail['evidenceDetail'];
  onOpenCitation: (id: string) => void;
  consultationId: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const retry = useMutation({
    mutationFn: () => api.post(`/jobs/${message.jobId}/retry`, undefined, newIdempotencyKey()),
    onSuccess: () => {
      push({ tone: 'info', title: 'Retrying' });
      void queryClient.invalidateQueries({ queryKey: ['consultation', consultationId] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Retry failed', description: error.message }),
  });

  if (message.role === 'user') {
    return (
      <div className="flex justify-end gap-3">
        <div className="max-w-[min(680px,85%)] rounded-[var(--uxe-radius-card-lg)] rounded-tr-sm bg-[var(--uxe-surface-selected)] px-4 py-3">
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-[var(--uxe-text)]">
            {message.text}
          </p>
          {message.attachments.length > 0 && (
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {message.attachments.map((attachment) => (
                <li
                  key={attachment.id}
                  className="inline-flex items-center gap-1.5 rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface)] px-2 py-1 text-[12px]"
                >
                  <FileText className="h-3 w-3 text-[var(--uxe-danger)]" aria-hidden />
                  {attachment.fileName}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Avatar name="You" size={32} className="mt-0.5" />
      </div>
    );
  }

  const pending = message.jobStatus === 'queued' || message.jobStatus === 'running';

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full bg-[var(--uxe-surface-selected)]">
        <Ayumi variant="sm" decorative className="!object-top" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold text-[var(--uxe-text)]">
            {t('app.consultant')}
          </span>
          <span className="text-[13px] text-[var(--uxe-text-secondary)]">
            · {t('app.consultantRole')}
          </span>
          {message.answer && (
            <Badge tone="success" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden />}>
              {t('compliance.groundedAnswer')}
            </Badge>
          )}
          <span className="text-[12px] text-[var(--uxe-text-tertiary)]">
            {formatRelative(message.createdAt)}
          </span>
        </div>

        <Card>
          {pending ? (
            <div role="status" aria-live="polite" className="flex items-center gap-3">
              <Loader2
                className="h-5 w-5 animate-[uxe-spin_0.9s_linear_infinite] text-[var(--uxe-cobalt)]"
                aria-hidden
              />
              <p className="text-[14px] text-[var(--uxe-text-secondary)]">
                {t('consult.thinking')}
              </p>
            </div>
          ) : message.error ? (
            <ErrorState
              labels={{ retry: t('common.retry'), reference: t('common.reference') }}
              title={t('consult.answerFailed')}
              message={message.error.message}
              traceId={message.error.traceId}
              onRetry={message.error.retryable && message.jobId ? () => retry.mutate() : undefined}
              retrying={retry.isPending}
            />
          ) : message.answer ? (
            <AnswerView
              answer={message.answer}
              style={answerStyle}
              evidenceDetail={evidenceDetail}
              onOpenCitation={onOpenCitation}
              onViewAllCitations={() => {
                const first = message.answer?.citations[0];
                if (first) onOpenCitation(first.citationId);
              }}
            />
          ) : (
            <p className="text-[14px] text-[var(--uxe-text-secondary)]">{message.text}</p>
          )}
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Composer                                                                   */
/* -------------------------------------------------------------------------- */

function Composer({
  consultation,
  taskMode,
  answerStyle,
  busy,
}: {
  consultation: ConsultationDetail;
  taskMode: TaskMode;
  answerStyle: AnswerStyle;
  busy: boolean;
  onStyleChange: (style: AnswerStyle) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const send = useMutation({
    mutationFn: (value: string) =>
      api.post(
        `/consultations/${consultation.id}/messages`,
        {
          text: value,
          taskMode,
          answerStyle,
          attachmentIds: [],
          parentMessageId: null,
          idempotencyKey: newIdempotencyKey(),
        },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      setText('');
      void queryClient.invalidateQueries({ queryKey: ['consultation', consultation.id] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Message not sent', description: error.message }),
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/consultations/${consultation.id}/cancel`),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['consultation', consultation.id] }),
  });

  const submit = useCallback(() => {
    const value = text.trim();
    if (!value || send.isPending) return;
    send.mutate(value);
  }, [text, send]);

  const attach = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(files.map((f) => f.name));
      try {
        const { tickets } = await api.post<{ tickets: UploadTicket[] }>(
          `/consultations/${consultation.id}/uploads`,
          {
            files: files.map((file) => ({
              fileName: file.name,
              sizeBytes: file.size,
              contentType: file.type || 'application/octet-stream',
            })),
            tags: [],
            accessScope: 'workspace',
            promoteToKnowledge: false,
          },
        );

        await Promise.all(
          tickets.map(async (ticket, index) => {
            const file = files[index];
            if (file) await uploadFile(ticket.uploadUrl, file);
          }),
        );

        push({
          tone: 'success',
          title: `${files.length} document(s) attached`,
          description:
            'These are consultation inputs. Promote them from the Knowledge Base to make them permanent sources.',
        });
        void queryClient.invalidateQueries({ queryKey: ['consultation', consultation.id] });
      } catch (error) {
        push({
          tone: 'error',
          title: 'Attachment failed',
          description:
            error instanceof ApiError ? error.message : 'The file could not be uploaded.',
        });
      } finally {
        setUploading([]);
      }
    },
    [consultation.id, push, queryClient],
  );

  /**
   * Voice input via the Web Speech API where the browser provides it.
   *
   * Feature-detected rather than assumed: the button is only rendered when the capability
   * exists, so it is never a control that silently does nothing.
   */
  const speechSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const toggleVoice = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const Ctor =
      (
        window as unknown as {
          SpeechRecognition?: new () => never;
          webkitSpeechRecognition?: new () => never;
        }
      ).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => never }).webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor() as unknown as {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      start: () => void;
      stop: () => void;
      onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void;
      onerror: () => void;
    };

    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(
        { length: event.results.length },
        (_, i) => event.results[i]?.[0]?.transcript ?? '',
      )
        .join(' ')
        .trim();
      if (transcript) setText((current) => (current ? `${current} ${transcript}` : transcript));
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      push({
        tone: 'error',
        title: 'Voice input failed',
        description: 'Check microphone permission and try again.',
      });
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [listening, push]);

  return (
    <div className="pb-safe shrink-0 border-t border-[var(--uxe-border)] bg-[var(--uxe-surface)] p-3 sm:p-4">
      <div className="mx-auto max-w-4xl">
        {uploading.length > 0 && (
          <p role="status" className="mb-2 text-[12px] text-[var(--uxe-text-secondary)]">
            Uploading {uploading.join(', ')}…
          </p>
        )}

        {/*
          Said before the question rather than after it.
          
          With nothing in scope the answer can only come back "unable to determine, no
          sources are selected" — correct, and a poor way to learn it. The check belongs
          where it can still be acted on.
        */}
        {consultation.sources.length === 0 && (
          <p className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] px-2.5 py-2 text-[12px] text-[var(--uxe-warning-text)]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {t('consult.noSourcesSelected')}
            <Link
              to="/knowledge"
              className="font-semibold underline underline-offset-2 hover:no-underline"
            >
              {t('consult.noSourcesAction')}
            </Link>
          </p>
        )}

        <div className="rounded-[var(--uxe-radius-card-lg)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)] shadow-[var(--uxe-shadow-sm)] focus-within:border-[var(--uxe-cobalt)] focus-within:ring-2 focus-within:ring-[var(--uxe-cobalt)]/20">
          <label htmlFor="composer" className="sr-only">
            {t('consult.composerPlaceholder')}
          </label>
          <Textarea
            id="composer"
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Cmd/Ctrl+Enter sends; plain Enter inserts a newline, because these are
              // long-form questions rather than chat one-liners.
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={t('consult.composerPlaceholder')}
            rows={2}
            className="resize-none border-0 bg-transparent shadow-none focus:ring-0"
          />

          <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--uxe-border)] p-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="sr-only"
              aria-label={t('consult.attachDocuments')}
              onChange={(event) => {
                void attach([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => fileRef.current?.click()}
              aria-label={t('consult.uploadDocuments')}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              <span className="max-sm:sr-only">{t('consult.uploadDocuments')}</span>
            </Button>

            <ConnectorChip label="Google Drive" icon={<GoogleDriveGlyph />} />
            <ConnectorChip label="OneDrive" icon={<OneDriveGlyph />} />
            <ConnectorChip label="SharePoint" icon={<SharePointGlyph />} />

            <Button variant="ghost" size="sm">
              <Link2 className="h-3.5 w-3.5" aria-hidden />
              <span className="max-sm:sr-only">{t('consult.url')}</span>
            </Button>

            <span className="ms-auto flex items-center gap-2">
              <span className="hidden text-[12px] text-[var(--uxe-text-tertiary)] sm:inline">
                {t('consult.sendHint')}
              </span>

              {speechSupported && (
                <Button
                  variant={listening ? 'danger' : 'secondary'}
                  size="icon"
                  onClick={toggleVoice}
                  aria-label={listening ? t('consult.stopVoiceInput') : t('consult.voiceInput')}
                  aria-pressed={listening}
                >
                  {listening ? (
                    <MicOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Mic className="h-4 w-4" aria-hidden />
                  )}
                </Button>
              )}

              {busy ? (
                <Button
                  variant="danger"
                  size="icon"
                  onClick={() => cancel.mutate()}
                  aria-label={t('consult.cancel')}
                >
                  <Square className="h-4 w-4" aria-hidden />
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="icon"
                  onClick={submit}
                  loading={send.isPending}
                  disabled={!text.trim()}
                  aria-label={t('consult.send')}
                >
                  <Send className="h-4 w-4" aria-hidden />
                </Button>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectorChip({ label, icon }: { label: string; icon: React.ReactNode }) {
  const { push } = useToast();
  const navigate = useNavigate();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Attach from ${label}`}
      onClick={() =>
        push({
          tone: 'info',
          title: `${label} is not connected`,
          description: 'Connect it in the Knowledge Base, then attach files from there.',
          action: { label: 'Open Knowledge Base', onClick: () => navigate('/knowledge') },
        })
      }
    >
      {icon}
    </Button>
  );
}

function GoogleDriveGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#0066DA"
        d="M1.6 17.3l1.4 2.4c.3.5.7.9 1.2 1.2l4.9-8.5H0c0 .6.1 1.1.4 1.6l1.2 3.3z"
      />
      <path
        fill="#00AC47"
        d="M12 7.6L7.1 0h-.2c-.5.3-.9.7-1.2 1.2L.4 10.6c-.3.5-.4 1-.4 1.6h9.1L12 7.6z"
      />
      <path
        fill="#EA4335"
        d="M16.9 24c.5-.3.9-.7 1.2-1.2l.6-1 2.8-4.8c.3-.5.4-1 .4-1.6h-9.1l1.9 3.4L16.9 24z"
      />
      <path fill="#00832D" d="M12 7.6L16.9 0H7.1L12 7.6z" />
      <path
        fill="#2684FC"
        d="M19.1 12.4H24c0-.6-.1-1.1-.4-1.6L18.3 1.2c-.3-.5-.7-.9-1.2-1.2l-4.9 8.5 6.9 3.9z"
      />
      <path
        fill="#FFBA00"
        d="M9.1 12.4H0l4.9 8.5c.5.3 1 .4 1.6.4h11c.6 0 1.1-.1 1.6-.4l-4.9-8.5H9.1z"
      />
    </svg>
  );
}

function OneDriveGlyph() {
  return (
    <svg width="17" height="13" viewBox="0 0 24 16" aria-hidden>
      <path
        fill="#0364B8"
        d="M9.6 5.3l4.3 2.6 2.6-1.1a4 4 0 0 1 1.6-.3A6 6 0 0 0 7.7 3.4a4.7 4.7 0 0 1 1.9 1.9z"
      />
      <path
        fill="#0078D4"
        d="M7.7 3.4a4.8 4.8 0 0 0-2.6 1.2 4.8 4.8 0 0 0-1.5 2.6 4.4 4.4 0 0 0-2.4 1.2L8.6 12l5.3-4.1-4.3-2.6a4.7 4.7 0 0 0-1.9-1.9z"
      />
      <path
        fill="#28A8EA"
        d="M18.1 6.5a4 4 0 0 0-1.6.3l-2.6 1.1L18.6 16h3.1A4.3 4.3 0 0 0 24 12.2a4.3 4.3 0 0 0-4.3-4.3c-.5 0-1 .1-1.5.2v-1.6z"
      />
      <path fill="#0078D4" d="M.1 12.4A4.3 4.3 0 0 0 4.3 16h14.3l-4.7-8.1L8.6 12 .1 12.4z" />
    </svg>
  );
}

function SharePointGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <circle cx="9" cy="7" r="6.5" fill="#036C70" />
      <circle cx="15.5" cy="12" r="5.5" fill="#1A9BA1" />
      <circle cx="12.5" cy="18" r="4.5" fill="#37C6D0" />
      <rect x="2" y="8" width="11" height="11" rx="1" fill="#03787C" />
      <text
        x="7.5"
        y="16.4"
        fontSize="8.5"
        fill="#fff"
        textAnchor="middle"
        fontFamily="Inter, sans-serif"
        fontWeight="700"
      >
        S
      </text>
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Evidence & Output rail                                                     */
/* -------------------------------------------------------------------------- */

function EvidencePanel({
  consultation,
  answerStyle,
  onAnswerStyleChange,
  open,
  onOpenChange,
}: {
  consultation: ConsultationDetail;
  answerStyle: AnswerStyle;
  onAnswerStyleChange: (style: AnswerStyle) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const latestAnswer = useMemo(
    () => [...consultation.messages].reverse().find((m) => m.answer)?.answer ?? null,
    [consultation.messages],
  );

  /*
   * Preference writes are chained, and seeded from what the write itself returns.
   *
   * Every control in this panel saves through here, and the version travels with the patch
   * so that two people editing the same consultation cannot silently overwrite one
   * another. Asking the server to re-read the consultation afterwards, and taking the
   * version from whatever that re-read produced, turned a second click inside one round
   * trip into a race the user lost twice over: the patch carried a version the re-read had
   * not yet refreshed, so the server — correctly — refused it as somebody else's edit; and
   * React Query folded the second re-read into the first, which had been issued before the
   * second change existed, so the panel snapped back to the earlier choice and stayed
   * there. Either way the answer was "Could not save" for changing your mind too quickly.
   *
   * A write now waits for the one before it and takes the newer of the cached version and
   * the one the previous write returned, and the response — which is the whole
   * consultation — is written straight into the cache. There is no second read left to
   * lose a race with. Optimistic concurrency is for two editors, not for one person
   * pressing a button twice.
   */
  const lastWrite = useRef<Promise<ConsultationDetail | null>>(Promise.resolve(null));

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => {
      const run = lastWrite.current
        .catch(() => null)
        .then((previous) => {
          const cached = queryClient.getQueryData<ConsultationDetail>([
            'consultation',
            consultation.id,
          ]);
          const version = Math.max(cached?.version ?? consultation.version, previous?.version ?? 0);
          return api.patch<ConsultationDetail>(`/consultations/${consultation.id}`, {
            ...patch,
            version,
          });
        });
      lastWrite.current = run;
      return run;
    },
    // The response is the new state of the consultation, so seed it rather than asking
    // for it again — and the next write in the chain gets the version it produced.
    onSuccess: (updated) => {
      queryClient.setQueryData(['consultation', consultation.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['consultations'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not save', description: error.message }),
  });

  /*
   * Both artifacts the API produces, not only one of them.
   *
   * `evidence_matrix` in CSV and XLSX has been generated by the same job as the PDF report
   * from the beginning, and nothing in the product asked for it — a supported output with
   * no way to request it, and two translated labels sitting unused beside the one that
   * worked. A matrix is what somebody takes into a review meeting: one row per
   * requirement, its result, its locator and its quotation, in something they can sort.
   */
  const generate = useMutation({
    mutationFn: (request: { kind: 'compliance_report' | 'evidence_matrix'; format: string }) =>
      api.post(
        `/consultations/${consultation.id}/reports`,
        {
          reviewId: null,
          messageId: [...consultation.messages].reverse().find((m) => m.answer)?.id ?? null,
          format: request.format,
          kind: request.kind,
          idempotencyKey: newIdempotencyKey(),
        },
        newIdempotencyKey(),
      ),
    onSuccess: () =>
      push({
        tone: 'success',
        title: 'Queued',
        description: 'It appears in Reports when ready.',
      }),
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not create it', description: error.message }),
  });

  const projectSource = consultation.sources.find((s) => s.role === 'project');

  // A correction plan is built by a job, so the panel polls from the moment one is
  // requested until the changes it produced are visible. Without that, the plan appears
  // only after navigating away and back.
  const [awaitingPlan, setAwaitingPlan] = useState(false);

  const plans = useQuery<{ items: CorrectionPlanSummary[] }, ApiError>({
    queryKey: ['corrections', consultation.id],
    queryFn: () =>
      api.get<{ items: CorrectionPlanSummary[] }>(`/corrections?consultationId=${consultation.id}`),
    refetchInterval: (result) =>
      awaitingPlan || result.state.data?.items.some((plan) => plan.status === 'generating')
        ? 2500
        : false,
  });
  const latestPlan = plans.data?.items[0] ?? null;
  const [reviewingPlanId, setReviewingPlanId] = useState<string | null>(null);

  if (awaitingPlan && latestPlan && latestPlan.totalChanges > 0) {
    setAwaitingPlan(false);
  }

  const generateCorrection = useMutation({
    mutationFn: () =>
      api.post(
        `/consultations/${consultation.id}/corrections`,
        {
          sourceId: projectSource?.sourceId,
          findingIds: [],
          reviewId: null,
          idempotencyKey: newIdempotencyKey(),
        },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      push({
        tone: 'success',
        title: 'Correction plan started',
        description: 'You will review each proposed change before anything is written.',
      });
      setAwaitingPlan(true);
      void queryClient.invalidateQueries({ queryKey: ['corrections', consultation.id] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not start the correction', description: error.message }),
  });

  const coverage = latestAnswer?.coverage;
  const outputFormat = projectSource?.documentType?.toUpperCase() ?? 'PDF';

  const content = (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="text-[14px] font-semibold text-[var(--uxe-text)]">
          {t('consult.answerStyle')}
        </h3>
        <SegmentedControl
          className="mt-2 w-full"
          full
          size="sm"
          value={answerStyle}
          onValueChange={(value) => {
            onAnswerStyleChange(value as AnswerStyle);
            update.mutate({ answerStyle: value });
          }}
          ariaLabel={t('consult.answerStyle')}
          options={[
            { value: 'yes_no', label: t('consult.styleYesNo') },
            { value: 'optimal', label: t('consult.styleOptimal') },
            { value: 'details', label: t('consult.styleDetails') },
          ]}
        />
        <p className="mt-1.5 text-[12px] text-[var(--uxe-text-secondary)]">
          {t('consult.answerStyleHint')}
        </p>
      </section>

      <section className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5">
        <h3 className="text-[14px] font-semibold text-[var(--uxe-text)]">
          {t('consult.evidenceDetails')}
        </h3>
        <div className="mt-1.5 flex flex-col">
          {(
            [
              ['documentAndPage', t('consult.documentAndPage')],
              ['clauseAndLocation', t('consult.clauseAndLocation')],
              ['supportingExcerpt', t('consult.supportingQuotation')],
            ] as const
          ).map(([key, label]) => (
            <Checkbox
              key={key}
              className="py-1.5"
              checked={consultation.evidenceDetail[key]}
              onCheckedChange={(checked) =>
                update.mutate({
                  evidenceDetail: { ...consultation.evidenceDetail, [key]: checked },
                })
              }
              label={label}
            />
          ))}
        </div>
      </section>

      <section className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5">
        <h3 className="text-[14px] font-semibold text-[var(--uxe-text)]">
          {t('consult.outputDocument')}
        </h3>
        <div className="mt-2.5 flex items-start gap-2.5 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)] p-3">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-[var(--uxe-danger)]" aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-[var(--uxe-text)]">
              {t('consult.matchOriginal')}
            </p>
            <p className="text-[12px] text-[var(--uxe-text-secondary)]">
              {outputFormat} — corrected {outputFormat}
            </p>
          </div>
        </div>

        <Select
          className="mt-2 w-full"
          value={consultation.outputFormat}
          onValueChange={(value) => update.mutate({ outputFormat: value })}
          ariaLabel={t('consult.outputDocument')}
          size="sm"
          options={[
            { value: 'match_source', label: 'Preserve layout & signatures' },
            { value: 'pdf', label: 'PDF' },
            { value: 'docx', label: 'DOCX' },
            { value: 'xlsx', label: 'XLSX' },
            { value: 'markdown', label: 'Markdown' },
          ]}
        />

        <Button
          variant="primary"
          full
          className="mt-2.5"
          onClick={() => generateCorrection.mutate()}
          loading={generateCorrection.isPending}
          disabled={!projectSource}
          title={projectSource ? undefined : 'Attach the document you want corrected first'}
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {t('consult.generateCorrected', { format: outputFormat })}
        </Button>

        {latestPlan && (
          <div className="mt-2.5 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-border)] bg-[var(--uxe-surface-sunken)] p-3">
            {latestPlan.totalChanges === 0 ? (
              <p className="text-[12px] text-[var(--uxe-text-secondary)]">
                {t('consult.workingOutChanges')}
              </p>
            ) : (
              <>
                <p className="text-[13px] font-medium text-[var(--uxe-text)]">
                  {latestPlan.totalChanges} proposed change
                  {latestPlan.totalChanges === 1 ? '' : 's'}
                  {latestPlan.pendingChanges > 0
                    ? ` · ${latestPlan.pendingChanges} still to review`
                    : ' · all reviewed'}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  full
                  className="mt-2"
                  onClick={() => setReviewingPlanId(latestPlan.id)}
                >
                  <ClipboardCheck className="h-4 w-4" aria-hidden />
                  {t('consult.reviewProposed')}
                </Button>
              </>
            )}
          </div>
        )}
      </section>

      {coverage && (
        <section className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5">
          <h3 className="text-[14px] font-semibold text-[var(--uxe-text)]">
            {t('consult.evidenceCoverage')}
          </h3>
          <div className="mt-3 flex items-center gap-4">
            <Gauge
              value={coverage.score * 100}
              label={t('consult.evidenceCoverage')}
              tone={coverage.score >= 0.9 ? 'success' : coverage.score >= 0.6 ? 'brand' : 'warning'}
              size={88}
            />
            <ul className="min-w-0 flex-1 space-y-1.5 text-[13px]">
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--uxe-cobalt)]" />
                {t('consult.citedPassages', { count: coverage.citedPassages })}
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--uxe-violet)]" />
                {t('consult.regulations', { count: coverage.regulationsUsed })}
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-2 w-2 rounded-full bg-[var(--uxe-teal)]" />
                {t('consult.projectDocuments', { count: coverage.projectDocumentsUsed })}
              </li>
            </ul>
          </div>

          {coverage.unverifiedCitations > 0 ? (
            <Badge tone="warning" className="mt-3">
              {coverage.unverifiedCitations} unverified citation
              {coverage.unverifiedCitations === 1 ? '' : 's'}
            </Badge>
          ) : (
            <Badge
              tone="success"
              className="mt-3"
              icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
            >
              {t('compliance.sourcesVerified')}
            </Badge>
          )}
        </section>
      )}

      <section className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5">
        <h3 className="text-[14px] font-semibold text-[var(--uxe-text)]">
          {t('consult.responseControls')}
        </h3>
        <SwitchField
          label={t('consult.knowledgeOnly')}
          checked={consultation.responseControls.knowledgeOnly}
          onCheckedChange={(checked) =>
            update.mutate({
              responseControls: { ...consultation.responseControls, knowledgeOnly: checked },
            })
          }
        />
        <SwitchField
          label={t('consult.askWhenUncertain')}
          checked={consultation.responseControls.askWhenUncertain}
          onCheckedChange={(checked) =>
            update.mutate({
              responseControls: { ...consultation.responseControls, askWhenUncertain: checked },
            })
          }
        />
        <SwitchField
          label={t('consult.generalFallback')}
          description={t('consult.generalFallbackHint')}
          checked={consultation.responseControls.generalModelFallback}
          onCheckedChange={(checked) =>
            update.mutate({
              responseControls: { ...consultation.responseControls, generalModelFallback: checked },
            })
          }
        />
      </section>

      <Button
        variant="secondary"
        full
        onClick={() => generate.mutate({ kind: 'compliance_report', format: 'pdf' })}
        loading={generate.isPending && generate.variables?.kind === 'compliance_report'}
        disabled={!latestAnswer}
      >
        <FileText className="h-4 w-4" aria-hidden />
        {t('consult.createReport')}
      </Button>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1"
          onClick={() => generate.mutate({ kind: 'evidence_matrix', format: 'csv' })}
          loading={
            generate.isPending &&
            generate.variables?.kind === 'evidence_matrix' &&
            generate.variables.format === 'csv'
          }
          disabled={!latestAnswer}
        >
          <Table2 className="h-4 w-4" aria-hidden />
          {t('evidence.downloadCsv')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1"
          onClick={() => generate.mutate({ kind: 'evidence_matrix', format: 'xlsx' })}
          loading={
            generate.isPending &&
            generate.variables?.kind === 'evidence_matrix' &&
            generate.variables.format === 'xlsx'
          }
          disabled={!latestAnswer}
        >
          <Table2 className="h-4 w-4" aria-hidden />
          {t('evidence.downloadXlsx')}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <aside
        className="hidden w-[var(--uxe-rail-width)] shrink-0 overflow-y-auto border-s border-[var(--uxe-border)] bg-[var(--uxe-surface)] p-4 xl:block"
        aria-label={t('consult.evidenceOutput')}
      >
        <h2 className="mb-4 text-[16px] font-semibold text-[var(--uxe-text)]">
          {t('consult.evidenceOutput')}
        </h2>
        {content}
      </aside>

      <SlideOver
        open={open}
        onOpenChange={onOpenChange}
        title={t('consult.evidenceOutput')}
        width="md"
      >
        {content}
      </SlideOver>

      {reviewingPlanId && (
        <CorrectionReviewDialog
          open
          onOpenChange={(next) => !next && setReviewingPlanId(null)}
          planId={reviewingPlanId}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Source selector                                                            */
/* -------------------------------------------------------------------------- */

export function SourceSelectorDialog({
  open,
  onOpenChange,
  consultation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  consultation: ConsultationDetail;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(consultation.sources.filter((s) => s.role === 'governing').map((s) => s.sourceId)),
  );

  // Re-seed on the open transition, during render: an effect would show last time's
  // selection for one frame before correcting itself.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setSelected(
        new Set(consultation.sources.filter((s) => s.role === 'governing').map((s) => s.sourceId)),
      );
    }
  }

  // Only sources the caller may actually see are returned; the permission filter runs
  // server-side, so this list can never offer a restricted document.
  const sources = useQuery<SourcesResponse, ApiError>({
    queryKey: ['sources', 'selector', query],
    queryFn: () =>
      api.get<SourcesResponse>(
        `/sources?status=ready&pageSize=100${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      ),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/consultations/${consultation.id}`, {
        sourceIds: [...selected],
        version: consultation.version,
      }),
    onSuccess: () => {
      push({ tone: 'success', title: 'Sources updated' });
      void queryClient.invalidateQueries({ queryKey: ['consultation', consultation.id] });
      onOpenChange(false);
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not update sources', description: error.message }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('consult.manageSources')}
      description="Choose the approved sources Ayumi may use. The version in force today is pinned to this consultation."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            {t('common.save')} ({selected.size})
          </Button>
        </>
      }
    >
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('knowledge.searchPlaceholder')}
        aria-label={t('knowledge.searchPlaceholder')}
        iconLeft={<Search className="h-4 w-4" aria-hidden />}
        className="mb-4"
      />

      {sources.isLoading ? (
        <LoadingRegion label={t('consult.loadingSources')}>
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        </LoadingRegion>
      ) : (sources.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title={t('consult.noReadySources')}
          description={t('consult.noReadySourcesHint')}
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sources.data?.items.map((source) => (
            <li key={source.id}>
              <label
                htmlFor={`source-select-${source.id}`}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-[var(--uxe-radius-card)] border p-3 transition-colors',
                  selected.has(source.id)
                    ? 'border-[var(--uxe-cobalt)] bg-[var(--uxe-surface-selected)]'
                    : 'border-[var(--uxe-border)] hover:bg-[var(--uxe-surface-hover)]',
                )}
              >
                <Checkbox
                  id={`source-select-${source.id}`}
                  checked={selected.has(source.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(source.id);
                      else next.delete(source.id);
                      return next;
                    })
                  }
                  ariaLabel={`Select ${source.title}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-[var(--uxe-text)]">
                    {source.title}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-[var(--uxe-text-secondary)]">
                    {source.currentVersion}
                    {source.pages !== null && ` · ${source.pages} pages`}
                    {source.effectiveDate &&
                      ` · effective ${new Date(source.effectiveDate).getFullYear()}`}
                    {` · ${source.accessLabel}`}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function ConsultSkeleton() {
  const { t } = useI18n();
  return (
    <LoadingRegion label={t('consult.loadingOne')}>
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </LoadingRegion>
  );
}

export { Field, Tooltip };
