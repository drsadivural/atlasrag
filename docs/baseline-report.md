# Baseline report

Captured before any implementation code was written, per section 3 of the implementation brief.

## 1. Current state of the repository

`git log` contains a single commit (`1642a03 Initial commit`) whose entire tracked content is a
two-word `README.md`. The only other content was an untracked `UXE_Consulting_AI_Package/`
directory holding the design brief, research notes, image prompts and six PNG assets.

| Question | Finding |
| --- | --- |
| Framework in place | None. No `package.json`, no source tree, no build. |
| Routes / components | None. |
| Data model / migrations | None. |
| Authentication | None. |
| Environment conventions | None. No `.env`, no `.env.example`. |
| Tests / lint / typecheck / build | **None.** There is no suite to run and therefore no pass/fail baseline to preserve. |
| Deployment configuration | None. No CI, no container, no infrastructure files. |
| Public routes / fields / env vars / APIs | None exist, so section 3.6 (no removal or rename without a backward-compatible migration) is satisfied vacuously. |

### Consequences for the brief's first-execution steps

* **3.2 "preserve working behavior and adapt to the existing architecture"** — there is no existing
  architecture, so the brief's own fallback applies: the section 4 architecture is used verbatim.
* **3.4 "capture baseline screenshots and run the existing suite"** — there is no application to
  screenshot and no suite to run. The supplied concepts in `assets/screens/` are therefore the only
  visual baseline, and implementation screenshots are compared against them at the same viewport.
  This is recorded rather than silently skipped.

## 2. Reused components

Nothing executable was reusable. The following supplied inputs are carried forward unchanged and
treated as authoritative:

| Input | Role in the implementation |
| --- | --- |
| `assets/consultantgirl.png` | The canonical Ayumi character asset. Served by the web app, never re-generated or edited. |
| `assets/screens/01-login.png` … `04-consult-now.png` | Visual acceptance references for the four primary screens. |
| `assets/reference/consultant-main.png` | Primary composition guide for the Consult Now workspace. |
| `docs/product/IMPLEMENTATION_PROMPT.md` | The authoritative behavioural contract. Moved out of the package directory, content unchanged. |
| `docs/product/RESEARCH_NOTES.md`, `UI_IMAGE_PROMPTS.md` | Product research and prompt provenance. |

The design brief's own guidance is respected: text baked into the mockups is a visual reference,
not a data contract. Where a mockup number and the written specification disagree, the written
specification wins and the number becomes seed data.

## 3. Environment probe

Run before committing to the architecture, because several sections of the brief are only
deliverable if the host can actually execute them.

| Capability | Result | Effect on the plan |
| --- | --- | --- |
| Node.js | v24.15.0 | Satisfies Vite 8's `>=22.12.0` engine requirement. |
| pnpm | 11.16.0, warm store (1.1 GB) | Workspace manager; hardlinked installs keep disk use low. |
| Python | 3.12.3 with `venv` | Document worker runtime. |
| PostgreSQL | No local binary, but Docker is running | `pgvector/pgvector:pg16` pulled; pgvector **0.8.6** verified live. Dev and integration tests use a real Postgres, not a stub. |
| Tesseract | 5.3.4 (system) | OCR is genuinely available, not simulated. |
| LibreOffice / Ghostscript | present (system) | Office conversion and PDF post-processing are available. |
| PyMuPDF 1.28.2 | verified: created a PDF, extracted its text, and resolved a **bounding box** for a searched phrase | Confirms exact citation coordinates are achievable, which the whole evidence system depends on. |
| Playwright browsers | chromium **1234** already cached | Pin `@playwright/test@1.62.1`, whose `browsers.json` declares revision 1234 — E2E runs with zero browser download. |
| Network | npm + PyPI reachable | Exact version pinning is possible. |
| Disk | ~3 GB free | Favours pnpm hardlinks and a single database image; avoid redundant toolchains. |

### One dependency decision forced by the probe

`typescript-eslint@8.68.0` declares `typescript: ">=4.8.4 <6.1.0"`. TypeScript 7.0.2 is current
stable but **is not** compatible with it. The brief requires dependencies that are current stable
*and mutually compatible*, so TypeScript is pinned to **5.9.3**.

## 4. Risks and how each is handled

