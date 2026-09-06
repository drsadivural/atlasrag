import type { ExtractedPage } from '@uxe/rag';

export interface DocumentCapabilitiesResponse {
  ocr: boolean;
  libreoffice: boolean;
  pdf: boolean;
  docx: boolean;
  xlsx: boolean;
  pptx: boolean;
  tesseractVersion: string | null;
}

export interface ExtractionResult {
  documentType: string;
  pages: ExtractedPage[];
  pageCount: number;
  title: string | null;
  metadata: Record<string, unknown>;
  isScanned: boolean;
  isSigned: boolean;
  isEncrypted: boolean;
  hasMacros: boolean;
  hasExtractableText: boolean;
  ocrApplied: boolean;
  ocrConfidence: number | null;
  mediaCount: number;
  pageSizes: Array<{ w: number; h: number }>;
  /** Instructional/active content the worker neutralised during extraction. */
  removedActiveContent: string[];
  warnings: string[];
}

export interface CorrectionRequest {
  strategy: 'in_place_text' | 'tracked_changes' | 'overlay' | 'ocr_rebuild' | 'revised_edition';
  documentType: string;
  changes: Array<{
    ordinal: number;
    pageNumber: number | null;
    paragraphIndex: number | null;
    sheetName: string | null;
    cellRange: string | null;
    slideNumber: number | null;
    currentContent: string;
    proposedContent: string;
    reason: string;
    citation: string | null;
  }>;
  includeRedline: boolean;
  title: string;
  disclosures: string[];
}

export interface CorrectionResult {
  documentBase64: string;
  redlineBase64: string | null;
  contentType: string;
  extension: string;
  validation: {
    opened: boolean;
    pages: number | null;
    addendumPages: number;
    textLength: number;
    mediaCount: number;
    pageSizes: Array<{ w: number; h: number }>;
    appliedChanges: number;
    unmatchedChanges: number[];
  };
  warnings: string[];
}

export interface ReportRequest {
  format: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'markdown';
  title: string;
  subtitle: string;
  generatedAt: string;
  summary: string;
  decision: string | null;
  decisionQualifier: string | null;
  confidence: number;
  coverage: number;
  documentsReviewed: Array<{ title: string; version: string; role: string; pages: number | null }>;
  assumptions: string[];
  rows: Array<{
    requirement: string;
    result: string;
    finding: string;
    source: string;
    version: string;
    location: string;
    page: number | null;
    excerpt: string;
    confidence: number;
    verified: boolean;
  }>;
  recommendations: Array<{ action: string; priority: string }>;
  disclosures: string[];
}

export class DocumentWorkerError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'timeout' | 'rejected' | 'invalid_response',
    readonly retryable: boolean,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'DocumentWorkerError';
  }
}

/**
 * Client for the Python document worker.
 *
 * The worker is the only component that touches original bytes with native libraries, so
 * it is isolated behind HTTP and a shared token. That boundary is what lets extraction,
 * OCR and conversion run in a sandboxed container while the API stays on the edge runtime,
 * and it means a malicious document can at worst crash a disposable worker process.
 */
/**
 * How long a liveness probe waits, and above which latency the worker counts as busy.
 *
 * The timeout is generous because a worker under load answers late, and treating late as
 * dead is the mistake this pair exists to prevent. The busy threshold sits well above a
 * healthy reply (single-digit milliseconds) and well below the timeout.
 */
const WORKER_HEALTH_TIMEOUT_MS = 10_000;
const WORKER_HEALTH_BUSY_MS = 1_000;

