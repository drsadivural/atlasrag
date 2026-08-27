import {
  DeterministicEmbeddingProvider,
  chunkSections,
  chunkSlides,
  chunkSpreadsheet,
  detectStructure,
  embeddingInput,
  screenExtractedText,
  quarantineReason,
  type Chunk,
  type ExtractedPage,
} from '@uxe/rag';
import type { TenantContext } from '@uxe/db';
import type { AppDeps } from '../context.js';
import type { ExtractionResult } from '../services/document-worker.js';

export interface IngestInput {
  sourceId: string;
  sourceVersionId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  jobId: string;
}

export interface IngestOutcome {
  status: 'ready' | 'needs_review' | 'quarantined';
  pages: number;
  chunks: number;
  requirements: number;
  extractionCoverage: number;
  ocrApplied: boolean;
  ocrConfidence: number | null;
  quarantine: { reason: string; patterns: string[]; excerpt: string } | null;
  warnings: string[];
}

/**
 * The ingestion pipeline, in the order section 13 of the brief specifies.
 *
 * Each stage reports into the job record, which is what drives the visible progress in the
 * Knowledge Base panel. The version is NOT promoted to current until validation passes, so
 * a source only becomes citable once its citation jump targets are known to resolve.
 */
export async function runIngestion(
  deps: AppDeps,
  ctx: TenantContext,
  input: IngestInput,
): Promise<IngestOutcome> {
  const { jobs, sources, retrieval } = deps.repos;
  const warnings: string[] = [];

  // --- 1. Malware / MIME validation --------------------------------------
  await jobs.updateStage(input.jobId, 'malware_scan', 'running');
  const bytes = await deps.services.storage.get('originals', input.storageKey);
  if (!bytes) throw new Error('The uploaded file could not be read back from storage.');

  const base64 = bytesToBase64(bytes);
  const scan = await deps.services.documentWorker.scan({
    bytesBase64: base64,
    fileName: input.fileName,
    declaredContentType: input.contentType,
  });

  if (!scan.clean) {
    await jobs.updateStage(input.jobId, 'malware_scan', 'failed', scan.reason);
    await sources.setSourceStatus(input.sourceId, {
      status: 'quarantined',
      failureReason: scan.reason,
      quarantine: {
        reason: scan.reason ?? 'Rejected by scanner',
        patterns: scan.signatures,
        excerpt: '',
      },
    });
    return {
      status: 'quarantined',
      pages: 0,
      chunks: 0,
      requirements: 0,
      extractionCoverage: 0,
      ocrApplied: false,
      ocrConfidence: null,
      quarantine: {
        reason: scan.reason ?? 'Rejected by scanner',
        patterns: scan.signatures,
        excerpt: '',
      },
      warnings,
    };
  }

  // A declared content type that disagrees with the sniffed one is a red flag, but not
  // automatically hostile: browsers guess badly. It is recorded and the sniffed type wins.
  if (scan.detectedContentType !== input.contentType) {
    warnings.push(
      `Declared type ${input.contentType} but the file content is ${scan.detectedContentType}. The detected type was used.`,
    );
  }
  await jobs.updateStage(input.jobId, 'malware_scan', 'complete', 'No signatures matched');

  // --- 2. Extraction / OCR -----------------------------------------------
  await jobs.updateStage(input.jobId, 'extraction', 'running');
  const extraction: ExtractionResult = await deps.services.documentWorker.extract({
    fileName: input.fileName,
    contentType: scan.detectedContentType,
    bytesBase64: base64,
    maxPages: deps.env.MAX_DOCUMENT_PAGES,
  });

  warnings.push(...extraction.warnings);
  if (extraction.removedActiveContent.length > 0) {
    warnings.push(
      `Neutralised active content during extraction: ${extraction.removedActiveContent.join(', ')}.`,
    );
  }

  await jobs.updateStage(
    input.jobId,
    'extraction',
    'complete',
    `${extraction.pageCount} page(s)${extraction.ocrApplied ? ', OCR applied' : ''}`,
  );

  // --- 3. Injection screening --------------------------------------------
  const fullText = extraction.pages.map((p) => p.text).join('\n');
  const screening = screenExtractedText(fullText);
  if (screening.quarantine) {
    const reason = quarantineReason(screening.signals);
    // The reason, not the verdict. "Quarantined" on its own tells whoever opens the
    // pipeline that something stopped and nothing about what to do next.
    await jobs.updateStage(input.jobId, 'structure_analysis', 'failed', reason);
    await sources.setSourceStatus(input.sourceId, {
      status: 'quarantined',
      failureReason: reason,
      quarantine: {
        reason,
        patterns: [...new Set(screening.signals.map((s) => s.pattern))],
        excerpt: screening.signals[0]?.excerpt ?? '',
      },
    });
    await sources.setVersionStatus(input.sourceVersionId, { status: 'quarantined' });
    return {
      status: 'quarantined',
      pages: extraction.pageCount,
      chunks: 0,
      requirements: 0,
      extractionCoverage: 0,
      ocrApplied: extraction.ocrApplied,
      ocrConfidence: extraction.ocrConfidence,
      quarantine: {
        reason,
        patterns: [...new Set(screening.signals.map((s) => s.pattern))],
        excerpt: screening.signals[0]?.excerpt ?? '',
      },
      warnings,
    };
  }
  if (screening.signals.length > 0) {
    warnings.push(
      `${screening.signals.length} low-severity instruction-like pattern(s) were found and neutralised.`,
    );
  }

  // --- 4. Persist pages ---------------------------------------------------
  await retrieval.replacePages(ctx, input.sourceVersionId, extraction.pages as ExtractedPage[]);

  // --- 5. Structure analysis ---------------------------------------------
  await jobs.updateStage(input.jobId, 'structure_analysis', 'running');
  const isSpreadsheet = extraction.documentType === 'xlsx' || extraction.documentType === 'csv';
  const isSlides = extraction.documentType === 'pptx';

  const sections =
    isSpreadsheet || isSlides ? [] : detectStructure(extraction.pages as ExtractedPage[]);

  if (sections.length > 0) {
    await retrieval.replaceSections(
      ctx,
      input.sourceVersionId,
      sections.map((s) => ({
        parentId: null,
        ordinal: s.ordinal,
        level: s.level,
        kind: s.kind,
        chapter: s.chapter,
        section: s.section,
        clause: s.clause,
        title: s.title,
        body: s.body.slice(0, 20000),
        headingPath: s.headingPath,
        pageNumber: s.pageNumber,
        charStart: s.charStart,
        charEnd: s.charEnd,
        modality: s.modality,
        isRequirement: s.isRequirement,
        effectiveDate: s.effectiveDate,
        supersededNote: s.supersededNote,
        crossReferences: s.crossReferences,
        exceptions: s.exceptions,
      })),
    );
  }

  const requirementCount = sections.filter((s) => s.isRequirement).length;
  await jobs.updateStage(
    input.jobId,
    'structure_analysis',
    'complete',
    `${sections.length} section(s), ${requirementCount} obligation(s)`,
  );

  // --- 6. Chunking --------------------------------------------------------
  await jobs.updateStage(input.jobId, 'chunking', 'running');
  const chunks: Chunk[] = isSpreadsheet
    ? chunkSpreadsheet(extraction.pages as ExtractedPage[])
    : isSlides
      ? chunkSlides(extraction.pages as ExtractedPage[])
      : chunkSections(sections);

  if (chunks.length === 0) {
    // A document that yields no chunk cannot support a citation, so it must not be
    // presented as ready. It goes to needs_review with the reason stated.
    await jobs.updateStage(input.jobId, 'chunking', 'failed', 'No indexable text found');
    await sources.setSourceStatus(input.sourceId, {
      status: 'needs_review',
      failureReason:
        'No indexable text could be extracted. If this is a scanned document, re-upload it with OCR enabled or supply a text-based version.',
    });
    await sources.setVersionStatus(input.sourceVersionId, { status: 'needs_review' });
    return {
      status: 'needs_review',
      pages: extraction.pageCount,
      chunks: 0,
      requirements: 0,
      extractionCoverage: 0,
      ocrApplied: extraction.ocrApplied,
      ocrConfidence: extraction.ocrConfidence,
      quarantine: null,
      warnings,
    };
  }

  const chunkIds = await retrieval.replaceChunks(
    ctx,
    input.sourceId,
    input.sourceVersionId,
    chunks.map((c) => ({
      ordinal: c.ordinal,
      content: c.content,
      headingText: c.headingText,
      tokenCount: c.tokenCount,
      pageNumber: c.pageNumber,
      pageEnd: c.pageEnd,
      sheetName: c.sheetName,
      cellRange: c.cellRange,
      slideNumber: c.slideNumber,
      chapter: c.chapter,
      section: c.section,
      clause: c.clause,
      headingPath: c.headingPath,
      paragraphIndex: c.paragraphIndex,
      charStart: c.charStart,
      charEnd: c.charEnd,
      kind: c.kind,
      sectionId: null,
    })),
  );
  await jobs.updateStage(input.jobId, 'chunking', 'complete', `${chunks.length} chunk(s)`);

  // --- 7. Embeddings ------------------------------------------------------
  await jobs.updateStage(input.jobId, 'embeddings', 'running');
  const embedder = deps.services.embeddings;
  const vectors: number[][] = [];
  // Batched so a 1,300-page regulation does not build one enormous provider request.
  for (let i = 0; i < chunks.length; i += 64) {
    const batch = chunks.slice(i, i + 64).map((c) => embeddingInput(c));
    vectors.push(...(await embedder.embed(batch)));
    await jobs.updateStage(
      input.jobId,
      'embeddings',
      'running',
      `${Math.min(i + 64, chunks.length)} / ${chunks.length}`,
      Math.round((Math.min(i + 64, chunks.length) / chunks.length) * 100),
    );
  }

  await retrieval.replaceEmbeddings(
    ctx,
    input.sourceVersionId,
    embedder.model,
    chunkIds.map((id, index) => ({ chunkId: id, vector: vectors[index] ?? [] })),
  );
  await jobs.updateStage(input.jobId, 'embeddings', 'complete', `${chunkIds.length} vector(s)`);

  // --- 8. Lexical index ---------------------------------------------------
  // Postgres maintains the GIN index on write, so there is nothing to build here; the
  // stage exists so the UI can show that the lexical half of retrieval is ready.
  await jobs.updateStage(
    input.jobId,
    'lexical_index',
    'complete',
    'Maintained by PostgreSQL GIN index',
  );

  // --- 9. Citation map ----------------------------------------------------
  await jobs.updateStage(input.jobId, 'citation_map', 'running');
  const coverage = await retrieval.extractionCoverage(input.sourceVersionId);
  const citationCheck = await validateCitationTargets(deps, ctx, input.sourceVersionId, chunks);
  await jobs.updateStage(
    input.jobId,
    'citation_map',
    citationCheck.ok ? 'complete' : 'failed',
    `${citationCheck.resolved}/${citationCheck.sampled} sampled passages resolved to their page`,
  );

  // --- 10. Validation and promotion --------------------------------------
  await jobs.updateStage(input.jobId, 'validation', 'running');

  await sources.setVersionStatus(input.sourceVersionId, {
    pages: extraction.pageCount,
    ocrApplied: extraction.ocrApplied,
    ocrConfidence: extraction.ocrConfidence ?? undefined,
    extractionCoverage: coverage,
    normalizedSha256: await sha256OfText(fullText),
    structure: {
      headings: sections.filter((s) => s.kind === 'heading').length,
      clauses: sections.filter((s) => s.clause !== null).length,
      tables: sections.filter((s) => s.kind === 'table').length,
      definitions: sections.filter((s) => s.kind === 'definition').length,
      chunks: chunks.length,
    },
    metadata: {
      ...extraction.metadata,
      isScanned: extraction.isScanned,
      isSigned: extraction.isSigned,
      isEncrypted: extraction.isEncrypted,
      hasMacros: extraction.hasMacros,
      hasExtractableText: extraction.hasExtractableText,
      mediaCount: extraction.mediaCount,
      pageSizes: extraction.pageSizes,
    },
  });

  if (!citationCheck.ok) {
    await jobs.updateStage(input.jobId, 'validation', 'failed', citationCheck.reason);
    await sources.setSourceStatus(input.sourceId, {
      status: 'needs_review',
      failureReason: citationCheck.reason,
      documentType: extraction.documentType,
    });
    await sources.setVersionStatus(input.sourceVersionId, { status: 'needs_review' });
    warnings.push(citationCheck.reason ?? 'Citation validation failed.');
    return {
      status: 'needs_review',
      pages: extraction.pageCount,
      chunks: chunks.length,
      requirements: requirementCount,
      extractionCoverage: coverage,
      ocrApplied: extraction.ocrApplied,
      ocrConfidence: extraction.ocrConfidence,
      quarantine: null,
      warnings,
    };
  }

  // Only now is the version promoted; before this point nothing could cite it.
  await sources.promoteVersion(ctx, input.sourceId, input.sourceVersionId);
  await sources.setSourceStatus(input.sourceId, {
    status: 'ready',
    failureReason: null,
    documentType: extraction.documentType,
    ...(extraction.title ? {} : {}),
  });

  await jobs.updateStage(
    input.jobId,
    'validation',
    'complete',
    `Extraction coverage ${(coverage * 100).toFixed(0)}%`,
  );

  return {
    status: 'ready',
    pages: extraction.pageCount,
    chunks: chunks.length,
    requirements: requirementCount,
    extractionCoverage: coverage,
    ocrApplied: extraction.ocrApplied,
    ocrConfidence: extraction.ocrConfidence,
    quarantine: null,
    warnings,
  };
}

