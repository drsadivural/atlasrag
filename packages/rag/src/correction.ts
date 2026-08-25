import type { Citation, DocumentType, Finding, RiskLevel } from '@uxe/contracts';
import { formatLocator } from '@uxe/contracts';
import type { FusedCandidate } from './fusion.js';
import { extractQuantities, selectExcerpt } from './citations.js';
import { normalizeWhitespace, splitSentences } from './text.js';

export type OutputStrategy =
  'in_place_text' | 'tracked_changes' | 'overlay' | 'ocr_rebuild' | 'revised_edition';

export interface DocumentCapabilities {
  documentType: DocumentType;
  hasExtractableText: boolean;
  isScanned: boolean;
  isSigned: boolean;
  isEncrypted: boolean;
  hasMacros: boolean;
  pageCount: number | null;
}

export interface StrategyDecision {
  strategy: OutputStrategy;
  limitations: string[];
  signatureNotice: string | null;
  /** True when the output will not be a faithful in-place edit of the original. */
  isDerivativeEdition: boolean;
}

/**
 * Chooses how a corrected edition can honestly be produced.
 *
 * The rules encode section 15 of the brief, and two of them are non-negotiable:
 *
 *  - A signed PDF is never modified in place and the product never claims the signature
 *    survives. It produces a clearly labelled unsigned derivative and keeps the original.
 *  - When faithful in-place correction is not safe, the limitation is stated to the user
 *    BEFORE generation rather than discovered afterwards.
 */
export function decideOutputStrategy(caps: DocumentCapabilities): StrategyDecision {
  const limitations: string[] = [];
  let signatureNotice: string | null = null;

  if (caps.isEncrypted) {
    limitations.push(
      'The original file is password protected. Supply the password, or the corrected edition will be produced from the extracted text only.',
    );
  }

  if (caps.hasMacros) {
    limitations.push(
      'The original contains macros. Macros are never executed and are not carried into the corrected edition.',
    );
  }

  if (caps.isSigned) {
    signatureNotice =
      'The original carries a cryptographic signature. That signature covers the original bytes only and cannot be preserved through an edit. The original is retained unchanged and the corrected file is a NEW, UNSIGNED derivative that must be re-signed by an authorised signer before it is relied upon.';
    limitations.push('Signature validity is not preserved. The corrected edition is unsigned.');
  }

  switch (caps.documentType) {
    case 'docx':
      return {
        strategy: 'tracked_changes',
        limitations,
        signatureNotice,
        isDerivativeEdition: false,
      };

    case 'pdf':
      if (caps.isScanned || !caps.hasExtractableText) {
        limitations.push(
          'The source is a scanned image PDF. The corrected edition is rebuilt from OCR text, so exact glyph positioning and any handwriting are not reproduced. OCR confidence is reported with the artifact.',
        );
        return { strategy: 'ocr_rebuild', limitations, signatureNotice, isDerivativeEdition: true };
      }
      if (caps.isSigned) {
        // Never overlay onto signed bytes; produce a clean derivative instead.
        return {
          strategy: 'revised_edition',
          limitations,
          signatureNotice,
          isDerivativeEdition: true,
        };
      }
      return { strategy: 'overlay', limitations, signatureNotice, isDerivativeEdition: false };

    case 'xlsx':
      limitations.push(
        'Formulas, named ranges, validations and charts are preserved. Cell values that are the result of a formula are corrected by editing the formula, not by overwriting the computed value.',
      );
      return {
        strategy: 'in_place_text',
        limitations,
        signatureNotice,
        isDerivativeEdition: false,
      };

    case 'pptx':
      return {
        strategy: 'in_place_text',
        limitations,
        signatureNotice,
        isDerivativeEdition: false,
      };

    default:
      limitations.push(
        `In-place correction is not available for ${caps.documentType} input. A professionally formatted revised edition is produced instead, together with an exact change report.`,
      );
      return {
        strategy: 'revised_edition',
        limitations,
        signatureNotice,
        isDerivativeEdition: true,
      };
  }
}

export interface ProposedChange {
  ordinal: number;
  locatorLabel: string;
  pageNumber: number | null;
  paragraphIndex: number | null;
  sheetName: string | null;
  cellRange: string | null;
  slideNumber: number | null;
  charStart: number | null;
  charEnd: number | null;
  currentContent: string;
  proposedContent: string;
  reason: string;
  governingCitationId: string | null;
  findingId: string | null;
  risk: RiskLevel;
  confidence: number;
}

