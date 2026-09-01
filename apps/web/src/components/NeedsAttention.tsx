import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, Info, XCircle } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  Dialog,
  LoadingRegion,
  Skeleton,
  StaleNotice,
  cn,
  useToast,
} from '@uxe/ui';
import type { AttentionItem, AttentionResponse, ResolveAttentionResponse } from '@uxe/contracts';
import { type ApiError, api } from '../lib/api.js';
import { useI18n } from '../lib/i18n.js';
import { hasStalled } from '../lib/staleness.js';

/**
 * The one query behind both the bell and the list it opens.
 *
 * Shared so the badge and the page can never disagree: resolving something on the page
 * invalidates this key, and the count in the header follows in the same render. Keeping
 * two separate reads in sync by hand is how a bell ends up advertising work that was
 * finished ten minutes ago.
 */
export const ATTENTION_QUERY_KEY = ['attention'] as const;

export function useAttention() {
  return useQuery<AttentionResponse, ApiError>({
    queryKey: ATTENTION_QUERY_KEY,
    queryFn: () => api.get<AttentionResponse>('/dashboard/attention'),
    // Long enough that moving between pages does not re-ask, short enough that a badge is
    // not stale for a whole session. A refetch on focus covers coming back to the tab.
    staleTime: 60_000,
  });
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

/**
 * What a person can actually do about each thing raised here.
 *
 * Three have a fix the product carries out; two do not. A non-compliant finding and a
 * requirement short of evidence are statements about a real building, and no button on a
 * screen makes either untrue — so the action for those says what it is, records who said
 * it, and leaves the finding exactly where it is in the review.
 */
const ATTENTION_FIX: Record<AttentionItem['kind'], { label: string; explain: string }> = {
  failed_job: {
    label: 'Run it again',
    explain: 'Queues the job again. It leaves this list once it finishes.',
  },
  stale_knowledge: {
    label: 'Re-index this document',
    explain: 'Extracts and indexes it again from the stored file, refreshing its timestamps.',
  },
  pending_review: {
    label: 'Mark as read',
    explain: 'The report stays in Reports; it stops being flagged as waiting for somebody.',
  },
  critical_gap: {
    label: 'Mark as handled',
    explain:
      'The finding stays in its review with its evidence — nothing here makes it compliant. This only records that somebody has seen it, so it stops being raised.',
  },
  unresolved_evidence: {
    label: 'Mark as handled',
    explain:
      'The requirement still needs evidence and stays in its review. This only records that somebody has seen it, so it stops being raised.',
  },
};

/**
 * Everything needing attention, in full.
 *
 * This used to be a sidebar card on the dashboard capped at eight, which meant the ninth
 * item existed but had nowhere to be seen. It lives on the page the bell opens now, and
 * shows the whole list.
 */
export function NeedsAttention() {
  const { t } = useI18n();
  const query = useAttention();
  const [open, setOpen] = useState<AttentionItem | null>(null);

  if (query.isLoading) {
    return (
      <Card flush className="p-5">
        <LoadingRegion label={t('attention.loading')}>
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </LoadingRegion>
      </Card>
    );
  }

  // A list of open problems that quietly stopped updating is the worst thing to render
  // confidently, so a failed refresh says so above the last good copy rather than
  // replacing it.
  const stalled = hasStalled(query);
  const items = query.data?.items ?? [];

  return (
    <Card flush>
      <CardHeader className="mb-0 p-5 pb-3">
        <CardTitle>{t('attention.title')}</CardTitle>
        {items.length > 0 && (
          <Badge tone="danger" size="sm">
            {items.length}
          </Badge>
        )}
      </CardHeader>

      {stalled && (
        <div className="px-5 pb-3">
          <StaleNotice
            labels={{ paused: t('common.updatesPaused'), retry: t('common.retryNow') }}
            message={query.error?.message ?? 'This list has stopped refreshing.'}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      )}

      {items.length === 0 ? (
        <div className="px-5 pb-6">
          <div className="flex items-center gap-3 rounded-[var(--uxe-radius-card)] bg-[var(--uxe-success-bg)] p-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--uxe-success)]" aria-hidden />
            <p className="text-[13px] font-medium text-[var(--uxe-success)]">
              {t('attention.allClear')}
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
                <button
                  type="button"
                  onClick={() => setOpen(item)}
                  className="flex w-full items-start gap-3 px-5 py-3.5 text-start transition-colors hover:bg-[var(--uxe-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--uxe-cobalt)]"
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
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {query.data?.truncated === true && (
        <p className="border-t border-[var(--uxe-border)] px-5 py-3 text-[12px] text-[var(--uxe-text-secondary)]">
          {t('attention.truncated', { shown: String(items.length) })}
        </p>
      )}

      <AttentionDialog item={open} onOpenChange={(next) => !next && setOpen(null)} />
    </Card>
  );
}

function AttentionDialog({
  item,
  onOpenChange,
}: {
  item: AttentionItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const resolve = useMutation({
    mutationFn: () =>
      api.post<ResolveAttentionResponse>(`/dashboard/attention/${item?.id ?? ''}/resolve`, {
        kind: item?.kind,
      }),
    onSuccess: (result) => {
      push({
        tone: 'success',
        title: result.outcome === 'fixed' ? 'Done' : 'Marked as handled',
        description: result.detail,
      });
      // The item goes because the list is re-read, not because the row was hidden locally
      // — if the condition is somehow still there, it should still be shown.
      void queryClient.invalidateQueries({ queryKey: ATTENTION_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onOpenChange(false);
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not do that', description: error.message }),
  });

  const fix = item ? ATTENTION_FIX[item.kind] : null;

  return (
    <Dialog
      open={item !== null}
      onOpenChange={onOpenChange}
      title={item?.title ?? ''}
      description={item?.detail}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          {item && (
            <Button variant="secondary" asChild>
              <Link to={item.href}>{t('dashboard.openIt')}</Link>
            </Button>
          )}
          <Button variant="primary" loading={resolve.isPending} onClick={() => resolve.mutate()}>
            {fix?.label ?? 'Fix the issue'}
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-relaxed text-[var(--uxe-text)]">{fix?.explain}</p>
    </Dialog>
  );
}
