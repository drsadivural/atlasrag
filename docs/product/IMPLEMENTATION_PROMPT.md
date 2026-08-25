# UXE Consulting AI — Master Production Implementation Prompt

Copy this entire prompt into Claude Code or Codex at the root of the target repository.

---

You are the senior product designer, staff full-stack engineer, AI/RAG engineer, security engineer, and QA lead responsible for building **UXE Consulting AI** as a production-ready, multi-tenant web application.

Build the complete application. Do not produce a prototype, static mockup, partial implementation, dead controls, placeholder pages, TODO comments, fake success states, or disconnected UI. Every visible action must work end-to-end, be tested, and have loading, empty, success, validation, permission-denied, and recoverable failure states.

## 1. Product objective

UXE Consulting AI is the real communication and document-work workspace between a professional consultant and a customer. It must answer questions using only approved knowledge-base sources, review one or many customer documents, summarize them, create reports, assess whether they satisfy regulations/rules/standards, show exact verifiable evidence, and create corrected document editions when requested.

The application name is exactly **UXE Consulting AI**. The interactive consultant is **Ayumi** and the supplied `assets/consultantgirl.png` must be used throughout the experience.

Primary promise:

> Verified answers. Exact evidence. Corrected documents.

## 2. Non-negotiable product behavior

1. Answers must be grounded in the selected, permission-approved knowledge-base sources.
2. Never invent a source, page, clause, quote, document version, result, or confidence value.
3. If evidence is insufficient or conflicting, say so visibly and ask a precise follow-up question when useful.
4. Every material compliance claim must be traceable to a citation containing document, version, page, exact section/clause/paragraph, supporting excerpt, and source location coordinates when available.
5. Clicking a citation must open the correct source at the correct page and highlight the exact cited passage.
6. User uploads are consultation inputs, not permanent knowledge sources unless the user explicitly promotes them.
7. The original uploaded file is immutable. Corrections always create a new version plus a change log and side-by-side diff.
8. Corrected files must match the input type: PDF to PDF, DOCX to DOCX. Also support XLSX and PPTX preservation when feasible.
9. Never claim that a generated PDF preserves a cryptographic signature. If the input is signed, retain the original and clearly label the corrected edition as a new unsigned derivative.
10. Tenant, workspace, source, conversation, and document permissions must be enforced server-side on every request and retrieval query.
11. All long-running ingestion, OCR, review, report, and document-generation jobs must be asynchronous, resumable, idempotent, observable, and retryable.
12. No hidden chain-of-thought is displayed. Show concise conclusions, structured findings, calculations, evidence, assumptions, uncertainties, and recommended actions.

## 3. First execution steps

1. Inspect the repository, current framework, routes, components, data model, authentication, environment conventions, tests, and deployment configuration.
2. Preserve working behavior and adapt to the existing architecture when it is sound. If the repository is empty, use the architecture below.
3. Create a short baseline report: current state, reused components, risks, migration plan, and acceptance checklist.
4. Capture baseline screenshots and run the existing test/lint/typecheck/build suite before changing code.
5. Implement in small vertical slices. Re-run affected tests after each slice.
6. Do not remove or rename existing public routes, fields, environment variables, or APIs without a backward-compatible migration.

## 4. Required architecture

Use a GitHub-ready monorepo with a lockfile and reproducible builds.

```text
uxe-consulting-ai/
├── apps/
│   ├── web/                    # React + TypeScript responsive application
│   └── api/                    # Cloudflare Worker API/BFF
├── services/
│   └── document-worker/        # Python FastAPI worker for OCR/conversion/correction
├── packages/
│   ├── ui/                     # Shared design system and Storybook
│   ├── db/                     # Schema, migrations, tenant-safe repositories
│   ├── auth/                   # Authentication and authorization
│   ├── contracts/              # OpenAPI/Zod schemas and generated clients
│   ├── rag/                    # Retrieval, reranking, citations, evaluations
│   ├── observability/          # Logs, traces, metrics, audit events
│   └── config/                 # Shared lint, TS, formatting configuration
├── tests/
│   ├── e2e/
│   ├── accessibility/
│   ├── security/
│   ├── rag-evals/
│   └── fixtures/
├── infra/
│   ├── cloudflare/
│   └── document-worker/
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── data-retention.md
│   ├── rag-evaluation.md
│   └── operations-runbook.md
├── .env.example
├── .gitignore
└── README.md
```