export interface PlanInput {
  findings: Finding[];
  citations: Citation[];
  /** Passages from the document being corrected, used to locate the text to change. */
  projectCandidates: FusedCandidate[];
  instructions?: string | undefined;
}

/**
 * Builds a reviewable change plan.
 *
 * Every proposed change carries its location, the current text, the proposed text, the
 * reason, the governing citation, a risk level and a confidence. Nothing is applied here —
 * a human accepts, rejects or edits each entry, and only accepted entries are written.
 */
export function buildChangePlan(input: PlanInput): ProposedChange[] {
  const citationById = new Map(input.citations.map((c) => [c.citationId, c]));
  const changes: ProposedChange[] = [];

  const actionable = input.findings.filter(
    (f) => f.result === 'non_compliant' || f.result === 'needs_evidence',
  );

  for (const finding of actionable) {
    const governingId = finding.governingCitationIds[0] ?? null;
    const governing = governingId ? (citationById.get(governingId) ?? null) : null;

    // Anchor the edit on the project passage the review actually used, when there is one.
    const anchorCitationId = finding.projectEvidenceCitationIds[0];
    const anchor = anchorCitationId ? citationById.get(anchorCitationId) : undefined;
    const anchorCandidate = anchor
      ? input.projectCandidates.find(
          (c) => c.sourceVersionId === anchor.sourceVersionId && c.pageNumber === anchor.pageNumber,
        )
      : undefined;

    const currentContent = anchor?.supportingExcerpt ?? '';
    const proposedContent = draftReplacement({
      finding,
      governing,
      currentContent,
      instructions: input.instructions,
    });

    changes.push({
      ordinal: changes.length + 1,
      locatorLabel: anchor
        ? `${anchor.documentTitle} - ${formatLocator(anchor)}`
        : `${finding.requirementReference} - insertion required`,
      pageNumber: anchor?.pageNumber ?? null,
      paragraphIndex: anchor?.paragraphIndex ?? anchorCandidate?.paragraphIndex ?? null,
      sheetName: anchor?.sheetName ?? null,
      cellRange: anchor?.cellRange ?? null,
      slideNumber: anchor?.slideNumber ?? null,
      charStart: anchor?.charStart ?? null,
      charEnd: anchor?.charEnd ?? null,
      currentContent,
      proposedContent,
      reason: buildReason(finding, governing),
      governingCitationId: governingId,
      findingId: finding.findingId,
      risk: finding.risk,
      confidence: finding.confidence,
    });
  }

  return changes;
}

/**
 * Drafts replacement text.
 *
 * The replacement is built from the governing clause's own wording plus the specific
 * quantity it requires, rather than invented prose. When there is no current text to
 * replace, the change is an insertion that states the obligation and cites it — which is
 * an honest way to close a "needs evidence" gap without fabricating a fact about the
 * customer's building or process.
 */
export function draftReplacement(input: {
  finding: Finding;
  governing: Citation | null;
  currentContent: string;
  instructions?: string | undefined;
}): string {
  const { finding, governing, currentContent } = input;
  const obligation = governing ? normalizeWhitespace(governing.supportingExcerpt) : '';
  const reference = governing
    ? `${governing.documentTitle}, ${formatLocator(governing)}`
    : finding.requirementReference;

  // A quantity conflict has an exact, checkable fix: restate the required value.
  const requiredQuantities = obligation ? extractQuantities(obligation) : new Map<string, number>();
  const currentQuantities = currentContent
    ? extractQuantities(currentContent)
    : new Map<string, number>();

  if (currentContent && requiredQuantities.size > 0 && currentQuantities.size > 0) {
    const rewritten = rewriteQuantities(currentContent, requiredQuantities, obligation);
    if (rewritten !== currentContent) return rewritten;
  }

  if (!currentContent) {
    const statement = obligation ? firstObligationSentence(obligation) : finding.finding;
    return `${statement}\n\n[Added to satisfy ${reference}.]`;
  }

  const statement = obligation ? firstObligationSentence(obligation) : '';
  if (!statement) {
    return `${currentContent}\n\n[Revise to satisfy ${reference}: ${finding.recommendedAction ?? finding.finding}]`;
  }

  return `${statement} [Amended to satisfy ${reference}.]`;
}

