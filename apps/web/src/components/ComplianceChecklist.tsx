import { useMemo } from 'react';
import { Check, Minus, X } from 'lucide-react';
import { Badge, cn } from '@uxe/ui';
import { formatLocator, type ComplianceResult, type StructuredAnswer } from '@uxe/contracts';
import { useI18n } from '../lib/i18n.js';

/**
 * The compliance answer, one obligation at a time.
 *
 * A compliance check is a list of yes/no questions about a submission, and the only honest
 * way to present it is as a list: every clause that was tested, its own box, its own
 * verdict. A summary paragraph with a percentage lets nine unexamined obligations hide
 * behind one confident sentence.
 *
 * Three states, never two. A tick means the submission was shown to satisfy the clause; a
 * cross means it was shown to breach it; an empty box means the drawing does not say, which
 * is a different thing from either and is what most rows on a first submission will be. The
 * box is what carries the verdict, the badge only names it — so the checklist scans at a
 * glance without relying on colour alone.
 */
export interface ComplianceChecklistProps {
  answer: StructuredAnswer;
  onOpenCitation: (citationId: string) => void;
  /**
   * What the workspace has chosen to show. A workspace that turned the clause locator off
   * meant it everywhere, so the checklist reads the same three switches every other
   * evidence surface reads rather than inventing its own rule.
   */
  evidenceDetail: {
    documentAndPage: boolean;
    clauseAndLocation: boolean;
    supportingExcerpt: boolean;
  };
}

type Group = { result: ComplianceResult; titleKey: string; hintKey: string };

/*
 * Order is deliberate: what failed comes first, what could not be checked second, what
 * passed last. A reviewer opens this to find out what needs doing.
 */
const GROUPS: Group[] = [
  {
    result: 'non_compliant',
    titleKey: 'checklist.violations',
    hintKey: 'checklist.violationsHint',
  },
  {
    result: 'needs_evidence',
    titleKey: 'checklist.unverifiable',
    hintKey: 'checklist.unverifiableHint',
  },
  { result: 'compliant', titleKey: 'checklist.passed', hintKey: 'checklist.passedHint' },
  {
    result: 'not_assessed',
    titleKey: 'checklist.notAssessed',
    hintKey: 'checklist.notAssessedHint',
  },
];

