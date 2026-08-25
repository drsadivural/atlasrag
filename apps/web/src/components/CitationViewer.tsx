import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, ExternalLink, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Badge, Button, ErrorState, LoadingRegion, SlideOver, Skeleton, cn } from '@uxe/ui';
import { formatLocator, type CitationResolution } from '@uxe/contracts';
import { ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';

export interface CitationViewerProps {
  citationId: string | null;
  onClose: () => void;
  onNavigate: (citationId: string) => void;
}

/**
 * Opens a citation at its exact location and highlights the cited passage.
 *
 * The highlight is computed server-side from the STORED page text, so what is shown is the
 * real source, not a re-render of the model's output. Keyboard focus moves to the
 * highlighted passage when it opens, which is what makes the evidence reachable without a
 * mouse.
 */
export function CitationViewer({ citationId, onClose, onNavigate }: CitationViewerProps) {
  const { t } = useI18n();
  const highlightRef = useRef<HTMLElement>(null);

  const query = useQuery<CitationResolution, ApiError>({
    queryKey: ['citation', citationId],
    queryFn: () => api.get<CitationResolution>(`/citations/${citationId}`),
    enabled: citationId !== null,
  });

  // Move focus onto the passage itself once it renders, and scroll it into view.
  useEffect(() => {
    if (!query.data) return;
    const timer = setTimeout(() => {
      highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      highlightRef.current?.focus();
    }, 60);
    return () => clearTimeout(timer);
  }, [query.data]);

  const segments = useMemo(() => {
    const data = query.data;
    if (!data) return null;
    if (!data.highlight) return { before: data.pageText, match: '', after: '' };
    return {
      before: data.pageText.slice(0, data.highlight.start),
      match: data.pageText.slice(data.highlight.start, data.highlight.end),
      after: data.pageText.slice(data.highlight.end),
    };
  }, [query.data]);

  const citation = query.data?.citation;

  return (
    <SlideOver
      open={citationId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={query.data?.documentTitle ?? t('evidence.title')}
      description={citation ? formatLocator(citation) : undefined}
      width="lg"
      footer={
        query.data ? (
          <div className="flex w-full items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={!query.data.previousCitationId}
                onClick={() => query.data?.previousCitationId && onNavigate(query.data.previousCitationId)}
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
                {t('evidence.previousCitation')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!query.data.nextCitationId}
                onClick={() => query.data?.nextCitationId && onNavigate(query.data.nextCitationId)}
              >
                {t('evidence.nextCitation')}
                <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            {query.data.downloadUrl && (
              <Button variant="secondary" size="sm" asChild>
                <a href={query.data.downloadUrl} rel="noreferrer">
                  <Download className="h-4 w-4" aria-hidden />
                  Original
                </a>
              </Button>
            )}
          </div>
        ) : null
      }
    >
      {query.isLoading && (
        <LoadingRegion label="Loading citation">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-64 w-full" />
          </div>
        </LoadingRegion>
      )}

      {query.error && (
        <ErrorState
          title="This citation could not be opened"
          message={query.error.message}
          traceId={query.error.traceId}
          onRetry={() => void query.refetch()}
        />
      )}

      {query.data && citation && segments && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {citation.verified ? (
              <Badge tone="success" icon={<ShieldCheck className="h-3.5 w-3.5" aria-hidden />}>
                {t('evidence.verified')} ({citation.verificationMethod})
              </Badge>
            ) : (
              <Badge tone="warning" icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}>
                {t('evidence.unverified')}
              </Badge>
            )}
            <Badge tone="neutral">{query.data.version}</Badge>
            {citation.pageNumber !== null && query.data.totalPages !== null && (
              <Badge tone="neutral">
                Page {citation.pageNumber} of {query.data.totalPages}
              </Badge>
            )}
            {citation.entailment === 'contradicts' && <Badge tone="danger">Contradicts the claim</Badge>}
          </div>

          {!citation.verified && (
            <p className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] p-3 text-[13px] text-[var(--uxe-text)]">
              {t('evidence.unverifiedHint')}
            </p>
          )}

          <section aria-label="Source text with the cited passage highlighted">
            <div
              className={cn(
                'max-h-[60vh] overflow-y-auto rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)]',
                'bg-[var(--uxe-surface-sunken)] p-4 font-[family-name:var(--uxe-font-mono)] text-[13px] leading-relaxed',
                'whitespace-pre-wrap text-[var(--uxe-text-secondary)]',
              )}
            >
              {segments.before}
              {segments.match && (
                <mark
                  ref={highlightRef as React.Ref<HTMLElement>}
                  tabIndex={-1}
                  className="rounded bg-[var(--uxe-warning)]/35 px-0.5 font-semibold text-[var(--uxe-text)] outline-none ring-2 ring-[var(--uxe-warning)] ring-offset-2 ring-offset-[var(--uxe-surface-sunken)]"
                >
                  {segments.match}
                </mark>
              )}
              {segments.after}
            </div>
          </section>

          {citation.boundingBoxes.length > 0 && (
            <p className="text-[12px] text-[var(--uxe-text-secondary)]">
              {citation.boundingBoxes.length} highlight region
              {citation.boundingBoxes.length === 1 ? '' : 's'} located on page {citation.pageNumber} at{' '}
              {citation.boundingBoxes
                .map((box) => `${Math.round(box.x * 100)}%, ${Math.round(box.y * 100)}%`)
                .join(' · ')}
              .
            </p>
          )}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
            <Detail label="Document">{citation.documentTitle}</Detail>
            <Detail label="Version">{query.data.version}</Detail>
            {citation.chapter && <Detail label="Chapter">{citation.chapter}</Detail>}
            {citation.section && <Detail label="Section">{citation.section}</Detail>}
            {citation.clause && <Detail label="Clause">{citation.clause}</Detail>}
            {citation.pageNumber !== null && <Detail label="Page">{citation.pageNumber}</Detail>}
            {citation.sheetName && <Detail label="Sheet">{citation.sheetName}</Detail>}
            {citation.cellRange && <Detail label="Cells">{citation.cellRange}</Detail>}
            {citation.slideNumber !== null && <Detail label="Slide">{citation.slideNumber}</Detail>}
            <Detail label="Retrieval score">{citation.retrievalScore.toFixed(3)}</Detail>
            <Detail label="Rerank score">{citation.rerankScore.toFixed(3)}</Detail>
            <Detail label="Checksum">
              <span className="font-[family-name:var(--uxe-font-mono)] text-[11px]">
                {citation.sourceSha256.slice(0, 16)}…
              </span>
            </Detail>
          </dl>
        </div>
      )}
    </SlideOver>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[var(--uxe-text-secondary)]">{label}</dt>
      <dd className="text-right font-medium text-[var(--uxe-text)]">{children}</dd>
    </>
  );
}

export { ExternalLink };