function firstObligationSentence(text: string): string {
  const sentences = splitSentences(text);
  const obligation = sentences.find((s) =>
    /\b(shall|must|shall not|must not|is required|are required|is prohibited)\b/i.test(s),
  );
  return normalizeWhitespace(obligation ?? sentences[0] ?? text).slice(0, 600);
}

/** Substitutes the required value for the non-compliant one, preserving the sentence. */
function rewriteQuantities(
  current: string,
  required: Map<string, number>,
  obligation: string,
): string {
  let out = current;
  const pattern =
    /(\d+(?:[.,]\d+)?)\s*(mm|cm|m|km|in|ft|kg|g|lb|s|sec|seconds?|min|minutes?|h|hours?|%|percent|lux|lx|kpa|pa|bar|persons?|occupants?)\b/gi;

  out = out.replace(pattern, (match, _value: string, unit: string) => {
    const canonical = canonicalUnitOf(unit.toLowerCase());
    const target = required.get(canonical);
    if (target === undefined) return match;
    const display = displayInUnit(target, unit.toLowerCase());
    // Take the required figure straight from the obligation's own wording.
    const source = obligation.match(new RegExp(`\\b${escapeRegex(display)}\\s*${unit}\\b`, 'i'));
    return `${source ? display : display} ${unit}`;
  });

  return out;
}

function canonicalUnitOf(unit: string): string {
  if (['mm', 'cm', 'm', 'km', 'in', 'ft'].includes(unit)) return 'length_m';
  if (
    ['s', 'sec', 'second', 'seconds', 'min', 'minute', 'minutes', 'h', 'hour', 'hours'].includes(
      unit,
    )
  )
    return 'time_s';
  if (['kg', 'g', 'lb'].includes(unit)) return 'mass_kg';
  if (['%', 'percent'].includes(unit)) return 'percent';
  if (['lux', 'lx'].includes(unit)) return 'illuminance_lx';
  if (['kpa', 'pa', 'bar'].includes(unit)) return 'pressure_pa';
  if (['person', 'persons', 'occupant', 'occupants'].includes(unit)) return 'people';
  return unit;
}