Preferred production topology:

- Web and API/BFF: Cloudflare Workers using a supported React deployment adapter and TypeScript.
- CDN, WAF, rate limiting, bot protection, TLS: Cloudflare.
- Original and generated files: private Cloudflare R2 buckets with short-lived signed access.
- Background dispatch: Cloudflare Queues and Workflows; every message includes tenant, job, attempt, idempotency key, and trace IDs.
- Transactional database: managed PostgreSQL with `pgvector`, accessed from Workers through Cloudflare Hyperdrive.
- Hybrid retrieval: PostgreSQL full-text/BM25-equivalent ranking plus pgvector, merged with reciprocal-rank fusion and reranked.
- Native document processing: containerized Python worker with LibreOffice headless, PyMuPDF, pdfplumber, OCRmyPDF/Tesseract, python-docx, openpyxl, python-pptx, and safe MIME inspection. Deploy the worker to a production container runtime; keep the public edge and file delivery on Cloudflare.
- Cache and ephemeral coordination: Workers KV only for non-authoritative cache/config; Durable Objects where serialized coordination is required.
- Secrets: runtime secret manager only. Never expose provider keys to the browser or commit secrets.
- Email: transactional provider through an adapter for verification, password reset, invitations, and job completion notifications.
- Observability: OpenTelemetry-compatible traces, structured JSON logs, exception monitoring, metrics, and immutable application audit events.

Use current stable, mutually compatible dependencies. Pin exact versions in lockfiles. Run dependency and container vulnerability scans in CI.

## 5. Authentication, tenancy, and authorization

Implement:

- Email/password sign-in with email verification and secure password reset.
- Google and Microsoft OAuth.
- Optional magic-link sign-in.
- MFA using TOTP and WebAuthn/passkeys.
- Secure, HttpOnly, SameSite cookies; CSRF protection; session rotation; device/session management.
- Multi-tenant organizations/workspaces.
- Roles: Owner, Admin, Consultant, Knowledge Manager, Reviewer, Member, Read Only.
- Source-level ACLs for workspace, group, and named-user access.
- User invitation, suspension, role change, and removal workflows.
- Server-side authorization in repositories/services, not just hidden buttons.
- Tenant IDs derived from the authenticated session, never trusted from client-supplied values.

## 6. Required routes

```text
/login
/register
/forgot-password
/dashboard
/consult
/consult/:consultationId
/knowledge
/knowledge/:sourceId
/reports
/reports/:reportId
/activity
/users
/settings/general
/settings/consultant
/settings/models
/settings/security
/settings/retention
```

Unauthenticated users can access only authentication/legal routes. Authenticated routes use a shared responsive application shell.

## 7. Visual system

Match the supplied screen concepts and `assets/reference/consultant-main.png` closely.

- Typeface: Inter or a metrically compatible self-hosted sans-serif.
- Main background: `#F8FAFF`; surfaces: `#FFFFFF`; primary text: `#10162F`; secondary text: `#667085`.
- Primary gradient: cobalt `#3156F5` to violet `#7C3AED`.
- Success: `#12A86B`; warning: `#F59E0B`; danger: `#E5484D`; information: `#2563EB`; teal accent: `#0EA5A8`.
- Card radius: 12–16 px. Controls: 10–12 px. Soft cool shadows and 1 px neutral borders.
- Body text: 15–16 px; control text no smaller than 13 px; WCAG AA contrast.
- Use clear outline icons in 20–24 px sizes and larger 36–48 px graphic tiles for major actions.
- Motion: 150–220 ms, subtle and purposeful; honor `prefers-reduced-motion`.
- Use skeletons for loading, progress stages for jobs, and optimistic UI only where rollback is safe.
- Support light and dark themes. The supplied concepts define the light theme; dark theme must use semantic tokens, not inverted images.
- Ayumi must never obscure controls or content. Use `object-fit: contain`; retain her full proportions where shown. Provide an accessible alt text and hide purely decorative duplicates from screen readers.

