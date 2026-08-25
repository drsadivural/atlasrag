# API

Versioned under `/api/v1`. Every response is JSON except artifact downloads and CSV
exports. The machine-readable specification is generated from the same Zod schemas the
server validates with:

```bash
pnpm --filter @uxe/api openapi > openapi.json
```

## Conventions

**Authentication** — an `HttpOnly`, `SameSite=Lax` session cookie. There is no bearer-token
mode: a token in JavaScript's reach is a token an XSS can steal.

**CSRF** — every unsafe method requires `x-csrf-token`, matching the value returned by
`GET /auth/session`. A stale token returns `403 csrf_failed`, which is deliberately
distinct from `403 forbidden` so a client can refresh and retry rather than showing a
permission error.

**Tenancy** — derived from the session. There is no workspace parameter on any endpoint,
and headers such as `x-workspace-id` are ignored.

**Idempotency** — every endpoint that creates work accepts `idempotency-key`. Replaying a
key returns the original job rather than starting a second one.

**Optimistic concurrency** — `PATCH` on a source or a consultation requires the `version`
you read. A stale version returns `409 version_conflict` rather than overwriting somebody
else's edit.

**Errors** — one shape, always:

```json
{
  "error": {
    "code": "version_conflict",
    "message": "This consultation changed since you opened it.",
    "fieldErrors": { "title": ["Required"] },
    "traceId": "3e71427f344a1c93",
    "retryable": false
  }
}
```

`traceId` is what an operator looks the failure up by. `retryable` tells the client whether
a retry is worth attempting.

**Rate limits** — `429` carries `Retry-After` in seconds.

## Endpoints

### Authentication

| Method     | Path                                             | Purpose                                           |
| ---------- | ------------------------------------------------ | ------------------------------------------------- |
| POST       | `/auth/register`                                 | Create an organization, workspace and Owner       |
| POST       | `/auth/verify-email`                             | Confirm an address                                |
| POST       | `/auth/login`                                    | Sign in; may answer `mfa_required`                |
| POST       | `/auth/mfa/verify`                               | Complete an MFA challenge (TOTP or recovery code) |
| POST       | `/auth/mfa/enroll` · `/auth/mfa/activate`        | Add a factor                                      |
| GET        | `/auth/session`                                  | Current session, permissions and CSRF token       |
| POST       | `/auth/logout`                                   | End this session                                  |
| POST       | `/auth/switch-workspace`                         | Move to another workspace you belong to           |
| GET/DELETE | `/auth/sessions[/:id]`                           | List and revoke device sessions                   |
| POST       | `/auth/forgot-password` · `/auth/reset-password` | Reset flow                                        |
| GET        | `/auth/invitations/:token`                       | Preview an invitation before accepting            |
| POST       | `/auth/invitations/accept`                       | Accept, set a password if needed, and sign in     |
| POST       | `/auth/magic-link[/consume]`                     | Passwordless sign-in                              |
| POST/GET   | `/auth/oauth/:provider/start` · `/callback`      | Google and Microsoft                              |

Registration answers identically whether or not the address already exists — same status,
same body — so the endpoint cannot be used to enumerate customers.

### Knowledge

| Method | Path                                            | Purpose                                                       |
| ------ | ----------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/sources`                                      | List with filters, counts and pipeline state                  |
| GET    | `/sources/:id`                                  | Full detail: versions, permissions, structure, processing log |
| PATCH  | `/sources/:id`                                  | Title, tags, effective date, access scope. Requires `version` |
| DELETE | `/sources/:id`                                  | Delete; citations stay resolvable until the purge             |
| GET    | `/sources/:id/versions`                         | Version history with checksums and OCR confidence             |
| POST   | `/sources/uploads`                              | Request upload tickets                                        |
| PUT    | `/sources/uploads/:ticketId/content`            | Upload the bytes                                              |
| POST   | `/sources/connectors`                           | Ingest from a URL or a connected drive                        |
| POST   | `/sources/:id/reprocess` · `/sync` · `/promote` | Re-index, re-fetch, promote to knowledge                      |
| POST   | `/sources/bulk`                                 | Tag, set access, reprocess, archive, restore, delete, export  |

### Consulting

| Method           | Path                                              | Purpose                                 |
| ---------------- | ------------------------------------------------- | --------------------------------------- |
| GET/POST         | `/consultations`                                  | List and create                         |
| GET/PATCH/DELETE | `/consultations/:id`                              | Detail, settings, deletion              |
| POST             | `/consultations/:id/messages`                     | Ask; returns `202` with the job         |
| POST             | `/consultations/:id/messages/:messageId/feedback` | Thumbs up or down                       |
| POST             | `/consultations/:id/cancel`                       | Stop a running answer                   |
| POST             | `/consultations/:id/uploads`                      | Attach documents as consultation inputs |
| POST             | `/consultations/:id/reviews`                      | Run a compliance review                 |
| POST             | `/consultations/:id/reports`                      | Generate a report artifact              |
| POST             | `/consultations/:id/corrections`                  | Build a correction plan                 |
| GET              | `/consultations/:id/stream`                       | Server-sent progress events             |

### Evidence, output and operations

| Method         | Path                                                        | Purpose                                                                       |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET            | `/citations/:id`                                            | Resolve a citation: page text, highlight offsets, neighbours, signed download |
| GET            | `/artifacts` · `/artifacts/:id` · `/artifacts/:id/download` | Reports and corrected editions                                                |
| GET/PATCH/POST | `/corrections/:planId[/generate]`                           | Review, decide and generate                                                   |
| GET            | `/jobs/:id`                                                 | Status, per-stage progress, error, result reference                           |
| GET            | `/dashboard`                                                | KPIs, trends and recent activity                                              |
| GET            | `/audit-events[/export]`                                    | Activity log; CSV export                                                      |
| GET/POST/PATCH | `/users[/invite][/:id]`                                     | Members and roles                                                             |
| GET/PATCH      | `/settings`                                                 | Workspace settings                                                            |
| POST           | `/settings/models`                                          | Configure a model provider                                                    |
| GET            | `/health` · `/ready` · `/metrics`                           | Liveness, readiness, Prometheus metrics                                       |

## The citation record

Citations are first-class records, never model-formatted strings:

```json
{
  "citationId": "01M0W...",
  "sourceId": "01M0W...",
  "sourceVersionId": "01M0W...",
  "sourceSha256": "9f2b...",
  "documentTitle": "UAE Fire and Life Safety Code",
  "documentType": "pdf",
  "pageNumber": 214,
  "chapter": "6",
  "section": "6.4",
  "clause": "6.4.2",
  "headingPath": ["Chapter 6", "6.4 Emergency lighting"],
  "charStart": 120,
  "charEnd": 240,
  "boundingBoxes": [{ "page": 214, "x": 0.1, "y": 0.2, "width": 0.8, "height": 0.04 }],
  "supportingExcerpt": "Emergency illumination shall provide an average illuminance of not less than 10 lux measured at the floor.",
  "entailment": "supports",
  "verified": true,
  "verificationMethod": "exact"
}
```

`supportingExcerpt` is the exact slice of the stored page text between `charStart` and
`charEnd`. `GET /citations/:id` returns the page text and the same offsets, so a client can
always find the quotation it was given.

## Streaming

`GET /consultations/:id/stream` is Server-Sent Events over durable state: every event is
also persisted, so a client that reconnects — or never connected — sees the same result by
polling `GET /consultations/:id`. The stream is a convenience, never the only delivery
path.

Event types: `job.progress`, `job.stage`, `message.updated`, `job.failed`, `job.succeeded`.