export class DocumentWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly extractTimeoutMs: number = timeoutMs,
  ) {}

  async capabilities(): Promise<DocumentCapabilitiesResponse> {
    return this.request<DocumentCapabilitiesResponse>('GET', '/capabilities');
  }

  async extract(input: {
    fileName: string;
    contentType: string;
    bytesBase64: string;
    maxPages: number;
    forceOcr?: boolean;
    password?: string | null;
  }): Promise<ExtractionResult> {
    /*
     * Extraction gets its own, longer allowance. It is the only call whose cost scales
     * with the document: a 300-page scan is 300 OCR passes, and while those now run in
     * parallel the total still runs to minutes. The shared default is sized for calls
     * that should answer promptly, and applying it here failed large documents on the
     * clock rather than on their merits.
     */
    return this.request<ExtractionResult>('POST', '/extract', input, this.extractTimeoutMs);
  }

  async correct(
    input: CorrectionRequest & { bytesBase64: string; fileName: string },
  ): Promise<CorrectionResult> {
    return this.request<CorrectionResult>('POST', '/correct', input);
  }

  async report(
    input: ReportRequest,
  ): Promise<{ documentBase64: string; contentType: string; extension: string }> {
    return this.request('POST', '/report', input);
  }

  async inspectArchive(input: {
    bytesBase64: string;
    maxEntries: number;
    maxExpandedBytes: number;
    maxRatio: number;
  }): Promise<{
    safe: boolean;
    reason: string | null;
    entries: Array<{
      name: string;
      sizeBytes: number;
      compressedBytes: number;
      contentType: string;
    }>;
  }> {
    return this.request('POST', '/archive/inspect', input);
  }

  async scan(input: {
    bytesBase64: string;
    fileName: string;
    declaredContentType: string;
  }): Promise<{
    clean: boolean;
    detectedContentType: string;
    reason: string | null;
    signatures: string[];
  }> {
    return this.request('POST', '/scan', input);
  }

  /**
   * Liveness, separating a worker that is busy from one that is gone.
   *
   * These are not the same condition and must not produce the same answer. A slow reply
   * means documents are being processed; reporting that as "unavailable" told operators
   * the service was broken at exactly the moments it was working hardest, and any caller
   * polling readiness to decide whether to keep waiting would abandon a healthy job.
   */
  async health(): Promise<{
    state: 'ok' | 'busy' | 'down';
    detail: string | null;
    latencyMs: number;
  }> {
    const started = Date.now();
    try {
      await this.request('GET', '/health', undefined, WORKER_HEALTH_TIMEOUT_MS);
      const latencyMs = Date.now() - started;
      return {
        state: latencyMs > WORKER_HEALTH_BUSY_MS ? 'busy' : 'ok',
        detail:
          latencyMs > WORKER_HEALTH_BUSY_MS
            ? 'Answering slowly; documents are being processed.'
            : null,
        latencyMs,
      };
    } catch (error) {
      return {
        state: 'down',
        detail: error instanceof Error ? error.message : 'unknown',
        latencyMs: Date.now() - started,
      };
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-worker-token': this.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // The worker's `detail` is written for the end user ("This PDF is password
        // protected."). Replacing it with a generic sentence would leave somebody staring
        // at a failed document with no idea what to do about it, so it is carried through
        // for the 4xx case — the case where the document itself is the problem.
        let detail: string | null = null;
        try {
          const parsed = JSON.parse(text) as { detail?: unknown };
          if (typeof parsed.detail === 'string' && parsed.detail.trim().length > 0) {
            detail = parsed.detail.trim().slice(0, 400);
          }
        } catch {
          detail = null;
        }

        const isServerSide = response.status >= 500;
        throw new DocumentWorkerError(
          isServerSide
            ? 'The document worker is temporarily unavailable.'
            : (detail ?? 'This file could not be processed.'),
          isServerSide ? 'unavailable' : 'rejected',
          isServerSide,
          detail ?? text.slice(0, 500),
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DocumentWorkerError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DocumentWorkerError(
          `The document worker did not respond within ${(timeoutMs ?? this.timeoutMs) / 1000}s.`,
          'timeout',
          true,
        );
      }
      throw new DocumentWorkerError(
        'Could not reach the document worker.',
        'unavailable',
        true,
        error instanceof Error ? error.message : null,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