### Responsive behavior

- Desktop ≥1280 px: persistent left navigation, primary content, optional right evidence rail.
- Tablet 768–1279 px: collapsible navigation; evidence rail becomes a slide-over panel.
- Mobile <768 px: bottom navigation for Dashboard, Consult, Knowledge, Reports, More. Consultation history becomes a drawer. Composer remains sticky above safe-area insets. Result modes use a horizontal segmented control. Citation viewer opens full-screen.
- No horizontal page scrolling. Tables become cards or controlled scroll regions with pinned primary columns.

## 8. Login page

Reproduce `assets/screens/01-login.png`.

Left side:

- UXE Consulting AI logo and promise.
- Ayumi using `assets/consultantgirl.png`.
- Trust cues for enterprise-grade security, source-grounded answers, and confidential document handling.
- Restrained floating cards for Compliance check, Evidence match, and Document correction.

Right side:

- Welcome back card.
- Continue with Google and Continue with Microsoft.
- Work email, password with visibility toggle, remember me, forgot password, sign in, and create account.
- Inline field errors, invalid-credential state, rate-limit state, SSO error recovery, MFA step, password reset success, and session-expired banner.
- Keyboard-complete and password-manager-compatible form.

## 9. Dashboard page

Reproduce `assets/screens/02-dashboard.png`.

Required content:

- Time-aware greeting and compact Ayumi banner.
- Primary `Start consultation` action.
- KPI cards: consultations, documents reviewed, compliance rate, evidence coverage, including change versus the selected prior period.
- Consultation activity chart with date range and accessible table alternative.
- Compliance outcomes donut: compliant, needs evidence, non-compliant, not assessed.
- Recent consultations table with owner, status, compliance score, source count, update time, and overflow actions.
- Needs attention rail containing failed jobs, critical gaps, unresolved evidence, stale knowledge, and pending review.
- Knowledge health card: ready, processing, outdated, failed, missing metadata, unlinked content.
- Clicking every metric filters/drills into the relevant page.
- Empty state starts a consultation or adds sources; errors provide retry and trace/reference ID.

## 10. Knowledge Base page

Reproduce `assets/screens/03-knowledge-base.png`.

### Source ingestion

Support:

- Drag/drop and browse for PDF, DOCX, XLSX, CSV, PPTX, TXT, Markdown, HTML, common images, and ZIP archives with safe expansion limits.
- Google Drive, OneDrive, SharePoint, and Website URL connectors through provider adapters.
- Manual pasted text.
- Multiple files in one batch, resumable upload, per-file progress, cancellation, retry, and failure details.
- Scheduled auto-sync with include/exclude paths and file-type rules.
- URL crawling with domain allowlists, robots/authorization compliance, depth/page limits, canonical URL handling, and change detection.
- MIME sniffing, extension validation, antivirus/malware scan, archive-bomb prevention, file/page/token limits, and password-protected file handling.

### Source management UI

Include:

- Upload zone and connector buttons.
- Status filters: All, Ready, Processing, Needs review, Failed, Archived.
- Search, file-type filter, tags, owner, permissions, modified date, source type, and version.
- Source table columns: selection, document, type, pages, version, access, last synced, status, and menu.
- Bulk tag, permission, reprocess, archive, export, and delete actions with confirmation and audit events.
- Indexing pipeline panel: malware scan, extraction/OCR, structure analysis, chunking, embeddings, lexical index, citation map, validation.
- Knowledge health score calculated from pipeline success, staleness, metadata completeness, citation readiness, duplicates, and permission integrity. Show the formula in a tooltip.
- Preview drawer with pages, extracted text, detected headings/clauses/tables, metadata, versions, permissions, sync history, processing logs, retry, replace version, and archive.

