import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileWarning, Pencil, ShieldAlert, X } from 'lucide-react';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingRegion,
  Skeleton,
  Textarea,
  useToast,
} from '@uxe/ui';
import { formatLocator, type CorrectionPlan } from '@uxe/contracts';
import { type ApiError, api, newIdempotencyKey } from '../lib/api.js';

const STRATEGY_LABELS: Record<CorrectionPlan['outputStrategy'], string> = {
  in_place_text: 'Edited in place',
  tracked_changes: 'Tracked changes',
  overlay: 'Text overlay on the original pages',
  ocr_rebuild: 'Rebuilt from OCR',
  revised_edition: 'New revised edition',
};

export interface CorrectionPlanSummary {
  id: string;
  status: CorrectionPlan['status'];
  createdAt: string;
  totalChanges: number;
  acceptedChanges: number;
  pendingChanges: number;
  generatedArtifactId: string | null;
}

/**
 * Review of a correction plan.
 *
 * Nothing is written to a document from this screen. Each proposed change is accepted,
 * rejected or edited first, and generation is a separate, explicit action that reads only
 * the accepted rows — which is what "review-first" has to mean to be worth anything.
 */
export function CorrectionReviewDialog({
  open,
  onOpenChange,
  planId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId: string;
}) {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);

  const plan = useQuery<CorrectionPlan, ApiError>({
    queryKey: ['correction', planId],
    queryFn: () => api.get<CorrectionPlan>(`/corrections/${planId}`),
    enabled: open && Boolean(planId),
    refetchInterval: (result) => (result.state.data?.status === 'generating' ? 2000 : false),
  });

  const decide = useMutation({
    mutationFn: (decision: { changeId: string; status: string; editedContent: string | null }) =>
      api.patch(`/corrections/${planId}`, {
        decisions: [decision],
        version: plan.data?.version ?? 0,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['correction', planId] });
    },
    onError: (error: ApiError) =>
      push({
        tone: 'error',
        title:
          error.code === 'version_conflict'
            ? 'Somebody else reviewed this plan'
            : 'Could not record that decision',
        description:
          error.code === 'version_conflict'
            ? 'Reopen the plan to see their decisions.'
            : error.message,
      }),
  });

  const generate = useMutation({
    mutationFn: () =>
      api.post(
        `/corrections/${planId}/generate`,
        { outputFormat: 'match_source', includeRedline: true, idempotencyKey: newIdempotencyKey() },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      push({
        tone: 'success',
        title: 'Corrected edition queued',
        description: 'It appears in Reports when ready. The original is unchanged.',
      });
      void queryClient.invalidateQueries({ queryKey: ['correction', planId] });
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
    onError: (error: ApiError) =>
      push({ tone: 'error', title: 'Could not generate', description: error.message }),
  });

  const changes = plan.data?.changes ?? [];
  const acceptedCount = changes.filter(
    (c) => c.status === 'accepted' || c.status === 'edited',
  ).length;
  const pendingCount = changes.filter((c) => c.status === 'proposed').length;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Review proposed corrections"
      description="Nothing is written until you accept a change and generate the edition. The original document is never modified."
      size="xl"
      footer={
        <>
          <span className="mr-auto text-[13px] text-[var(--uxe-text-secondary)]">
            {acceptedCount} accepted · {pendingCount} still to review
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => generate.mutate()}
            loading={generate.isPending || plan.data?.status === 'generating'}
            disabled={acceptedCount === 0}
            title={acceptedCount === 0 ? 'Accept at least one change before generating' : undefined}
          >
            Generate corrected edition
          </Button>
        </>
      }
    >
      {plan.isLoading ? (
        <LoadingRegion label="Loading the correction plan">
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        </LoadingRegion>
      ) : plan.error ? (
        <ErrorState
          message={plan.error.message}
          traceId={plan.error.traceId}
          onRetry={() => void plan.refetch()}
          retrying={plan.isRefetching}
        />
      ) : changes.length === 0 ? (
        <EmptyState
          title="No changes were proposed"
          description="Nothing in this document contradicts a requirement that could be tested against it."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {plan.data?.signatureNotice && (
            <p
              role="alert"
              className="flex items-start gap-2.5 rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)] p-3 text-[13px] font-medium text-[var(--uxe-danger)]"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {plan.data.signatureNotice}
            </p>
          )}

          {(plan.data?.limitations.length ?? 0) > 0 && (
            <div className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-warning-border)] bg-[var(--uxe-warning-bg)] p-3">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--uxe-warning)]">
                <FileWarning className="h-4 w-4" aria-hidden />
                Before you generate
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {plan.data?.limitations.map((limitation, index) => (
                  <li key={index} className="text-[13px] text-[var(--uxe-text)]">
                    {limitation}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[13px] text-[var(--uxe-text-secondary)]">
            {plan.data ? STRATEGY_LABELS[plan.data.outputStrategy] : ''} ·{' '}
            {plan.data?.documentTitle}
          </p>

          <ul className="flex flex-col gap-3">
            {changes.map((change) => (
              <li
                key={change.id}
                className="rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] p-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold text-[var(--uxe-text)]">
                    {change.locatorLabel}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge
                      tone={
                        change.risk === 'critical' || change.risk === 'high'
                          ? 'danger'
                          : change.risk === 'medium'
                            ? 'warning'
                            : 'neutral'
                      }
                      size="sm"
                    >
                      {change.risk} risk
                    </Badge>
                    <Badge
                      tone={
                        change.status === 'accepted' || change.status === 'edited'
                          ? 'success'
                          : change.status === 'rejected'
                            ? 'danger'
                            : 'neutral'
                      }
                      size="sm"
                    >
                      {change.status}
                    </Badge>
                  </span>
                </div>

                <p className="mt-2 text-[13px] text-[var(--uxe-text-secondary)]">{change.reason}</p>

                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  <div className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-danger-border)] bg-[var(--uxe-danger-bg)]/40 p-2.5">
                    <p className="text-[11px] font-semibold tracking-wide text-[var(--uxe-danger)] uppercase">
                      Current
                    </p>
                    <p className="mt-1 text-[13px] text-[var(--uxe-text)]">
                      {change.currentContent}
                    </p>
                  </div>
                  <div className="rounded-[var(--uxe-radius-control)] border border-[var(--uxe-success-border)] bg-[var(--uxe-success-bg)]/40 p-2.5">
                    <p className="text-[11px] font-semibold tracking-wide text-[var(--uxe-success)] uppercase">
                      Proposed
                    </p>
                    {editing === change.id ? (
                      <Textarea
                        className="mt-1 w-full"
                        rows={3}
                        aria-label={`Edit the replacement text for ${change.locatorLabel}`}
                        value={edited[change.id] ?? change.editedContent ?? change.proposedContent}
                        onChange={(event) =>
                          setEdited((current) => ({ ...current, [change.id]: event.target.value }))
                        }
                      />
                    ) : (
                      <p className="mt-1 text-[13px] text-[var(--uxe-text)]">
                        {change.editedContent ?? change.proposedContent}
                      </p>
                    )}
                  </div>
                </div>

                {change.governingCitation && (
                  <p className="mt-2 text-[12px] text-[var(--uxe-text-secondary)]">
                    Required by {change.governingCitation.documentTitle} ·{' '}
                    {formatLocator(change.governingCitation)}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={change.status === 'accepted' ? 'primary' : 'secondary'}
                    onClick={() =>
                      decide.mutate({
                        changeId: change.id,
                        status: 'accepted',
                        editedContent: null,
                      })
                    }
                    loading={decide.isPending && decide.variables?.changeId === change.id}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant={change.status === 'rejected' ? 'danger' : 'ghost'}
                    onClick={() =>
                      decide.mutate({
                        changeId: change.id,
                        status: 'rejected',
                        editedContent: null,
                      })
                    }
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                    Reject
                  </Button>
                  {editing === change.id ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        decide.mutate({
                          changeId: change.id,
                          status: 'edited',
                          editedContent: edited[change.id] ?? change.proposedContent,
                        });
                        setEditing(null);
                      }}
                    >
                      Save my wording
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(change.id)}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      Edit wording
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
