import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Database,
  FileText,
  Info,
  MessageSquare,
  PieChart,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  AreaChart,
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  DataTable,
  DonutChart,
  EmptyState,
  ErrorState,
  LoadingRegion,
  Select,
  Skeleton,
  useToast,
  cn,
  formatRelative,
} from '@uxe/ui';
import type { DashboardResponse } from '@uxe/contracts';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { Ayumi } from '../components/Brand.js';
import { PageHeader } from '../components/PageHeader.js';

/** Reproduces `assets/screens/02-dashboard.png`. */
export function DashboardPage() {
  const { t, locale, formatNumber } = useI18n();
  const navigate = useNavigate();
  const { push } = useToast();
  const [days, setDays] = useState(30);
  const [showTable, setShowTable] = useState(false);

  /*
   * "Start consultation" starts one.
   *
   * It used to navigate to /consult, which has nothing open, so the button labelled start
   * landed on a page inviting you to start — two clicks and an identical screen for what
   * reads as a single action. It creates the consultation and opens it.
   */
  const start = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/consultations', { title: 'New consultation', taskMode: 'ask' }),
    onSuccess: (created) => navigate(`/consult/${created.id}`),
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not start a consultation', description: error.message }),
  });

  const query = useQuery<DashboardResponse, ApiError>({
    queryKey: ['dashboard', days],
    queryFn: () => api.get<DashboardResponse>(`/dashboard?days=${days}`),
  });

  if (query.isLoading) return <DashboardSkeleton />;

  if (query.error) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorState
          labels={{ retry: t('common.retry'), reference: t('common.reference') }}
          message={query.error.message}
          traceId={query.error.traceId}
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
      </div>
    );
  }

  const data = query.data;
  if (!data) return null;

  const isEmpty =
    data.activity.total === 0 &&
    data.recentConsultations.length === 0 &&
    data.readySourceCount === 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-6">
      <h1 className="sr-only">{t('nav.dashboard')}</h1>

      <div className="flex min-w-0 flex-col gap-5">
        <GreetingBanner
          name={data.greetingName}
          onStart={() => start.mutate()}
          starting={start.isPending}
        />

        {isEmpty ? (
          <Card>
            <EmptyState
              icon={<Sparkles className="h-7 w-7" aria-hidden />}
              title={t('dashboard.emptyTitle')}
              description={t('dashboard.emptyBody')}
              action={
                <Button variant="primary" onClick={() => navigate('/settings/knowledge')}>
                  {t('dashboard.addSources')}
                </Button>
              }
              secondaryAction={
                <Button
                  variant="secondary"
                  onClick={() => start.mutate()}
                  loading={start.isPending}
                >
                  {t('dashboard.startConsultation')}
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            <section
              aria-label={t('dashboard.keyMetrics')}
              className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              {data.kpis.map((kpi) => (
                <KpiCard key={kpi.key} kpi={kpi} days={days} />
              ))}
            </section>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
              <Card className="flex flex-col">
                <CardHeader>
                  <CardTitle>{t('dashboard.activity')}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="xs" onClick={() => setShowTable((v) => !v)}>
                      {showTable ? t('dashboard.hideTable') : t('dashboard.showTable')}
                    </Button>
                    <Select
                      value={String(days)}
                      onValueChange={(value) => setDays(Number(value))}
                      ariaLabel={t('dashboard.dateRange')}
                      size="sm"
                      options={[
                        { value: '7', label: t('dashboard.last7') },
                        { value: '30', label: t('dashboard.last30') },
                        { value: '90', label: t('dashboard.last90') },
                      ]}
                    />
                  </div>
                </CardHeader>
                <div className="flex min-h-0 flex-1 flex-col justify-center">
                  <AreaChart
                    points={data.activity.points.map((point) => ({
                      label: new Intl.DateTimeFormat(locale, {
                        month: 'short',
                        day: 'numeric',
                      }).format(new Date(point.date)),
                      value: point.consultations,
                    }))}
                    ariaLabel={`${t('dashboard.activity')}, last ${days} days`}
                    valueLabel={t('dashboard.consultations')}
                    showTable={showTable}
                  />
                </div>
              </Card>

              <Card className="flex flex-col">
                <CardHeader>
                  <CardTitle>{t('dashboard.complianceOutcomes')}</CardTitle>
                </CardHeader>
                <div className="flex min-h-0 flex-1 items-center">
                  <ComplianceDonut outcomes={data.complianceOutcomes} />
                </div>
              </Card>
            </div>

            <Card flush>
              <CardHeader className="mb-0 p-5 pb-3">
                <CardTitle>{t('dashboard.recentConsultations')}</CardTitle>
                <Link
                  to="/consult"
                  className="text-[13px] font-semibold text-[var(--uxe-cobalt)] hover:underline"
                >
                  {t('dashboard.viewAllConsultations')}
                </Link>
              </CardHeader>
              <div className="px-3 pb-3 sm:px-5 sm:pb-5">
                <DataTable
                  caption={t('dashboard.recentConsultations')}
                  rows={data.recentConsultations}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => navigate(`/consult/${row.id}`)}
                  empty={
                    <EmptyState
                      icon={<MessageSquare className="h-6 w-6" aria-hidden />}
                      title={t('dashboard.noConsultations')}
                      description={t('dashboard.noConsultationsHint')}
                      action={
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => start.mutate()}
                          loading={start.isPending}
                        >
                          {t('dashboard.startConsultation')}
                        </Button>
                      }
                    />
                  }
                  columns={[
                    {
                      key: 'title',
                      header: t('table.consultation'),
                      primary: true,
                      render: (row) => (
                        <span className="flex items-center gap-2.5">
                          <span
                            aria-hidden
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)] bg-[var(--uxe-surface-selected)] text-[var(--uxe-cobalt)]"
                          >
                            <FileText className="h-4 w-4" />
                          </span>
                          <span className="truncate font-medium">{row.title}</span>
                        </span>
                      ),
                    },
                    {
                      key: 'status',
                      header: t('table.status'),
                      render: (row) => <StatusBadge status={row.status} />,
                    },
                    {
                      key: 'compliance',
                      header: t('table.compliance'),
                      align: 'right',
                      render: (row) =>
                        row.complianceScore === null ? (
                          <span className="text-[var(--uxe-text-tertiary)]">—</span>
                        ) : (
                          <span
                            className={cn(
                              'font-semibold tabular-nums',
                              row.complianceScore >= 90
                                ? 'text-[var(--uxe-success)]'
                                : row.complianceScore >= 70
                                  ? 'text-[var(--uxe-warning)]'
                                  : 'text-[var(--uxe-danger)]',
                            )}
                          >
                            {Math.round(row.complianceScore)}%
                          </span>
                        ),
                    },
                    {
                      key: 'sources',
                      header: t('table.sources'),
                      align: 'right',
                      render: (row) => (
                        <span className="text-[var(--uxe-cobalt)] tabular-nums">
                          {formatNumber(row.sourceCount)}
                        </span>
                      ),
                    },
                    {
                      key: 'updated',
                      header: t('table.updated'),
                      render: (row) => (
                        <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                          {formatRelative(row.updatedAt, locale)}
                        </span>
                      ),
                    },
                    {
                      key: 'owner',
                      header: t('table.owner'),
                      render: (row) => (
                        <span className="flex items-center gap-2">
                          <Avatar name={row.ownerName} src={row.ownerAvatarUrl} size={24} />
                          <span className="truncate">{row.ownerName}</span>
                        </span>
                      ),
                    },
                  ]}
                />
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function GreetingBanner({
  name,
  onStart,
  starting,
}: {
  name: string;
  onStart: () => void;
  starting: boolean;
}) {
  const { t } = useI18n();
  const hour = new Date().getHours();
  const key =
    hour < 12
      ? 'dashboard.goodMorning'
      : hour < 18
        ? 'dashboard.goodAfternoon'
        : 'dashboard.goodEvening';

  return (
    <Card
      flush
      className="relative overflow-hidden bg-[linear-gradient(100deg,var(--uxe-surface)_0%,var(--uxe-surface-selected)_100%)]"
    >
      <div className="flex items-center gap-4 p-4 sm:gap-6 sm:p-5">
        {/* Ayumi is decorative here — the greeting text carries the meaning — and she is
            sized so she never overlaps the primary action. */}
        <div className="hidden h-24 w-24 shrink-0 sm:block">
          <Ayumi variant="sm" decorative />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[22px] font-bold text-[var(--uxe-text)] sm:text-[26px]">
            {t(key, { name })}
          </h2>
          <p className="mt-1 text-[14px] text-[var(--uxe-text-secondary)]">
            {t('dashboard.greetingSub')}
          </p>
        </div>
        <Button
          variant="primary"
          size="lg"
          onClick={onStart}
          loading={starting}
          className="shrink-0 max-sm:h-11 max-sm:px-4"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          <span className="max-sm:sr-only">{t('dashboard.startConsultation')}</span>
        </Button>
      </div>
    </Card>
  );
}