### Versioning and sync

- Compute SHA-256 for original bytes and normalized extracted content.
- Do not duplicate identical versions.
- Preserve source/version lineage.
- A new version is indexed separately, then atomically promoted after validation.
- Existing consultations retain the exact source-version citation they used.
- Deleting a source uses soft-delete and retention policy; citations remain resolvable for authorized audit users until purge.

## 11. Consult Now page

Reproduce `assets/screens/04-consult-now.png` and use the supplied reference as the primary composition guide.

### Layout

Left column:

- Searchable consultation history, pinned/recent groups, status badges, rename, duplicate, archive, export, and delete.
- New consultation button.
- Ayumi online/availability card showing `Grounded in your approved sources`.

Center workspace:

- Editable consultation title.
- Selected knowledge-base source chips and uploaded customer document chips.
- `Manage sources` opens a searchable, permission-filtered source selector with version and effective-date details.
- Four task modes: Ask, Summarize, Check compliance, Correct document.
- Conversation timeline with user/assistant messages, attached files, tool/job status, citations, feedback, copy, download, share, regenerate, and branch-from-message.
- Sticky multimodal composer with text, voice input, multi-file upload, Google Drive, OneDrive, SharePoint, URL, send/cancel generation, and keyboard shortcut.

Right Evidence & Output panel:

- Answer style segmented control: `Yes / No`, `Optimal`, `Details + references`.
- Evidence detail toggles: document/page, clause/exact location, supporting excerpt.
- Output format panel that defaults to matching the source format.
- Evidence coverage gauge, source counts, verified/conflict/missing-evidence state.
- Response controls: Knowledge only, Ask when uncertain, and General model fallback. General fallback must be disabled by default and any non-knowledge statement must be visibly labeled.
- On tablet/mobile the rail becomes a slide-over/full-screen panel while preserving all functions.

### Answer styles

Implement a single structured answer schema rendered at three depths. Changing mode must re-render from the same verified evidence object when possible, not run unrelated retrieval and produce contradictory answers.

#### Yes / No

- First line must be `YES`, `NO`, or `UNABLE TO DETERMINE`.
- If partially compliant, return `NO` and show `Partially compliant` as a secondary label; do not falsely imply full compliance.
- Include one sentence explaining the decisive reason.
- Include up to three decisive citations.
- Never force a binary answer when evidence is insufficient.

#### Optimal

- Executive answer in approximately 150–350 words depending on the task.
- Decision/status, concise explanation, key findings, risk/priority, recommended next actions, confidence, and key citations.
- Use a compact evidence table for compliance work.

#### Details + references

- Full audit-grade answer with scope, documents/versions reviewed, assumptions, requirement-by-requirement findings, calculations, conflicts, missing evidence, risk level, remediation, confidence, and complete citation list.
- Evidence table columns: requirement, result, finding, source, version, chapter/section/clause, page, exact location, supporting excerpt, confidence.
- Provide downloadable CSV/XLSX evidence matrix and a formatted PDF/DOCX report.

### Core tasks

1. Ask a question against selected approved sources.
2. Summarize a document, selected pages, or a batch; allow executive, section-by-section, obligations, risks, and custom formats.
3. Compare documents or source versions.
4. Check uploaded documents against selected regulations, standards, policies, or playbooks.
5. Produce compliant/non-compliant/needs-evidence findings per requirement.
6. Generate an evidence-backed report.
7. Generate a corrected edition with reviewable proposed changes.
8. Continue interactively with context while allowing the user to pin/unpin documents and sources.
9. Export/share the conversation and artifacts subject to permissions.

## 12. Evidence and citation system

Store citations as first-class records, never as model-formatted strings only.

Each citation must include:

