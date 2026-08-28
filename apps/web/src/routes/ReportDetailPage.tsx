import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, FileText, Info, ShieldCheck } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  ErrorState,
  LoadingRegion,
  Skeleton,
  formatBytes,
  formatDateTime,
  useToast,
} from '@uxe/ui';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { PageHeader } from '../components/PageHeader.js';

interface ArtifactDetail {
  id: string;
  title: string;
  kind: string;
  documentType: string;
  sizeBytes: number;
  sha256: string;
  status: string;
  generatorDescriptor: string;
  changeLog: Array<{
    ordinal: number;
    locator: string;
    before: string;
    after: string;
    reason: string;
    governingCitation: string | null;
  }>;
  disclosures: string[];
  validation: { checks?: Array<{ name: string; passed: boolean; detail: string }> };
  createdAt: string;
}

export function ReportDetailPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const { t } = useI18n();
  const { push } = useToast();

  const query = useQuery<ArtifactDetail, ApiError>({
    queryKey: ['artifact', reportId],
    queryFn: () => api.get<ArtifactDetail>(`/artifacts/${reportId}`),
    enabled: Boolean(reportId),
  });

  const download = useMutation({
    mutationFn: () => api.get<{ url: string; fileName: string }>(`/artifacts/${reportId}/download`),
    onSuccess: (result) => {
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

  if (query.isLoading) {
    return (
      <LoadingRegion label={t('report.loading')}>
        <div className="mx-auto w-full max-w-[1000px] p-6">
          <Skeleton className="h-9 w-72" />
          <Skeleton className="mt-4 h-40 w-full" />
        </div>
      </LoadingRegion>
    );
  }

  if (query.error) {
    return (
      <div className="p-6">
        <ErrorState
          labels={{ retry: t('common.retry'), reference: t('common.reference') }}
          message={query.error.message}
          traceId={query.error.traceId}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }

  const artifact = query.data;
  if (!artifact) return null;

  return (
    <div className="mx-auto w-full max-w-[1000px] p-4 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="mb-3">
        <Link to="/reports">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('reports.title')}
        </Link>
      </Button>

      <PageHeader
        icon={<FileText className="h-5 w-5" aria-hidden />}
        title={artifact.title}
        subtitle={`${artifact.documentType.toUpperCase()} · ${formatBytes(artifact.sizeBytes)} · ${formatDateTime(artifact.createdAt)}`}
        actions={
          <Button
            variant="primary"
            onClick={() => download.mutate()}
            loading={download.isPending}
            disabled={artifact.status !== 'ready'}
          >
            <Download className="h-4 w-4" aria-hidden />
            {t('reports.download')}
          </Button>
        }
      />

      <div className="mt-5 flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('reports.generatedBy')}</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
            <Row label={t('report.generator')}>{artifact.generatorDescriptor}</Row>
            <Row label={t('report.checksum')}>
              <span className="font-[family-name:var(--uxe-font-mono)] text-[11px]">
                {artifact.sha256.slice(0, 24)}…
              </span>
            </Row>
            <Row label={t('report.status')}>
              <Badge tone={artifact.status === 'ready' ? 'success' : 'neutral'} size="sm">
                {artifact.status}
              </Badge>
            </Row>
          </dl>
        </Card>

        {artifact.validation.checks && artifact.validation.checks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t('report.validation')}</CardTitle>
            </CardHeader>
            <ul className="flex flex-col gap-2">
              {artifact.validation.checks.map((check) => (
                <li key={check.name} className="flex items-start gap-2.5 text-[13px]">
                  <ShieldCheck
                    className={`mt-0.5 h-4 w-4 shrink-0 ${check.passed ? 'text-[var(--uxe-success)]' : 'text-[var(--uxe-danger)]'}`}
                    aria-hidden
                  />
                  <span>
                    <span className="font-medium text-[var(--uxe-text)]">
                      {check.name.replace(/_/g, ' ')}
                    </span>
                    <span className="ms-2 text-[var(--uxe-text-secondary)]">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {artifact.disclosures.length > 0 && (
          <Card className="border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)]">
            <CardHeader>
              <CardTitle className="text-[var(--uxe-warning)]">
                {t('reports.disclosures')}
              </CardTitle>
            </CardHeader>
            <ul className="flex flex-col gap-2">
              {artifact.disclosures.map((note, index) => (
                <li
                  key={index}
                  className="flex items-start gap-2 text-[13px] text-[var(--uxe-text)]"
                >
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--uxe-warning)]" aria-hidden />
                  {note}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {artifact.changeLog.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t('reports.changeLog')}</CardTitle>
            </CardHeader>
            <ol className="flex flex-col gap-4">
              {artifact.changeLog.map((entry) => (
                <li
                  key={entry.ordinal}
                  className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5"
                >
                  <p className="text-[13px] font-semibold text-[var(--uxe-text)]">
                    {entry.ordinal}. {entry.locator}
                  </p>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] p-2.5">
                      <p className="text-[11px] font-semibold text-[var(--uxe-danger)] uppercase">
                        {t('report.before')}
                      </p>
                      <p className="mt-1 text-[13px] text-[var(--uxe-text)]">
                        {entry.before || '(nothing at this location)'}
                      </p>
                    </div>
                    <div className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-success-border)] bg-[var(--uxe-success-bg)] p-2.5">
                      <p className="text-[11px] font-semibold text-[var(--uxe-success)] uppercase">
                        {t('report.after')}
                      </p>
                      <p className="mt-1 text-[13px] text-[var(--uxe-text)]">{entry.after}</p>
                    </div>
                  </div>
                  <p className="mt-2 text-[12px] text-[var(--uxe-text-secondary)]">
                    {entry.reason}
                  </p>
                  {entry.governingCitation && (
                    <p className="mt-1 text-[12px] font-medium text-[var(--uxe-cobalt)]">
                      {entry.governingCitation}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--uxe-text-secondary)]">{label}</dt>
      <dd className="font-medium text-[var(--uxe-text)]">{children}</dd>
    </>
  );
}