const KPI_META = {
  consultations: { icon: MessageSquare, tone: 'violet' },
  documents_reviewed: { icon: FileText, tone: 'cobalt' },
  compliance_rate: { icon: ShieldCheck, tone: 'success' },
  evidence_coverage: { icon: PieChart, tone: 'teal' },
} as const;

const KPI_TONES = {
  violet: 'bg-[color-mix(in_srgb,var(--uxe-violet)_14%,transparent)] text-[var(--uxe-violet)]',
  cobalt: 'bg-[color-mix(in_srgb,var(--uxe-cobalt)_14%,transparent)] text-[var(--uxe-cobalt)]',
  success: 'bg-[var(--uxe-success-bg)] text-[var(--uxe-success-text)]',
  teal: 'bg-[var(--uxe-teal-bg)] text-[var(--uxe-teal-text)]',
} as const;

function KpiCard({ kpi, days }: { kpi: DashboardResponse['kpis'][number]; days: number }) {
  const { t, formatNumber } = useI18n();
  const meta = KPI_META[kpi.key];
  const Icon = meta.icon;
  const labelKey = {
    consultations: 'dashboard.consultations',
    documents_reviewed: 'dashboard.documentsReviewed',
    compliance_rate: 'dashboard.complianceRate',
    evidence_coverage: 'dashboard.evidenceCoverage',
  }[kpi.key] as 'dashboard.consultations';

  const positive = (kpi.changePercent ?? 0) >= 0;

  return (
    // Every metric drills into the page that explains it.
    <Link
      to={kpi.href}
      className="group rounded-[var(--uxe-radius-card)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uxe-cobalt)]"
    >
      <Card className="h-full p-4 transition-shadow duration-[var(--uxe-duration)] group-hover:shadow-[var(--uxe-shadow-md)]">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--uxe-radius-card)]',
              KPI_TONES[meta.tone],
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[12px] leading-tight font-medium text-[var(--uxe-text-secondary)]">
              {t(labelKey)}
            </p>
            <p className="mt-1 text-[26px] leading-none font-bold text-[var(--uxe-text)] tabular-nums">
              {kpi.unit === 'percent' ? `${Math.round(kpi.value)}%` : formatNumber(kpi.value)}
            </p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          {kpi.changePercent === null ? (
            <span className="text-[12px] text-[var(--uxe-text-tertiary)]">
              {t('dashboard.noPriorPeriod')}
            </span>
          ) : (
            <>
              <Badge
                tone={positive ? 'success' : 'danger'}
                size="sm"
                icon={
                  positive ? (
                    <TrendingUp className="h-3 w-3" aria-hidden />
                  ) : (
                    <TrendingDown className="h-3 w-3" aria-hidden />
                  )
                }
              >
                {positive ? '+' : ''}
                {kpi.changePercent}%
              </Badge>
              <span className="text-[11.5px] whitespace-nowrap text-[var(--uxe-text-secondary)]">
                {t('dashboard.vsLastDays', { days })}
              </span>
            </>
          )}
        </div>
      </Card>
    </Link>
  );
}