```json
{
  "citationId": "stable-id",
  "tenantId": "server-derived",
  "sourceId": "source-id",
  "sourceVersionId": "immutable-version-id",
  "sourceSha256": "sha256",
  "documentTitle": "title",
  "documentType": "pdf|docx|xlsx|pptx|html|image|text",
  "pageNumber": 214,
  "sheetName": null,
  "slideNumber": null,
  "chapter": "6",
  "section": "6.4",
  "clause": "6.4.2",
  "paragraphIndex": 3,
  "boundingBoxes": [{"page":214,"x":0.1,"y":0.2,"width":0.7,"height":0.05}],
  "supportingExcerpt": "verbatim source excerpt",
  "retrievalScore": 0.91,
  "rerankScore": 0.96,
  "entailment": "supports|contradicts|context",
  "createdAt": "ISO-8601"
}
```

Citation requirements:

- Render inline citation chips plus a complete evidence drawer.
- Citation click opens exact location and highlight; keyboard focus moves to the passage.
- If page numbers are unavailable, show the closest valid locator such as sheet/cell range, slide/shape, heading/paragraph, URL fragment, or image region.
- Verify that cited excerpts exist verbatim in the stored extracted content and correspond to the cited locator before persisting the answer.
- If citation verification fails, remove the unsupported claim or mark it unverified; do not display a green verified state.
- Conflicting sources must be surfaced with source version/effective date and a conflict explanation.
- Confidence is derived from evidence coverage, retrieval/rerank quality, citation verification, source authority, recency, and contradiction checks. It is not a raw model self-score.

## 13. RAG and compliance-analysis pipeline

### Ingestion

1. Validate authorization, file type, size, and scan status.
2. Store immutable original bytes and checksum.
3. Extract native text, tables, images, metadata, outline, headers/footers, footnotes, tracked changes, comments, page geometry, and stable locators.
4. Use OCR only when needed; store OCR confidence and page image coordinates.
5. Normalize without destroying the original text or locator mapping.
6. Detect headings, chapters, clauses, lists, tables, definitions, exceptions, effective dates, superseded status, and cross-references.
7. Chunk structurally, keeping clause/table boundaries and parent headings. Add controlled overlap without mixing unrelated sections.
8. Create embeddings, lexical index, and metadata filters.
9. Validate extraction coverage and citation jump targets before promoting the version to Ready.

### Retrieval

1. Resolve tenant/workspace/user/source/version permissions first.
2. Classify task and expand the query using defined terms, abbreviations, and source metadata.
3. Run hybrid lexical and vector retrieval with metadata filters.
4. Fuse candidates, rerank, expand parent/neighbor context, and remove duplicates.
5. For compliance checks, first build the applicable requirement set, then test each requirement against project-document evidence. Do not rely on a single free-form prompt.
6. Detect contradictory provisions, exceptions, superseded versions, and missing project evidence.
7. Generate a structured answer and citation objects.
8. Run citation-verification and claim-support checks.
9. Compute evidence coverage and confidence deterministically.
10. Persist prompt/model/retrieval configuration, source versions, citations, latency, and token/cost metrics for audit, without logging sensitive document content by default.

### Evaluation

Create a versioned evaluation set containing representative Q&A, clause lookup, table lookup, multi-document comparison, conflict, insufficient-evidence, compliance, OCR, and prompt-injection cases.

Measure:

- Retrieval Recall@K and nDCG@K.
- Citation precision, citation locator accuracy, and quoted-text verification rate.
- Claim faithfulness/entailment.
- Requirement coverage and false-compliance rate.
- Correct abstention rate.
- Cross-tenant leakage: must be zero.
- p50/p95 latency and cost per consultation task.

CI must block releases when critical safety/security/evidence thresholds regress.

## 14. Prompt-injection and untrusted-content defense

- Treat uploaded and retrieved document text as untrusted data, never system instructions.
- Separate system policy, user task, tool results, and source excerpts.
- Strip/neutralize active content, scripts, macros, external relationships, and embedded instructions during extraction while preserving a safe original.
- Use allowlisted tools and schema-validated tool arguments.
- Do not let retrieved content change permissions, disable grounding, reveal secrets, or initiate external actions.
- Display a warning and quarantine suspicious content when a document attempts instruction injection or data exfiltration.

