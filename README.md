# UXE Consulting AI

**Verified answers. Exact evidence. Corrected documents.**

A consulting workspace where Ayumi, the AI consultant, answers only from your approved
knowledge sources, reviews your documents against them, shows the exact clause and
quotation behind every claim, and produces corrected editions of the documents that fail.

The product's central property is mechanical rather than aspirational: **a quotation is
looked up, never generated.** Every excerpt is located in the stored source text before it
is persisted, so the system cannot show you a quote that is not in the document.

---

## What it does

| Capability          | What that means in practice                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grounded answers    | Answers come from your sources. When they cannot, the product says so rather than guessing.                                                                         |
| Exact evidence      | Document, version, page, chapter, section, clause, character offsets and bounding boxes. One click opens the source at the right page with the passage highlighted. |
| Compliance review   | Requirements extracted from the regulation, tested against your project documents, each with a verdict, a risk level and a citation.                                |
| Corrected documents | Review-first, non-destructive. Proposed changes carry the rule that justifies them; you accept or reject each one; the original is never modified.                  |
| Three answer depths | Yes/No, Optimal and Details are three views of **one** verified answer. Switching depth never re-runs retrieval, so they cannot contradict each other.              |

### Rules the system will not break

- Never invents a source, page, clause, quotation, version, result or confidence value.
- Says plainly when evidence is insufficient or conflicting.
- Partial compliance is reported as **NO** with "Partially compliant" alongside — never as
  a YES.
- Uploads are consultation inputs until explicitly promoted to knowledge.
- Originals are immutable; a correction creates a new version with a change log and a
  side-by-side diff.
- A generated PDF never claims to preserve a cryptographic signature. If the input was
  signed, the original is retained and the corrected edition is labelled an unsigned
  derivative.
- Tenancy and permissions are enforced server-side on every request **and every retrieval
  query**, from the authenticated session — never from client-supplied values.

---

## Quick start

Requirements: Node 22.12+, pnpm 11, Docker, and about 4 GB of free disk for the worker
image.

```bash
git clone <this-repository> uxe-consulting-ai
cd uxe-consulting-ai
pnpm install

cp .env.example .env
# Generate the three secrets the app needs:
#   openssl rand -base64 48   -> SESSION_SECRET
#   openssl rand -base64 48   -> CSRF_SECRET
#   openssl rand -base64 32   -> ENCRYPTION_KEY

docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Then open <http://localhost:5173>. The seed creates a workspace with real ingested
documents and a completed compliance review, so the dashboard is populated on first sign-in
rather than empty.

Seeded sign-in: the address and password printed by `pnpm db:seed`.

---

## Repository layout

```
apps/
  web/                 React 19 · Vite 8 · Tailwind 4 · React Router 7 · TanStack Query
  api/                 Hono 4 · Zod 4 — runs on Node and on Cloudflare Workers unchanged
services/
  document-worker/     Python 3.12 · FastAPI · PyMuPDF · Tesseract · LibreOffice
packages/
  contracts/           Zod schemas shared by client, server and tests. One source of truth.
  db/                  Drizzle schema, 44 tables, repositories that take a TenantContext
  auth/                Passwords, sessions, CSRF, TOTP, WebAuthn — all over WebCrypto
  rag/                 Chunking, retrieval fusion, citation verification, compliance rules
  ui/                  Design system: primitives, controls, overlays, data display
  observability/       Structured logging with redaction, tracing, metrics
  config/              Shared TypeScript, ESLint and Prettier configuration
tests/
  unit/ component/ integration/ rag-evals/ security/ e2e/ accessibility/
infra/
  cloudflare/ document-worker/ postgres/ docker-compose.yml
docs/
  architecture.md · threat-model.md · data-retention.md · rag-evaluation.md
  operations-runbook.md · baseline-report.md
```

---

## Commands

```bash
pnpm dev                  # API on :8787, web on :5173
pnpm verify               # format, lint, types, all tests, build — the gate before a PR

pnpm test:unit            # business rules, permissions, evidence, confidence
pnpm test:component       # forms, modes, upload states, tables, dialogs, navigation
pnpm test:integration     # real PostgreSQL, real document worker, real HTTP
pnpm test:rag-evals       # Recall@K, nDCG, verification rate, coverage, latency
pnpm test:security        # cross-tenant isolation, SSRF, CSRF, upload bypass, limits
pnpm test:e2e             # Playwright at 1440×900, 1024×768 and 390×844
pnpm test:a11y            # axe WCAG 2.2 AA plus keyboard-only smoke tests

