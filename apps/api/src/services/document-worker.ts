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
export class DocumentWorkerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
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
    return this.request<ExtractionResult>('POST', '/extract', input);
  }

  async correct(input: CorrectionRequest & { bytesBase64: string; fileName: string }): Promise<CorrectionResult> {
    return this.request<CorrectionResult>('POST', '/correct', input);
  }

  async report(input: ReportRequest): Promise<{ documentBase64: string; contentType: string; extension: string }> {
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
    entries: Array<{ name: string; sizeBytes: number; compressedBytes: number; contentType: string }>;
  }> {
    return this.request('POST', '/archive/inspect', input);
  }

  async scan(input: { bytesBase64: string; fileName: string; declaredContentType: string }): Promise<{
    clean: boolean;
    detectedContentType: string;
    reason: string | null;
    signatures: string[];
  }> {
    return this.request('POST', '/scan', input);
  }

  async health(): Promise<{ ok: boolean; detail: string | null; latencyMs: number }> {
    const started = Date.now();
    try {
      await this.request('GET', '/health', undefined, 5000);
      return { ok: true, detail: null, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        ok: false,
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
        // 4xx from the worker means the document itself was rejected; retrying will not help.
        throw new DocumentWorkerError(
          response.status >= 500
            ? 'The document worker is temporarily unavailable.'
            : 'The document worker rejected this file.',
          response.status >= 500 ? 'unavailable' : 'rejected',
          response.status >= 500,
          text.slice(0, 500),
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