## 15. Corrected-document workflow

The correction workflow is review-first, non-destructive, and format-aware.

1. User selects findings to correct and optional drafting instructions.
2. Generate a structured change plan containing location, current content, proposed content, reason, governing citation, risk, and confidence.
3. Show side-by-side diff and let the user accept/reject/edit each change.
4. Generate a new derivative only from accepted changes.
5. Validate the resulting file opens, has expected pages/sections, retains media/styles/page dimensions, and includes no unintended content loss.
6. Store the new artifact with lineage to the original, change log, generator/model version, and checksum.
7. Offer download, report, and authorized share.

Format rules:

- DOCX: preserve section/page settings, styles, numbering, tables, headers/footers, images, comments, and metadata where safe. Prefer tracked changes or an accompanying redline when faithful tracked-change generation is possible.
- PDF with editable text: use precise replacement/overlay while maintaining page size, coordinates, fonts where legally available, and visual hierarchy. Always render every page and compare before release.
- Scanned PDF: OCR, create a corrected searchable PDF, preserve page images when possible, and disclose OCR confidence/limitations.
- Signed PDF: never modify or imply preservation of signature validity. Generate a new corrected copy and explicit signature-status notice.
- XLSX: preserve sheets, formulas, formats, validations, named ranges, and charts; never execute macros.
- PPTX: preserve slide size, masters, layouts, media, notes, and theme.
- If faithful in-place correction is unsafe, generate the same file type as a professionally formatted revised edition plus an exact change report. State the limitation before generation.

## 16. Data model

Implement migrations, indexes, foreign keys, soft-delete policy where required, and tenant-safe repository methods for at least:

- users
- organizations
- workspaces
- memberships
- groups
- sessions
- auth_factors
- invitations
- sources
- source_connectors
- source_sync_rules
- source_versions
- source_permissions
- source_pages
- source_sections
- source_chunks
- embeddings
- consultations
- consultation_participants
- consultation_sources
- messages
- message_attachments
- citations
- compliance_reviews
- requirements
- findings
- correction_plans
- correction_changes
- generated_artifacts
- processing_jobs
- job_attempts
- reports
- user_preferences
- model_configurations
- audit_events
- retention_policies
- deletion_requests

Use UUID/ULID-style non-enumerable IDs, UTC timestamps, optimistic concurrency/version columns where users edit data, and composite tenant-aware indexes. Prevent orphaned storage objects.

## 17. API contract

Expose versioned APIs with generated OpenAPI documentation and schema validation. Include:

```text
POST   /api/v1/auth/*
GET    /api/v1/dashboard
GET    /api/v1/consultations
POST   /api/v1/consultations
GET    /api/v1/consultations/:id
PATCH  /api/v1/consultations/:id
DELETE /api/v1/consultations/:id
POST   /api/v1/consultations/:id/messages
POST   /api/v1/consultations/:id/cancel
POST   /api/v1/consultations/:id/uploads
POST   /api/v1/consultations/:id/reviews
POST   /api/v1/consultations/:id/reports
POST   /api/v1/consultations/:id/corrections
GET    /api/v1/jobs/:id
POST   /api/v1/jobs/:id/retry
GET    /api/v1/sources
POST   /api/v1/sources/uploads
POST   /api/v1/sources/connectors
GET    /api/v1/sources/:id
PATCH  /api/v1/sources/:id
POST   /api/v1/sources/:id/reprocess
POST   /api/v1/sources/:id/sync
GET    /api/v1/sources/:id/versions
GET    /api/v1/citations/:id
GET    /api/v1/artifacts/:id/download
GET    /api/v1/audit-events
GET    /api/v1/users
PATCH  /api/v1/users/:id
GET    /api/v1/settings
PATCH  /api/v1/settings
```