function ComplianceDonut({ outcomes }: { outcomes: DashboardResponse['complianceOutcomes'] }) {
  const { t } = useI18n();
  const navigate = useNavigate();

  if (outcomes.total === 0) {
    return (
      <EmptyState
        icon={<PieChart className="h-6 w-6" aria-hidden />}
        title={t('dashboard.noReviews')}
        description={t('dashboard.noReviewsHint')}
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate('/consult')}>
            {t('dashboard.runReview')}
          </Button>
        }
      />
    );
  }

  return (
    <DonutChart
      total={outcomes.total}
      centerLabel={t('dashboard.total')}
      ariaLabel={t('dashboard.complianceOutcomes')}
      segments={[
        {
          label: t('compliance.compliant'),
          value: outcomes.compliant,
          color: 'var(--uxe-success)',
        },
        {
          label: t('compliance.needsEvidence'),
          value: outcomes.needsEvidence,
          color: 'var(--uxe-warning)',
        },
        {
          label: t('compliance.nonCompliant'),
          value: outcomes.nonCompliant,
          color: 'var(--uxe-danger)',
        },
        {
          label: t('compliance.notAssessed'),
          value: outcomes.notAssessed,
          color: 'var(--uxe-border-strong)',
        },
      ]}
    />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const map: Record<
    string,
    {
      tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';
      label: string;
      icon: typeof CheckCircle2;
    }
  > = {
    report_ready: {
      tone: 'success',
      label: t('consultationStatus.report_ready'),
      icon: CheckCircle2,
    },
    action_required: {
      tone: 'danger',
      label: t('consultationStatus.action_required'),
      icon: AlertTriangle,
    },
    processing: { tone: 'info', label: t('consultationStatus.processing'), icon: Circle },
    active: { tone: 'brand', label: t('consultationStatus.active'), icon: MessageSquare },
    awaiting_input: { tone: 'warning', label: t('consultationStatus.awaiting_input'), icon: Info },
    draft: { tone: 'neutral', label: t('consultationStatus.draft'), icon: FileText },
    archived: { tone: 'neutral', label: t('consultationStatus.archived'), icon: Database },
  };
  // A status this build has never heard of is shown as the server named it rather than
  // hidden: an untranslated word beats a blank badge.
  const entry = map[status] ?? { tone: 'neutral' as const, label: status, icon: Info };
  const Icon = entry.icon;

  return (
    <Badge tone={entry.tone} size="sm" icon={<Icon className="h-3 w-3" aria-hidden />}>
      {entry.label}
    </Badge>
  );
}

function DashboardSkeleton() {
  const { t } = useI18n();
  return (
    <LoadingRegion label={t('dashboard.loading')}>
      <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-6">
        {/* The same shape the loaded page has, so nothing jumps when it arrives. */}
        <div className="flex flex-col gap-5">
          <Skeleton className="h-[124px] w-full rounded-[var(--uxe-radius-card)]" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[132px] rounded-[var(--uxe-radius-card)]" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <Skeleton className="h-[280px] rounded-[var(--uxe-radius-card)]" />
            <Skeleton className="h-[280px] rounded-[var(--uxe-radius-card)]" />
          </div>
          <Skeleton className="h-[260px] rounded-[var(--uxe-radius-card)]" />
        </div>
      </div>
    </LoadingRegion>
  );
}

export { PageHeader };
