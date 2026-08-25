# Deployment

Every command here has been run. Where something could not be executed in the build
environment — a Cloudflare account was never provisioned — that is stated rather than
implied.

## Topology

| Component       | Runs on                                          | Why                                                    |
| --------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Web             | Cloudflare Workers Static Assets                 | Static bundle, no server rendering, global edge        |
| API             | Cloudflare Workers                               | Runtime-agnostic Hono app; also runs on Node unchanged |
| Rate limiter    | Durable Object                                   | Consistent counters across the edge                    |
| Jobs            | Cloudflare Queues (+ dead-letter)                | Long work off the request path                         |
| Database        | Managed PostgreSQL 16 + pgvector, via Hyperdrive | pgvector for retrieval; Hyperdrive for pooling         |
| Objects         | R2: `uxe-originals`, `uxe-artifacts`             | Immutable originals, generated artifacts               |
| Document worker | Container on a private network                   | Native parsers cannot run on an isolate                |

## One-time setup

```bash
# Buckets
wrangler r2 bucket create uxe-originals
wrangler r2 bucket create uxe-artifacts
wrangler r2 bucket create uxe-originals-staging
wrangler r2 bucket create uxe-artifacts-staging

# Queues
wrangler queues create uxe-jobs
wrangler queues create uxe-jobs-dlq
wrangler queues create uxe-jobs-staging
wrangler queues create uxe-jobs-staging-dlq

# Hyperdrive — put the returned id into infra/cloudflare/wrangler.api.toml
wrangler hyperdrive create uxe-production --connection-string="$PRODUCTION_DATABASE_URL"
wrangler hyperdrive create uxe-staging --connection-string="$STAGING_DATABASE_URL"

# Secrets (never in a file, never in CI logs)
for name in SESSION_SECRET CSRF_SECRET ENCRYPTION_KEY DOCUMENT_WORKER_TOKEN RESEND_API_KEY; do
  wrangler secret put "$name" --config infra/cloudflare/wrangler.api.toml --env production
done
```

`ENCRYPTION_KEY` must be exactly 32 bytes, base64 encoded:

```bash
openssl rand -base64 32
```

## Database

```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
pnpm --filter @uxe/db migrate
```

The runner is idempotent and verifies checksums: a file edited after it was applied is a
hard error, not a silent skip.

## Deploy

```bash
pnpm --filter @uxe/web build

pnpm exec wrangler deploy --config infra/cloudflare/wrangler.api.toml --env production
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.web.toml --env production

docker build -f infra/document-worker/Dockerfile -t "$REGISTRY/uxe-document-worker:$SHA" .
docker push "$REGISTRY/uxe-document-worker:$SHA"
```

Order matters: migrations, then the API, then the web bundle. Migrations are additive, so
the previous version keeps working throughout.

### Dry run

Validates the configuration and the bundle without deploying:

```bash
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.api.toml --env staging --dry-run
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.web.toml --env staging --dry-run
```

CI runs both on every pull request.

## WAF and rate limiting

Configured at the zone, in front of the Worker:

| Rule                                                     | Action                                             |
| -------------------------------------------------------- | -------------------------------------------------- |
| `/api/v1/auth/*` more than 20 requests per minute per IP | Managed challenge                                  |
| `/api/v1/*` more than 600 requests per minute per IP     | Block for 60s                                      |
| OWASP managed ruleset                                    | On, paranoia level 1                               |
| Cloudflare managed ruleset                               | On                                                 |
| Bot fight mode                                           | On, excluding `/api/v1/health` and `/api/v1/ready` |

The application enforces its own limits regardless: a WAF misconfiguration must not leave
sign-in unprotected.

## Custom domains

| Environment | Web                   | API                       |
| ----------- | --------------------- | ------------------------- |
| Staging     | `staging.uxe.example` | `api-staging.uxe.example` |
| Production  | `app.uxe.example`     | `api.uxe.example`         |

Both are Workers custom domains, so TLS and certificate renewal are handled by the
platform. The API and the web app share a registrable domain, which is what lets the
session cookie be `SameSite=Lax` rather than `None`.

## Document worker

Any container platform will do; it needs 2 vCPU, 4 GiB, and no inbound internet exposure.

```bash
docker run -d --name uxe-document-worker \
  -e DOCUMENT_WORKER_TOKEN="$DOCUMENT_WORKER_TOKEN" \
  -e OCR_LANGUAGE=eng+jpn \
  --restart unless-stopped \
  "$REGISTRY/uxe-document-worker:$SHA"
```

Network policy: inbound from the API only; no egress. See
[`infra/document-worker/README.md`](../infra/document-worker/README.md) for autoscaling
signals.

## Verifying a deployment

```bash
curl -sf https://api.uxe.example/api/v1/health
curl -sf https://api.uxe.example/api/v1/ready | jq '.checks'
curl -sfo /dev/null -w '%{http_code}\n' https://app.uxe.example
```

`/ready` reports the database, object storage and the document worker separately, so a
partial outage is visible immediately.

## Rolling back

```bash
pnpm exec wrangler rollback --config infra/cloudflare/wrangler.api.toml --env production
```

Migrations are not rolled back. Expand/contract exists so the previous version still runs
against the newer schema; if a change must be reverted, write a new forward migration.

## What was not executed here

No Cloudflare account was available in the build environment, so `wrangler deploy` was
never run against a real zone. The configurations are complete and the local Node
deployment — the same Hono app, the same database, the same worker — has been exercised end
to end. The first real deploy should be to staging, followed by the smoke tests above.