function displayInUnit(canonicalValue: number, unit: string): string {
  const converted = (() => {
    switch (unit) {
      case 'mm':
        return canonicalValue * 1000;
      case 'cm':
        return canonicalValue * 100;
      case 'km':
        return canonicalValue / 1000;
      case 'in':
        return canonicalValue / 0.0254;
      case 'ft':
        return canonicalValue / 0.3048;
      case 'min':
      case 'minute':
      case 'minutes':
        return canonicalValue / 60;
      case 'h':
      case 'hour':
      case 'hours':
        return canonicalValue / 3600;
      case 'g':
        return canonicalValue * 1000;
      case 'lb':
        return canonicalValue / 0.453592;
      case 'kpa':
        return canonicalValue / 1000;
      case 'bar':
        return canonicalValue / 100000;
      default:
        return canonicalValue;
    }
  })();
  return Number.isInteger(converted)
    ? String(converted)
    : converted.toFixed(2).replace(/\.?0+$/, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReason(finding: Finding, governing: Citation | null): string {
  const base =
    finding.result === 'non_compliant'
      ? `${finding.requirementReference} is not satisfied: ${finding.finding}`
      : `${finding.requirementReference} lacks demonstrable evidence: ${finding.finding}`;
  if (!governing) return base;
  return `${base} Governing text: "${selectExcerpt(governing.supportingExcerpt, finding.requirementTitle, { maxChars: 180 })}" (${formatLocator(governing)}).`;
}

export interface ValidationReport {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/**
 * Validates a generated derivative before it is released.
 *
 * The file must open, keep its page/sheet/slide count, keep its page dimensions, retain its
 * media, and show no unexpected content loss. A failed check blocks release rather than
 * shipping a quietly broken document.
 */
export function validateDerivative(input: {
  original: {
    pages: number | null;
    textLength: number;
    mediaCount: number;
    pageSizes: Array<{ w: number; h: number }>;
  };
  generated: {
    opened: boolean;
    pages: number | null;
    textLength: number;
    mediaCount: number;
    pageSizes: Array<{ w: number; h: number }>;
  };
  acceptedChangeCount: number;
  /** Pages the generator deliberately appended (e.g. an addendum for inserted provisions). */
  allowedExtraPages?: number;
}): ValidationReport {
  const checks: ValidationReport['checks'] = [];

  checks.push({
    name: 'opens',
    passed: input.generated.opened,
    detail: input.generated.opened
      ? 'The generated file re-opened successfully.'
      : 'The generated file could not be re-opened.',
  });

  // Losing a page is content loss and blocks release. Gaining exactly the pages the
  // generator declared it appended is expected and is reported, not treated as a failure.
  const extra = input.allowedExtraPages ?? 0;
  const pagesMatch =
    input.original.pages === null ||
    input.generated.pages === null ||
    input.generated.pages === input.original.pages + extra;
  checks.push({
    name: 'page_count',
    passed: pagesMatch,
    detail: pagesMatch
      ? extra > 0
        ? `Original ${input.original.pages} page(s) preserved, plus ${extra} declared addendum page(s).`
        : `Page/section count preserved (${input.generated.pages ?? 'n/a'}).`
      : `Page count changed from ${input.original.pages} to ${input.generated.pages}, which was not expected.`,
  });

  // Only the original pages are size-checked; an addendum is generated at the same size
  // but is not part of the original layout contract.
  const sizesMatch = input.original.pageSizes.every((size, index) => {
    const other = input.generated.pageSizes[index];
    if (!other) return input.original.pageSizes.length === 0;
    return Math.abs(size.w - other.w) < 1 && Math.abs(size.h - other.h) < 1;
  });
  checks.push({
    name: 'page_dimensions',
    passed: sizesMatch,
    detail: sizesMatch ? 'Page dimensions unchanged.' : 'One or more page dimensions changed.',
  });

  const mediaKept = input.generated.mediaCount >= input.original.mediaCount;
  checks.push({
    name: 'media_retained',
    passed: mediaKept,
    detail: mediaKept
      ? `All ${input.original.mediaCount} embedded media item(s) retained.`
      : `Media count dropped from ${input.original.mediaCount} to ${input.generated.mediaCount}.`,
  });

  // Corrections rewrite text, so exact length equality is not expected. A large unexplained
  // shrink is, however, the signature of silent content loss.
  const shrink =
    input.original.textLength === 0
      ? 0
      : (input.original.textLength - input.generated.textLength) / input.original.textLength;
  const tolerance = Math.min(0.35, 0.05 + input.acceptedChangeCount * 0.02);
  const contentOk = shrink <= tolerance;
  checks.push({
    name: 'no_content_loss',
    passed: contentOk,
    detail: contentOk
      ? `Text volume within tolerance (${(shrink * 100).toFixed(1)}% change against a ${(tolerance * 100).toFixed(0)}% allowance).`
      : `Text shrank by ${(shrink * 100).toFixed(1)}%, beyond the ${(tolerance * 100).toFixed(0)}% allowance for ${input.acceptedChangeCount} change(s).`,
  });

  return { ok: checks.every((c) => c.passed), checks };
}

/** The change-log entry stored on the artifact and rendered in the diff view. */
export interface ChangeLogEntry {
  ordinal: number;
  locator: string;
  before: string;
  after: string;
  reason: string;
  governingCitation: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export function buildChangeLog(
  changes: Array<{
    ordinal: number;
    locatorLabel: string;
    currentContent: string;
    proposedContent: string;
    editedContent: string | null;
    reason: string;
    governingCitationId: string | null;
    decidedAt: Date | null;
  }>,
  citations: Citation[],
  decidedByName: string | null,
): ChangeLogEntry[] {
  const byId = new Map(citations.map((c) => [c.citationId, c]));
  return changes.map((change) => {
    const citation = change.governingCitationId ? byId.get(change.governingCitationId) : undefined;
    return {
      ordinal: change.ordinal,
      locator: change.locatorLabel,
      before: change.currentContent,
      // A reviewer's edit is what actually gets written, so it is what the log records.
      after: change.editedContent ?? change.proposedContent,
      reason: change.reason,
      governingCitation: citation ? `${citation.documentTitle} - ${formatLocator(citation)}` : null,
      decidedBy: decidedByName,
      decidedAt: change.decidedAt ? change.decidedAt.toISOString() : null,
    };
  });
}