pnpm db:migrate           # apply migrations (idempotent, checksum-verified)
pnpm db:seed              # ingest the demonstration corpus and run a real review
pnpm db:reset             # drop and recreate — development only
```

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones without which the
app will not start:

| Variable                                       | Purpose                                                               |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                                 | PostgreSQL 16 with pgvector                                           |
| `SESSION_SECRET`, `CSRF_SECRET`                | 32+ random bytes each                                                 |
| `ENCRYPTION_KEY`                               | Exactly 32 bytes, base64. Encrypts provider keys and connector tokens |
| `DOCUMENT_WORKER_URL`, `DOCUMENT_WORKER_TOKEN` | The extraction service and its shared secret                          |

Secrets belong in a runtime secret manager. `.env` is gitignored; `.env.example` contains
names and safe comments only.

### Models

The default answering engine is **deterministic and extractive**: it selects sentences from
retrieved passages under a fixed schema. It needs no credentials and cannot hallucinate,
because it never generates prose.

Anthropic and OpenAI plug into the same interface under **Settings → Models**. Their output
passes through the identical verification gate — an invented quotation is discarded on the
same code path regardless of which model produced it.

General-knowledge fallback is **off by default**. When enabled, any sentence not drawn from
your sources is visibly labelled as such.

---

## Testing

| Layer          | What it proves                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Unit           | Permission filters, evidence coverage, confidence, versioning, correction selection                               |
| Component      | Every state: loading, empty, success, validation, permission-denied, failure                                      |
| Integration    | The real API against a real ephemeral database and the real document worker                                       |
| RAG evaluation | Recall@5 ≥ 80%, nDCG@5 ≥ 0.7, **100%** quotation verification and locator accuracy, **zero** cross-tenant leakage |
| Security       | Cross-tenant IDOR, unauthenticated access, SSRF, XSS, CSRF, upload bypass, rate limiting                          |
| E2E            | Sign-in, upload, ask, cite, review, correct — driven through the browser                                          |
| Accessibility  | axe WCAG 2.2 AA on every route, plus keyboard-only operation                                                      |

Document fixtures include a scanned PDF (OCR), a corrupt PDF, a password-protected PDF, an
EICAR sample, a zip bomb, a ZIP claiming to be a PDF and a PDF containing a prompt-injection
attempt. Each is asserted to be handled, not to crash.

---

## Deployment

- **Web** — Cloudflare Workers Static Assets
- **API** — Cloudflare Workers, with R2, Queues, Hyperdrive and a Durable Object rate limiter
- **Document worker** — a container on a private network, no inbound internet, no egress
- **Database** — managed PostgreSQL 16 with pgvector

```bash
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.api.toml --env production
pnpm exec wrangler deploy --config infra/cloudflare/wrangler.web.toml --env production
docker build -f infra/document-worker/Dockerfile -t $REGISTRY/uxe-document-worker:$SHA .
```

Migrations follow expand → migrate → contract, so a rollback never lands on a schema it
cannot read. See [`docs/operations-runbook.md`](docs/operations-runbook.md).

---

## Documentation

| Document                                            | Read it when                                             |
| --------------------------------------------------- | -------------------------------------------------------- |
| [architecture.md](docs/architecture.md)             | You need to know how a request becomes a verified answer |
| [threat-model.md](docs/threat-model.md)             | You are reviewing this for security                      |
| [data-retention.md](docs/data-retention.md)         | A customer asks what is stored and for how long          |
| [rag-evaluation.md](docs/rag-evaluation.md)         | You want the retrieval numbers and their thresholds      |
| [operations-runbook.md](docs/operations-runbook.md) | Something is broken at 3am                               |
| [baseline-report.md](docs/baseline-report.md)       | You want the decisions taken before any code was written |

---

## Accessibility and internationalisation

WCAG 2.2 AA, verified by automated scans on every route and by keyboard-only tests. Visible
focus everywhere, no colour-only status, `prefers-reduced-motion` honoured, 44×44 px touch
targets, and no horizontal page scrolling at any supported width.

English and Japanese ship with a complete message catalogue structure; RTL is not blocked —
direction is derived from the locale rather than hard-coded.