| # | Risk | Handling |
| --- | --- | --- |
| R1 | **No model-provider credentials are available in this environment.** A build that only works with a hosted LLM key would be undemonstrable and untestable here. | The model layer is an adapter interface with three implementations. The default, `deterministic`, is a real **extractive** engine: it answers only by selecting and quoting passages that were actually retrieved, so every sentence is verifiable by construction and the citation-verification gate can never be bluffed. `anthropic` and `openai` adapters are wired to the same interface and activate when a key is configured. The suite runs green with no credentials. |
| R2 | Cloudflare Workers cannot run Python, yet OCR/office conversion require it. | Split exactly as the brief's topology says: edge (Hono on Workers) dispatches jobs; a containerised FastAPI worker does extraction, OCR, correction and generation. The Hono app is runtime-agnostic and also runs on Node for local dev and integration tests. |
| R3 | No Cloudflare account is attached to this environment, so a live production deploy cannot be performed. | Ship complete, reviewable `wrangler` configuration, R2/Queues/Hyperdrive bindings, container definition and a gated CI pipeline, and state plainly that the production deploy step itself was not executed here. Nothing is reported as deployed that was not deployed. |
| R4 | A model or a careless prompt could emit a citation that does not exist. | Citations are first-class rows, not model-formatted strings. Every excerpt is re-checked verbatim against stored extracted text **and** against its locator before an answer is persisted; failures downgrade the claim to unverified instead of showing a green state. |
| R5 | Uploaded documents are untrusted input that may attempt prompt injection. | Extraction strips active content; source text is passed only inside a data channel that is never concatenated into system policy; an injection detector quarantines and surfaces suspicious documents. |
| R6 | Corrected-document generation could silently corrupt a file or imply a signature survived. | Correction is review-first and non-destructive: originals are immutable, changes are accepted individually, output is re-opened and validated before release, and signed PDFs produce a labelled unsigned derivative. |
| R7 | Tight disk (~3 GB). | Reuse the cached Playwright browsers, one database image, pnpm hardlinks; no duplicate toolchains. |

## 5. Migration plan

There is no prior schema, API or route surface, so this is a greenfield forward migration rather
than a compatibility exercise.

1. Foundation: workspace, shared TS/lint/format config, CI skeleton.
2. `packages/db`: schema + versioned SQL migrations + tenant-safe repositories. Migrations are
   expand/migrate/contract from day one so later releases inherit the pattern.
3. `packages/auth`: sessions, password and OAuth sign-in, MFA, CSRF, RBAC and source ACLs.
4. `packages/rag`: chunking, embeddings, hybrid retrieval, fusion, reranking, citation
   verification, evidence coverage, confidence, requirement extraction, compliance evaluation.
5. `services/document-worker`: extraction, OCR, structure detection, correction, generation.
6. `apps/api`: the versioned HTTP contract, job orchestration and SSE streaming.
7. `packages/ui` then `apps/web`: design system, then the routes, matched to the supplied concepts.
8. Tests at every layer, then documentation and infrastructure.

Each slice re-runs the affected tests before the next begins.

## 6. Acceptance checklist

Derived from sections 20–24 of the brief. Each line is verified by an automated check.

- [ ] Answers cite only permission-approved sources; cross-tenant retrieval leakage measures zero.
- [ ] Every citation carries document, version, page/locator, exact section, excerpt and coordinates where available.
- [ ] Clicking a citation opens the correct source at the correct page with the passage highlighted.
- [ ] Excerpts are verified verbatim against stored text before an answer is persisted.
- [ ] Insufficient or conflicting evidence is stated visibly instead of being answered around.
- [ ] Yes/No never fabricates a binary when evidence is insufficient; partial compliance returns NO plus a secondary label.
- [ ] All three answer styles render from the same verified evidence object.
- [ ] Uploads are consultation inputs until explicitly promoted.
- [ ] Originals are immutable; corrections create a new version with a change log and side-by-side diff.
- [ ] Corrected output matches input type; signed PDFs are labelled as unsigned derivatives.
- [ ] Authorization is enforced server-side in repositories, not by hiding buttons.
- [ ] Long-running jobs are asynchronous, idempotent, observable and retryable without duplicating artifacts.
- [ ] Source updates create versions; historical citations still resolve to the version they used.
- [ ] WCAG 2.2 AA: keyboard paths, focus, live regions, chart table alternatives, no colour-only status.
- [ ] The core workflow completes on a 390 px viewport.
- [ ] Lint, format, typecheck, unit, component, integration, RAG-eval, security, E2E, a11y and build all pass.
