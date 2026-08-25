# Operations runbook

For whoever is on call. Every procedure here has been run against the real stack, not
sketched from the architecture diagram.

## Health

| Check               | Endpoint                             | Healthy                                            |
| ------------------- | ------------------------------------ | -------------------------------------------------- |
| API                 | `GET /api/v1/health`                 | `{"status":"ok"}`                                  |
| API dependencies    | `GET /api/v1/ready`                  | every check `status: "ok"`                         |
| Document worker     | `GET /health` on the worker          | `{"status":"ok"}`                                  |
| Worker capabilities | `GET /capabilities` (token required) | Tesseract, LibreOffice and Ghostscript all present |

`/ready` reports the database, object storage and the document worker separately, with a
latency for each, so "the API is up but ingestion is failing" is one request away from being
diagnosed. It returns `degraded` when the worker is down — answering still works, because
retrieval and citation verification never call it — and `down` when the database or object
store is unreachable.

## Metrics worth alerting on

| Metric                                     | Alert                    | Meaning                                                     |
| ------------------------------------------ | ------------------------ | ----------------------------------------------------------- |
| `uxe_job_failures_total` by kind           | > 5% of runs over 15 min | Ingestion or answering is broken                            |
| `uxe_job_duration_ms` p95, `source_ingest` | > 300 s                  | Worker starved or a pathological document                   |
| `processing_jobs` queued depth             | > 100 for 10 min         | The cron drain is not keeping up                            |
| `uxe_citation_verification_rate`           | drops below 1.0          | Extraction drift — the most serious signal the system emits |
| `uxe_cross_tenant_denials_total`           | any non-zero rate        | Somebody is probing another tenant's identifiers            |
| `uxe_http_request_duration_ms` 5xx rate    | > 1% over 5 min          | Standard availability alert                                 |
| 429 rate                                   | sudden rise              | Abuse, or a limit set too low                               |
| `uxe_retrieval_duration_ms` p95            | > 4 s                    | Index bloat or a missing index                              |
| `uxe_provider_tokens_total`                | sudden rise              | A hosted provider is being driven harder than expected      |

Scraped from `GET /api/v1/metrics` in Prometheus text format.

The citation-verification alert deserves the most attention: it means quotations are no
longer matching stored text, which is the product's core promise failing quietly.

## Common incidents

### Documents stuck in Processing

1. Is the worker healthy? `curl $DOCUMENT_WORKER_URL/health`
2. Is anything claiming jobs? `SELECT status, count(*) FROM processing_jobs GROUP BY status;`
3. Jobs abandoned by a crashed process are reclaimed automatically after the stale window
   (5 minutes). To force it: restart the API; `reclaimStale` runs on the next loop tick.
4. A genuinely failed job leaves the source at `failed` with a reason, and the Knowledge
   Base shows a Retry. Bulk retry: **Knowledge → select → Reprocess**.

### The document worker is unreachable

Ingestion fails with `worker_unavailable`, which is retryable — jobs back off and resume.
Answering is unaffected: retrieval and citation verification never call the worker.

```bash
docker logs document-worker --tail 200
docker restart document-worker
```

If it will not start, check `GET /capabilities` on the previous image: a missing Tesseract
or LibreOffice binary means an incomplete image build, not a runtime fault.

### Answers are abstaining more than usual

Almost always retrieval, not the answering engine:

```sql
-- Is anything indexed?
SELECT s.title, count(c.id) AS chunks
FROM sources s
LEFT JOIN source_versions v ON v.source_id = s.id AND v.is_current
LEFT JOIN chunks c ON c.source_version_id = v.id
WHERE s.workspace_id = $1
GROUP BY s.title ORDER BY chunks;
```

A source with zero chunks was never successfully indexed. Reprocess it. If many sources
show zero, the embeddings stage is failing — check `job_attempts` for that stage.

### A citation will not open

The evidence viewer resolves a citation to page text and offsets. If it fails:

1. Does the source version still exist? A purge removes page text but keeps the locator.
2. Was the source reprocessed? A new version has new page text; citations pin the version
   they were created against, so an old citation should still resolve against the old one.
3. Check `citations.verification_method` — `failed` means it was already known to be
   unverifiable and is displayed as such.

### Rate limits are firing for a legitimate customer

Limits are per IP for auth and per workspace for work. Raise the relevant environment
variable and redeploy; the values are configuration, not code:

```
RATE_LIMIT_UPLOAD_PER_HOUR
RATE_LIMIT_CONSULT_PER_HOUR
```

Never disable the auth limits: they are the only defence against credential stuffing.

## Deploying

```bash
# 1. Migrations first — additive, so the running version keeps working.
pnpm --filter @uxe/db migrate

# 2. API and web.
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.api.toml --env production
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.web.toml --env production

# 3. Document worker.
docker build -f infra/document-worker/Dockerfile -t $REGISTRY/uxe-document-worker:$SHA .
docker push $REGISTRY/uxe-document-worker:$SHA

# 4. Smoke test.
curl -sf https://api.uxe.example/api/v1/health
curl -sf https://api.uxe.example/api/v1/ready
```

### Rolling back

```bash
pnpm exec wrangler rollback --config infra/cloudflare/wrangler.api.toml --env production
```

Migrations are **not** rolled back. Expand/contract exists precisely so the previous version
still runs against the new schema. If a migration must be reverted, write a new forward
migration; never edit an applied one — the runner verifies checksums and will refuse.

## Backups and restore

```bash
# Nightly, retained 30 days
pg_dump --format=custom --no-owner "$DATABASE_URL" > uxe-$(date -u +%Y%m%dT%H%M%SZ).dump

# Restore into a fresh database
createdb uxe_restore
pg_restore --dbname="$RESTORE_URL" --no-owner --jobs=4 uxe-20260825T020000Z.dump
```

R2 holds the originals. A database restore without the matching object store leaves
sources whose bytes are missing; the UI shows those as failed rather than pretending they
are readable. Restore both, or accept that ingestion must be re-run.

**Test the restore quarterly.** An untested backup is a hope.

## Rotating secrets

```bash
wrangler secret put SESSION_SECRET --env production   # signs out everyone: schedule it
wrangler secret put CSRF_SECRET --env production      # invalidates in-flight forms only
wrangler secret put DOCUMENT_WORKER_TOKEN --env production  # roll the worker at the same time
```

`ENCRYPTION_KEY` is different: it decrypts stored provider keys and connector tokens.
Rotating it requires re-encrypting those rows. Until that tooling exists, treat it as
fixed for the life of the deployment and protect it accordingly.

## Restoring a deleted source inside the grace period

```sql
UPDATE sources SET deleted_at = NULL, status = 'ready'
WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NOT NULL;
```

Only works before the purge job has run. After that the bytes are gone from R2 and the
document must be re-uploaded.

## What never to do

- Never edit an applied migration. Write a new one.
- Never `UPDATE audit_events`. The database will refuse, and wanting to is a red flag.
- Never set `LOG_DOCUMENT_CONTENT=true` in production. It puts customer document text in
  the logs.
- Never point `TEST_DATABASE_URL` at a real database. The integration suite truncates every
  table between cases.