Use SSE or a reliable WebSocket abstraction for streamed answers and job progress. Persist the final result independently of the stream so refresh/reconnect is safe. All mutation endpoints use idempotency keys where duplicate requests could create work or artifacts.

## 18. Reports, activity, users, and settings

### Reports

- Searchable artifact library for summaries, compliance reports, evidence matrices, and corrected documents.
- Filters, preview, version, owner, status, generated time, source lineage, download, share, archive, and retention.

### Activity / logs

- Human-readable event timeline and admin audit log.
- Actor, action, target, timestamp, result, IP/device metadata where lawful, trace ID, and before/after summary.
- Filter/export with permission checks. Do not log raw secrets or full sensitive document content.

### Users

- Invite, role, group, source access, activity, MFA state, suspend/reactivate, revoke sessions, remove.

### Settings

- General workspace name, locale, timezone, branding.
- Consultant name, title, avatar, greeting, behavior, answer defaults.
- Model/provider configuration with primary/fallback models, capability routing, health, token/quota status, test connection, and safe secret entry.
- Knowledge-only default, uncertainty behavior, citation requirements, minimum evidence threshold.
- Security, sessions, SSO, MFA policy, allowed domains.
- Retention, deletion, legal hold, export.
- Notifications and job completion preferences.

## 19. Model configuration and failure behavior

- Use provider adapters and capability routing for chat/reasoning, embeddings, OCR/vision, reranking, and document generation.
- Keep provider secrets server-side and encrypted at rest.
- Display provider health and actionable errors for expired credentials, missing scopes, quota exhaustion, unsupported model, and rate limits.
- Retries use exponential backoff with jitter only for retryable errors.
- Circuit-break failing providers and use an approved fallback only when workspace policy permits.
- Record which model/configuration produced each artifact.
- If all models fail, preserve the job and user input, show a recoverable status, and provide retry after configuration is fixed.

## 20. Security and privacy acceptance requirements

- TLS everywhere, private buckets, short-lived signed downloads, encryption at rest.
- Strict Content Security Policy, security headers, origin validation, CORS allowlist, CSRF defense, XSS-safe rendering, SQL parameterization, and SSRF-safe URL ingestion.
- Upload scanning, size/type limits, decompression limits, sandboxed conversion, macro/script blocking.
- Per-user and per-workspace rate limits plus abuse detection.
- Audit all authentication, permission, source, review, artifact, configuration, and deletion events.
- Data export and deletion flows; configurable retention; background purge with proof-of-completion events.
- Backups with documented restore test.
- Threat model covering cross-tenant access, insecure direct-object references, prompt injection, malicious documents, signed URL leakage, connector token exposure, and model-provider data handling.
- Never train on customer data unless a separately signed, explicit opt-in exists.

## 21. Performance and reliability targets

- Initial authenticated dashboard LCP ≤2.5 seconds at p75 on a typical broadband connection.
- Common API reads p95 ≤500 ms excluding long AI/document jobs.
- First streamed answer token target ≤3 seconds when provider latency allows.
- Uploads are multipart/resumable and do not proxy large bodies through memory.
- Virtualize long lists and conversations.
- Lazy-load preview/rendering and non-critical charts.
- Support at least 100 concurrent active consultation streams per production environment initially, with documented scaling tests.
- Queue jobs are idempotent, have dead-letter handling, visible retry, and no silent loss.
- Health/readiness endpoints verify required dependencies without exposing secrets.

## 22. Accessibility and internationalization

- Meet WCAG 2.2 AA.
- Full keyboard navigation, visible focus, correct landmarks, labels, live regions for streamed/progress content, screen-reader-friendly citation navigation, chart table alternatives, and accessible dialogs.
- Do not use color alone for status.
- Support English initially with complete i18n infrastructure and locale-aware dates/numbers; include Japanese translation structure without hard-coded mixed-language UI.
- Right-to-left layout must not be architecturally blocked.

## 23. Testing

Implement and run:

