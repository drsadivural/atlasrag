export interface MetricPoint {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

/**
 * In-process metrics with a Prometheus text exposition.
 *
 * Histograms use explicit buckets rather than a summary so p50/p95 stay aggregatable
 * across instances, which matters because the performance targets in section 21 are stated
 * at p75 and p95 across the whole environment, not per worker.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();
  private readonly labelSets = new Map<string, Record<string, string>>();

  increment(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
    this.labelSets.set(key, labels);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.gauges.set(key, value);
    this.labelSets.set(key, labels);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const list = this.histograms.get(key) ?? [];
    list.push(value);
    // Bound memory: keep the most recent window rather than growing without limit.
    if (list.length > 4096) list.splice(0, list.length - 4096);
    this.histograms.set(key, list);
    this.labelSets.set(key, labels);
  }

  /** Times an async operation and records success/failure as a label. */
  async time<T>(name: string, labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.observe(name, Date.now() - started, { ...labels, outcome: 'success' });
      return result;
    } catch (error) {
      this.observe(name, Date.now() - started, { ...labels, outcome: 'error' });
      throw error;
    }
  }

  percentile(name: string, labels: Record<string, string>, p: number): number | null {
    const list = this.histograms.get(this.key(name, labels));
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index] ?? null;
  }

  snapshot(): MetricPoint[] {
    const now = Date.now();
    const out: MetricPoint[] = [];

    for (const [key, value] of this.counters) {
      out.push({ name: this.nameOf(key), value, labels: this.labelSets.get(key) ?? {}, timestamp: now });
    }
    for (const [key, value] of this.gauges) {
      out.push({ name: this.nameOf(key), value, labels: this.labelSets.get(key) ?? {}, timestamp: now });
    }
    for (const [key, list] of this.histograms) {
      const labels = this.labelSets.get(key) ?? {};
      const name = this.nameOf(key);
      const sorted = [...list].sort((a, b) => a - b);
      out.push({ name: `${name}_count`, value: sorted.length, labels, timestamp: now });
      out.push({
        name: `${name}_sum`,
        value: sorted.reduce((a, b) => a + b, 0),
        labels,
        timestamp: now,
      });
      for (const p of [50, 95, 99]) {
        const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        out.push({ name: `${name}_p${p}`, value: sorted[index] ?? 0, labels, timestamp: now });
      }
    }

    return out;
  }

  toPrometheus(): string {
    return this.snapshot()
      .map((point) => {
        const labels = Object.entries(point.labels)
          .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
          .join(',');
        return `${point.name}${labels ? `{${labels}}` : ''} ${point.value}`;
      })
      .join('\n');
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.labelSets.clear();
  }

  private key(name: string, labels: Record<string, string>): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return `${name}|${entries.map(([k, v]) => `${k}=${v}`).join(',')}`;
  }

  private nameOf(key: string): string {
    return key.split('|')[0] ?? key;
  }
}

export const METRIC_NAMES = {
  httpRequestDuration: 'uxe_http_request_duration_ms',
  retrievalDuration: 'uxe_retrieval_duration_ms',
  answerDuration: 'uxe_answer_duration_ms',
  jobDuration: 'uxe_job_duration_ms',
  citationVerificationRate: 'uxe_citation_verification_rate',
  evidenceCoverage: 'uxe_evidence_coverage',
  providerRequests: 'uxe_provider_requests_total',
  providerTokens: 'uxe_provider_tokens_total',
  jobFailures: 'uxe_job_failures_total',
  crossTenantDenials: 'uxe_cross_tenant_denials_total',
} as const;