export function ComplianceChecklist({
  answer,
  onOpenCitation,
  evidenceDetail,
}: ComplianceChecklistProps) {
  const { t } = useI18n();
  const byId = useMemo(
    () => new Map(answer.citations.map((c) => [c.citationId, c])),
    [answer.citations],
  );

  const groups = GROUPS.map((group) => ({
    ...group,
    findings: answer.findings.filter((f) => f.result === group.result),
  })).filter((group) => group.findings.length > 0);

  if (groups.length === 0) return null;

  const counts = {
    compliant: answer.findings.filter((f) => f.result === 'compliant').length,
    total: answer.findings.length,
  };

  return (
    <section className="flex flex-col gap-4" aria-label={t('checklist.title')}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-[var(--uxe-text)]">{t('checklist.title')}</h3>
        <p className="text-[13px] text-[var(--uxe-text-secondary)] tabular-nums">
          {t('checklist.tally', {
            passed: String(counts.compliant),
            total: String(counts.total),
          })}
        </p>
      </header>

      {groups.map((group) => (
        <div key={group.result} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h4 className="text-[13px] font-semibold tracking-wide text-[var(--uxe-text)] uppercase">
              {t(group.titleKey as 'checklist.passed')}
            </h4>
            <span className="text-[13px] text-[var(--uxe-text-secondary)] tabular-nums">
              {group.findings.length}
            </span>
            <span className="text-[13px] text-[var(--uxe-text-tertiary)]">
              — {t(group.hintKey as 'checklist.passedHint')}
            </span>
          </div>

          <ul className="flex flex-col gap-2">
            {group.findings.map((finding) => {
              const governing = finding.governingCitationIds
                .map((id) => byId.get(id))
                .find((c) => c !== undefined);
              const project = finding.projectEvidenceCitationIds
                .map((id) => byId.get(id))
                .find((c) => c !== undefined);

              return (
                <li
                  key={finding.findingId}
                  className="flex gap-3 rounded-[var(--uxe-radius-card)] border border-[var(--uxe-border)] bg-[var(--uxe-surface)] p-3"
                >
                  <Tickbox result={finding.result} label={t(labelKeyFor(finding.result))} />

                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-semibold text-[var(--uxe-text)] tabular-nums">
                        {finding.requirementReference}
                      </span>
                      <span className="text-[14px] text-[var(--uxe-text)]">
                        {finding.requirementTitle}
                      </span>
                      <Badge tone={toneFor(finding.result)} size="sm">
                        {t(labelKeyFor(finding.result))}
                      </Badge>
                    </div>

                    <p className="text-[13px] leading-relaxed text-[var(--uxe-text-secondary)]">
                      {finding.finding}
                    </p>

                    {finding.recommendedAction !== null && finding.result !== 'compliant' && (
                      <p className="text-[13px] leading-relaxed text-[var(--uxe-text)]">
                        <span className="font-medium">{t('checklist.toFix')}</span>{' '}
                        {finding.recommendedAction}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
                      <EvidenceLink
                        prefix={t('checklist.perTheCode')}
                        citation={governing}
                        onOpen={onOpenCitation}
                        emptyLabel={t('checklist.noClauseLocated')}
                        evidenceDetail={evidenceDetail}
                      />
                      <EvidenceLink
                        prefix={t('checklist.onTheDrawing')}
                        citation={project}
                        onOpen={onOpenCitation}
                        emptyLabel={t('checklist.nothingOnTheDrawing')}
                        evidenceDetail={evidenceDetail}
                      />
                    </div>

                    {evidenceDetail.supportingExcerpt &&
                      project?.supportingExcerpt !== undefined && (
                        <p className="border-s-2 border-[var(--uxe-border)] ps-2 text-[12px] text-[var(--uxe-text-secondary)] italic">
                          &ldquo;{project.supportingExcerpt}&rdquo;
                        </p>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * The box itself.
 *
 * A real box rather than a bare icon, because the shape is what a reader recognises before
 * reading anything: filled and ticked, filled and crossed, or empty. `role="img"` with a
 * label keeps that meaning available to a screen reader without pretending to be a control
 * — nothing here is checkable by hand, the verdict comes from the evidence.
 */
export function Tickbox({ result, label }: { result: ComplianceResult; label: string }) {
  const Icon = result === 'compliant' ? Check : result === 'non_compliant' ? X : Minus;

  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border-2',
        result === 'compliant' && 'border-[var(--uxe-success)] bg-[var(--uxe-success)]',
        result === 'non_compliant' && 'border-[var(--uxe-danger)] bg-[var(--uxe-danger)]',
        result === 'needs_evidence' && 'border-[var(--uxe-warning)] bg-transparent',
        result === 'not_assessed' && 'border-[var(--uxe-border-strong)] bg-transparent',
      )}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5',
          // The surface colour, not white: the success and danger tokens are dark in the
          // light theme and light in the dark one, so a fixed white tick would vanish on
          // one of them. Painting the mark in the page's own ground inverts with them.
          result === 'compliant' || result === 'non_compliant'
            ? 'text-[var(--uxe-surface)]'
            : result === 'needs_evidence'
              ? 'text-[var(--uxe-warning-text)]'
              : 'text-[var(--uxe-text-tertiary)]',
        )}
        strokeWidth={3}
        aria-hidden
      />
    </span>
  );
}

function EvidenceLink({
  prefix,
  citation,
  onOpen,
  emptyLabel,
  evidenceDetail,
}: {
  prefix: string;
  citation: StructuredAnswer['citations'][number] | undefined;
  onOpen: (citationId: string) => void;
  emptyLabel: string;
  evidenceDetail: ComplianceChecklistProps['evidenceDetail'];
}) {
  if (citation === undefined) {
    return (
      <span className="text-[var(--uxe-text-tertiary)]">
        {prefix} {emptyLabel}
      </span>
    );
  }

  const label = [
    evidenceDetail.documentAndPage ? citation.documentTitle : null,
    evidenceDetail.clauseAndLocation ? formatLocator(citation) : null,
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' · ');

  // Both switches off leaves nothing to name the evidence by, so there is nothing to link.
  if (label === '') return null;

  return (
    <span className="text-[var(--uxe-text-secondary)]">
      {prefix}{' '}
      <button
        type="button"
        onClick={() => onOpen(citation.citationId)}
        className="text-[var(--uxe-cobalt)] hover:underline"
      >
        {label}
      </button>
    </span>
  );
}

function toneFor(result: ComplianceResult): 'success' | 'danger' | 'warning' | 'neutral' {
  if (result === 'compliant') return 'success';
  if (result === 'non_compliant') return 'danger';
  if (result === 'needs_evidence') return 'warning';
  return 'neutral';
}

export function labelKeyFor(result: ComplianceResult): 'compliance.compliant' {
  return (
    {
      compliant: 'compliance.compliant',
      non_compliant: 'compliance.nonCompliant',
      needs_evidence: 'checklist.cannotVerify',
      not_assessed: 'compliance.notAssessed',
    } as const
  )[result] as 'compliance.compliant';
}