- Unit tests for business rules, permission filters, evidence coverage, confidence, versioning, and correction selection.
- Component tests for forms, segmented modes, upload states, source selectors, evidence tables, dialogs, and responsive navigation.
- API integration tests using a real ephemeral test database and storage emulator/isolated bucket.
- Document fixture tests for native/scanned PDF, DOCX with tables/styles, XLSX formulas, PPTX, corrupted files, encrypted files, duplicate versions, and malicious archives.
- RAG evaluation tests for exact citation location, missing evidence, conflicting sources, prompt injection, and requirement coverage.
- Playwright E2E tests for sign-in, upload/ingest, start consultation, each answer style, citation jump, compliance review, corrected edition, download, permission denial, failed job retry, mobile flow, and logout.
- Accessibility scans using axe plus manual keyboard smoke tests.
- Security tests for cross-tenant IDOR, unauthenticated signed URL, SSRF, XSS, CSRF, upload bypass, connector-token exposure, and rate limiting.
- Visual regression screenshots at desktop 1440×900, tablet 1024×768, and mobile 390×844 for all four primary screens.

Do not mark the work complete unless lint, format check, typecheck, unit, integration, E2E, accessibility, security smoke tests, production build, migrations, and deployment dry run pass.

## 24. Required acceptance scenarios

1. A new user registers, verifies email, signs in, creates/joins a workspace, and sees a useful empty dashboard.
2. A Knowledge Manager uploads a 1,300-page regulation PDF, observes processing stages, sees Ready only after citation-map validation, and can open an exact clause/page.
3. A user uploads multiple project PDF/DOCX files in Consult Now, selects a regulation, and requests a compliance review.
4. Yes/No mode returns a defensible binary result or Unable to determine with decisive citations.
5. Optimal mode returns a concise executive explanation with prioritized gaps and actions.
6. Details + references returns the full evidence matrix and every citation opens at the correct location.
7. The user generates a corrected DOCX and receives DOCX plus redline/change log; the original remains unchanged.
8. The user generates a corrected PDF; page size/layout are validated and signature limitations are handled accurately.
9. A lower-permission user cannot retrieve, cite, preview, search, download, or infer a restricted source.
10. A source update creates a version; old consultation citations still resolve to the old version while new consultations use the promoted version.
11. A failed OCR/model/upload job shows an actionable reason and can be retried without duplicating artifacts.
12. The entire core workflow works on a 390 px mobile viewport.

## 25. Documentation and deployment

Create:

- Complete README with local prerequisites, setup, environment-variable names/descriptions, database migration/seed, test, build, and deployment commands.
- `.env.example` containing variable names only and safe comments; no secrets.
- Architecture diagram and data-flow diagram.
- RAG ingestion/retrieval/citation design and evaluation procedure.
- Security threat model and privacy/data-retention documentation.
- Operational runbook for failed uploads, stuck queues, model outages, connector expiry, restoration, and rollback.
- Cloudflare infrastructure configuration for web/API, R2, queues/workflows, Hyperdrive, WAF, rate limits, custom domain, and environment separation.
- Container image, health checks, autoscaling, and deployment configuration for the document worker.
- CI pipeline for install, lint, typecheck, tests, scans, build, migrations check, preview deploy, and gated production deployment.

Use separate development, staging, and production environments. Production deployment must be reversible and use backward-compatible expand/migrate/contract database changes.

## 26. Final delivery format

When implementation is complete, provide:

1. Concise outcome summary.
2. Exact files and modules added/changed.
3. Architecture and important decisions.
4. Database migrations and environment variables.
5. Commands executed and their results.
6. Screenshots at desktop/tablet/mobile for Login, Dashboard, Knowledge Base, and Consult Now.
7. Test/coverage/RAG evaluation/security results.
8. Deployment URL or deployment-ready commands and configuration.
9. Known limitations only if they are real and unavoidable; do not conceal incomplete work.
10. Five evidence-based next-feature recommendations, clearly separate from the completed scope.

Begin by inspecting the repository and assets. Then implement, validate, and deliver the full production application.
