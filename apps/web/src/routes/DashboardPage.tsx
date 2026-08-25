import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Database,
  FileText,
  Info,
  MessageSquare,
  MinusCircle,
  PieChart,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  XCircle,
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
  Gauge,
  LoadingRegion,
  Select,
  Skeleton,
  Tooltip,
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
  const [days, setDays] = useState(30);
  const [showTable, setShowTable] = useState(false);

  const query = useQuery<DashboardResponse, ApiError>({
    queryKey: ['dashboard', days],
    queryFn: () => api.get<DashboardResponse>(`/dashboard?days=${days}`),
  });

  if (query.isLoading) return <DashboardSkeleton />;

  if (query.error) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorState
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
    data.knowledgeHealth.ready === 0;

  return (
    <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-6">
      <h1 className="sr-only">{t('nav.dashboard')}</h1>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <GreetingBanner name={data.greetingName} onStart={() => navigate('/consult')} />

          {isEmpty ? (
            <Card>
              <EmptyState
                icon={<Sparkles className="h-7 w-7" aria-hidden />}
                title={t('dashboard.emptyTitle')}
                description={t('dashboard.emptyBody')}
                action={
                  <Button variant="primary" onClick={() => navigate('/knowledge')}>
                    {t('dashboard.addSources')}
                  </Button>
                }
                secondaryAction={
                  <Button variant="secondary" onClick={() => navigate('/consult')}>
                    {t('dashboard.startConsultation')}
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              <section
                aria-label="Key metrics"
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
                        ariaLabel="Date range"
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
                        title="No consultations yet"
                        description="Start one to see verified answers with exact evidence."
                        action={
                          <Button variant="primary" size="sm" onClick={() => navigate('/consult')}>
                            {t('dashboard.startConsultation')}
                          </Button>
                        }
                      />
                    }
                    columns={[
                      {
                        key: 'title',
                        header: 'Consultation',
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
                        header: 'Status',
                        render: (row) => <StatusBadge status={row.status} />,
                      },
                      {
                        key: 'compliance',
                        header: 'Compliance',
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
                        header: 'Sources',
                        align: 'right',
                        render: (row) => (
                          <span className="text-[var(--uxe-cobalt)] tabular-nums">
                            {formatNumber(row.sourceCount)}
                          </span>
                        ),
                      },
                      {
                        key: 'updated',
                        header: 'Updated',
                        render: (row) => (
                          <span className="whitespace-nowrap text-[var(--uxe-text-secondary)]">
                            {formatRelative(row.updatedAt, locale)}
                          </span>
                        ),
                      },
                      {
                        key: 'owner',
                        header: 'Owner',
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

        <aside className="flex min-w-0 flex-col gap-5" aria-label="Attention and health">
          <NeedsAttentionCard items={data.needsAttention} />
          <KnowledgeHealthCard health={data.knowledgeHealth} />
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function GreetingBanner({ name, onStart }: { name: string; onStart: () => void }) {
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
            <span className="text-[12px] text-[var(--uxe-text-tertiary)]">No prior period</span>
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
        title="No reviews yet"
        description="Run a compliance review to see outcomes broken down by requirement."
        action={
          <Button variant="secondary" size="sm" onClick={() => navigate('/consult')}>
            Run a compliance review
          </Button>
        }
      />
    );
  }

  return (
    <DonutChart
      total={outcomes.total}
      centerLabel="Total"
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

const ATTENTION_ICONS = {
  failed_job: XCircle,
  critical_gap: AlertTriangle,
  unresolved_evidence: AlertTriangle,
  stale_knowledge: Info,
  pending_review: CheckCircle2,
} as const;

const SEVERITY_STYLES = {
  critical: 'bg-[var(--uxe-danger-bg)] text-[var(--uxe-danger-text)]',
  warning: 'bg-[var(--uxe-warning-bg)] text-[var(--uxe-warning-text)]',
  info: 'bg-[var(--uxe-info-bg)] text-[var(--uxe-info-text)]',
} as const;

function NeedsAttentionCard({ items }: { items: DashboardResponse['needsAttention'] }) {
  const { t } = useI18n();

  return (
    <Card flush>
      <CardHeader className="mb-0 p-5 pb-3">
        <CardTitle>{t('dashboard.needsAttention')}</CardTitle>
        {items.length > 0 && (
          <Badge tone="danger" size="sm">
            {items.length}
          </Badge>
        )}
      </CardHeader>

      {items.length === 0 ? (
        <div className="px-5 pb-6">
          <div className="flex items-center gap-3 rounded-[var(--uxe-radius-card)] bg-[var(--uxe-success-bg)] p-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--uxe-success)]" aria-hidden />
            <p className="text-[13px] font-medium text-[var(--uxe-success)]">
              Nothing needs attention right now.
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((item) => {
            const Icon = ATTENTION_ICONS[item.kind];
            return (
              <li
                key={`${item.kind}-${item.id}`}
                className="border-t border-[var(--uxe-border)] first:border-t-0"
              >
                <Link
                  to={item.href}
                  className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-[var(--uxe-surface-hover)]"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--uxe-radius-control)]',
                      SEVERITY_STYLES[item.severity],
                    )}
                  >
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-[var(--uxe-text)]">
                      {item.title}
                    </span>
                    <span
                      className={cn(
                        'mt-0.5 block text-[13px]',
                        item.severity === 'critical'
                          ? 'text-[var(--uxe-danger)]'
                          : item.severity === 'warning'
                            ? 'text-[var(--uxe-warning)]'
                            : 'text-[var(--uxe-text-secondary)]',
                      )}
                    >
                      {item.detail}
                    </span>
                  </span>
                  <ChevronRight
                    className="mt-2 h-4 w-4 shrink-0 text-[var(--uxe-text-tertiary)]"
                    aria-hidden
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function KnowledgeHealthCard({ health }: { health: DashboardResponse['knowledgeHealth'] }) {
  const { t, formatNumber } = useI18n();

  const rows = [
    {
      label: 'Sources ready',
      value: health.ready,
      icon: CheckCircle2,
      tone: 'text-[var(--uxe-success)]',
    },
    { label: 'Processing', value: health.processing, icon: Circle, tone: 'text-[var(--uxe-info)]' },
    {
      label: 'Outdated sources',
      value: health.outdated,
      icon: AlertTriangle,
      tone: 'text-[var(--uxe-warning)]',
    },
    { label: 'Failed', value: health.failed, icon: XCircle, tone: 'text-[var(--uxe-danger)]' },
    {
      label: 'Missing metadata',
      value: health.missingMetadata,
      icon: Info,
      tone: 'text-[var(--uxe-text-secondary)]',
    },
    {
      label: 'Unlinked content',
      value: health.unlinkedContent,
      icon: MinusCircle,
      tone: 'text-[var(--uxe-text-secondary)]',
    },
  ];

  const tone = health.score >= 90 ? 'success' : health.score >= 70 ? 'brand' : 'warning';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dashboard.knowledgeHealth')}</CardTitle>
        {/* The formula is exposed rather than left as an unexplained number. */}
        <Tooltip
          content={
            <span className="font-[family-name:var(--uxe-font-mono)] text-[11px]">
              {health.formula}
            </span>
          }
        >
          <button
            type="button"
            aria-label="How knowledge health is calculated"
            className="rounded p-1 text-[var(--uxe-text-tertiary)] hover:text-[var(--uxe-text)]"
          >
            <Info className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
      </CardHeader>

      <div className="flex items-center gap-5">
        <Gauge value={health.score} label={t('dashboard.knowledgeHealth')} tone={tone} size={104} />
        <ul className="min-w-0 flex-1 space-y-2">
          {rows.map((row) => (
            <li key={row.label} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="flex min-w-0 items-center gap-2">
                <row.icon className={cn('h-4 w-4 shrink-0', row.tone)} aria-hidden />
                <span className="truncate text-[var(--uxe-text-secondary)]">{row.label}</span>
              </span>
              <span className="shrink-0 font-semibold text-[var(--uxe-text)] tabular-nums">
                {formatNumber(row.value)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Button asChild variant="ghost" size="sm" className="mt-4 w-full justify-between">
        <Link to="/knowledge">
          {t('dashboard.goToKnowledgeBase')}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </Button>
    </Card>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<
    string,
    {
      tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';
      label: string;
      icon: typeof CheckCircle2;
    }
  > = {
    report_ready: { tone: 'success', label: 'Ready', icon: CheckCircle2 },
    action_required: { tone: 'danger', label: 'Action required', icon: AlertTriangle },
    processing: { tone: 'info', label: 'Processing', icon: Circle },
    active: { tone: 'brand', label: 'Active', icon: MessageSquare },
    awaiting_input: { tone: 'warning', label: 'Awaiting input', icon: Info },
    draft: { tone: 'neutral', label: 'Draft', icon: FileText },
    archived: { tone: 'neutral', label: 'Archived', icon: Database },
  };
  const entry = map[status] ?? { tone: 'neutral' as const, label: status, icon: Info };
  const Icon = entry.icon;

  return (
    <Badge tone={entry.tone} size="sm" icon={<Icon className="h-3 w-3" aria-hidden />}>
      {entry.label}
    </Badge>
  );
}

function DashboardSkeleton() {
  return (
    <LoadingRegion label="Loading dashboard">
      <div className="mx-auto w-full max-w-[1600px] p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
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
          <div className="flex flex-col gap-5">
            <Skeleton className="h-[320px] rounded-[var(--uxe-radius-card)]" />
            <Skeleton className="h-[280px] rounded-[var(--uxe-radius-card)]" />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

export { PageHeader };