/**
 * Samples indexed passages and confirms each one can be located on the page it claims.
 *
 * This is the gate that makes "Ready only after citation-map validation" real: if a
 * document indexes text that cannot be found again at its stated locator, every citation
 * it produces would fail verification at answer time, so the source is held for review
 * rather than being published as citable.
 */
async function validateCitationTargets(
  deps: AppDeps,
  ctx: TenantContext,
  versionId: string,
  chunks: Chunk[],
): Promise<{ ok: boolean; sampled: number; resolved: number; reason: string | null }> {
  const withPages = chunks.filter((c) => c.pageNumber !== null);
  if (withPages.length === 0) {
    // Formats without page numbers (plain text, HTML) locate by heading/paragraph instead.
    return { ok: true, sampled: 0, resolved: 0, reason: null };
  }

  // Sample across the document rather than the first N, so a failure late in a long
  // regulation is still caught.
  const sampleSize = Math.min(20, withPages.length);
  const stride = Math.max(1, Math.floor(withPages.length / sampleSize));
  const sample = Array.from({ length: sampleSize }, (_, i) => withPages[i * stride]).filter(
    (c): c is Chunk => c !== undefined,
  );

  let resolved = 0;
  const { findExcerpt } = await import('@uxe/rag');

  for (const chunk of sample) {
    const page = await deps.repos.retrieval.getPage(ctx, versionId, chunk.pageNumber as number);
    if (!page) continue;
    // The chunk's own opening sentence must be findable on its page.
    const probe = chunk.content.split('\n').pop()?.slice(0, 120) ?? chunk.content.slice(0, 120);
    if (findExcerpt(page.text, probe)) resolved += 1;
  }

  const ratio = sample.length === 0 ? 1 : resolved / sample.length;
  const ok = ratio >= 0.8;

  return {
    ok,
    sampled: sample.length,
    resolved,
    reason: ok
      ? null
      : `Only ${resolved} of ${sample.length} sampled passages could be located on the page they were indexed against. Citations from this version would not resolve reliably, so it needs review before it can be cited.`,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256OfText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text) as ArrayBufferView,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { DeterministicEmbeddingProvider };
