/**
 * Minimal OpenTelemetry-compatible tracing.
 *
 * Trace and span IDs follow the W3C `traceparent` format so spans emitted here stitch
 * together with any OTLP collector or downstream service. The exporter is pluggable; the
 * default is a no-op so tests and local runs carry no cost, and `OTEL_EXPORTER_OTLP_ENDPOINT`
 * activates real export in deployed environments.
 */

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  attributes: SpanAttributes;
  status: 'ok' | 'error';
  error: string | null;
}

export type SpanExporter = (span: FinishedSpan) => void;

const HEX = '0123456789abcdef';

function randomHex(length: number): string {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf];
    out += HEX[byte & 0xf];
  }
  return out;
}

export function newTraceId(): string {
  return randomHex(32);
}

export function newSpanId(): string {
  return randomHex(16);
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Continues an inbound trace when the caller sent a valid W3C traceparent header. */
export function parseTraceparent(header: string | null | undefined): {
  traceId: string;
  parentSpanId: string;
} | null {
  if (!header) return null;
  const match = header.trim().toLowerCase().match(TRACEPARENT);
  if (!match?.[1] || !match[2]) return null;
  if (match[1] === '0'.repeat(32) || match[2] === '0'.repeat(16)) return null;
  return { traceId: match[1], parentSpanId: match[2] };
}

export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

export class Span {
  readonly spanId = newSpanId();
  private readonly startTime = Date.now();
  private status: 'ok' | 'error' = 'ok';
  private error: string | null = null;
  private ended = false;

  constructor(
    readonly traceId: string,
    readonly name: string,
    readonly parentSpanId: string | null,
    private readonly attributes: SpanAttributes,
    private readonly exporter: SpanExporter,
  ) {}

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: SpanAttributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  recordError(error: unknown): this {
    this.status = 'error';
    this.error = error instanceof Error ? error.message : String(error);
    return this;
  }

  end(): FinishedSpan {
    const endTime = Date.now();
    const finished: FinishedSpan = {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime,
      durationMs: endTime - this.startTime,
      attributes: this.attributes,
      status: this.status,
      error: this.error,
    };
    // Guard against a double `end()` in a finally block emitting two spans.
    if (!this.ended) {
      this.ended = true;
      this.exporter(finished);
    }
    return finished;
  }
}

export class Tracer {
  constructor(
    private readonly exporter: SpanExporter = () => {},
    private readonly sampleRate = 1,
  ) {}

  startSpan(
    name: string,
    options: { traceId?: string; parentSpanId?: string | null; attributes?: SpanAttributes } = {},
  ): Span {
    return new Span(
      options.traceId ?? newTraceId(),
      name,
      options.parentSpanId ?? null,
      options.attributes ?? {},
      this.sampled() ? this.exporter : () => {},
    );
  }

  /** Runs `fn` inside a span, recording failures and always ending the span. */
  async withSpan<T>(
    name: string,
    options: { traceId?: string; parentSpanId?: string | null; attributes?: SpanAttributes },
    fn: (span: Span) => Promise<T>,
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      return await fn(span);
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  private sampled(): boolean {
    if (this.sampleRate >= 1) return true;
    if (this.sampleRate <= 0) return false;
    return Math.random() < this.sampleRate;
  }
}

/** Batches spans and posts them to an OTLP/HTTP collector. */
export function createOtlpExporter(options: {
  endpoint: string;
  serviceName: string;
  fetchImpl?: typeof fetch;
  flushIntervalMs?: number;
  maxBatch?: number;
}): SpanExporter & { flush: () => Promise<void> } {
  const buffer: FinishedSpan[] = [];
  const maxBatch = options.maxBatch ?? 100;
  const fetchImpl = options.fetchImpl ?? fetch;

  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    const body = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: options.serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: 'uxe' },
              spans: batch.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? undefined,
                name: s.name,
                startTimeUnixNano: String(s.startTime * 1_000_000),
                endTimeUnixNano: String(s.endTime * 1_000_000),
                status: { code: s.status === 'error' ? 2 : 1, message: s.error ?? undefined },
                attributes: Object.entries(s.attributes)
                  .filter(([, v]) => v !== undefined)
                  .map(([key, value]) => ({
                    key,
                    value:
                      typeof value === 'number'
                        ? { doubleValue: value }
                        : typeof value === 'boolean'
                          ? { boolValue: value }
                          : { stringValue: String(value) },
                  })),
              })),
            },
          ],
        },
      ],
    };

    try {
      await fetchImpl(`${options.endpoint.replace(/\/$/, '')}/v1/traces`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Telemetry must never break the request it is describing.
    }
  };

  const exporter = ((span: FinishedSpan) => {
    buffer.push(span);
    if (buffer.length >= maxBatch) void flush();
  }) as SpanExporter & { flush: () => Promise<void> };

  exporter.flush = flush;
  return exporter;
}
