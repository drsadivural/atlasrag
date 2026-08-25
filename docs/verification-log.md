# Verification log

What was actually run, and what it produced. Every figure here comes from a command
executed against the real stack — PostgreSQL 16 with pgvector, the real migrations, the
real Python document worker — not from inspection.

Where something could not be executed in the build environment, that is stated plainly
rather than glossed.

## Environment

| Component  | Version                                           |
| ---------- | ------------------------------------------------- |
| Node       | 22.19.2                                           |
| pnpm       | 11.16.0                                           |
| TypeScript | 5.9.3                                             |
| PostgreSQL | 16 with pgvector 0.8.6 (`pgvector/pgvector:pg16`) |
| Python     | 3.12 with PyMuPDF 1.28.2, Tesseract 5.3.4         |
| Playwright | 1.62.1, Chromium                                  |

## Static checks

| Check  | Command             | Result                             |
| ------ | ------------------- | ---------------------------------- |
| Format | `pnpm format:check` | Clean                              |
| Lint   | `pnpm lint`         | Clean — zero errors, zero warnings |
| Types  | `pnpm -r typecheck` | Clean across all 10 projects       |

Lint began at 235 problems and finished at zero. Fourteen of those were genuine defects
rather than style: a `<tr onClick>` unreachable by keyboard, a `tabIndex` on four
non-interactive tooltip anchors, a `<label>` bound to nothing, a heading that could render
empty, five `setState` calls in effects that rendered a stale value first, a mutation
during render, and a dead assignment.

## Defects found by running the system

The table below lists what running the system found that inspection had not — the test
suites, the linter, the browser, and following the README as written. Each was fixed and is
now covered.

| #   | Defect                                                                                                                 | Found by                         | Consequence if shipped                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | MFA verification returned 500 on every attempt — the handler re-read a request body the validator had already consumed | Integration                      | **Two-factor sign-in was completely broken.** Anyone with MFA enabled could not sign in.                                |
| 2   | Recovery codes were rejected by validation (`/^\d{6}$/`) despite being offered on the sign-in screen                   | Integration                      | A user who lost their authenticator was permanently locked out.                                                         |
| 3   | Registering an existing address returned 200 while a new one returned 201                                              | Integration                      | A status-code oracle for enumerating customers.                                                                         |
| 4   | A failed ingestion left the source at `pending` for ever                                                               | Integration                      | A document stuck in "Processing" with no reason and no retry — the dead end the brief forbids.                          |
| 5   | Worker failure detail was replaced with "The document worker rejected this file"                                       | Integration                      | "This PDF is password protected" became a message the user could do nothing with.                                       |
| 6   | `PATCH /sources/:id` required a `version` the API never exposed                                                        | Integration                      | Source editing was impossible for any client.                                                                           |
| 7   | The invitation email linked to `/accept-invite`, which existed in neither the API nor the web app                      | Integration                      | **Invited members could never join.** The entire invitation flow was a dead end.                                        |
| 8   | The upload endpoint ignored the size its own ticket declared                                                           | Security                         | The declared size — used for quota accounting — was unenforceable.                                                      |
| 9   | CSRF failures were indistinguishable from permission failures                                                          | Integration                      | A stale token showed "forbidden", so a client could not know to refresh and retry.                                      |
| 10  | `utm_*` parameters were never stripped (the regex was anchored on the prefix alone)                                    | Unit                             | The same page ingested repeatedly under tracking-parameter variants.                                                    |
| 11  | Storage keys kept `..` sequences from a client-supplied filename                                                       | Unit                             | Defence in depth weakened; a filename of `..` produced a traversal segment.                                             |
| 12  | Log redaction missed every camelCase credential (`csrfToken`, `sessionToken`, `apiKey`)                                | Unit                             | Tokens written to logs in the naming convention this codebase actually uses.                                            |
| 13  | Redaction hid bare `code` fields, including job error codes                                                            | Integration (observed in output) | The reason a job failed was `[redacted]` in the logs.                                                                   |
| 14  | Citation excerpts were stored whitespace-normalised while offsets pointed at the raw text                              | Integration                      | The evidence viewer could not find its own quotation on the page.                                                       |
| 15  | An unverified citation was rendered in quieter chrome than a verified one                                              | Component                        | The one citation needing attention was the least visually prominent.                                                    |
| 16  | A clickable table row had no keyboard path                                                                             | Lint + component                 | Every list in the product was mouse-only.                                                                               |
| 17  | `DataTable` accepted a `loading` prop and did nothing with it                                                          | Component                        | Headers over an empty body read as "no results" while the request was still running.                                    |
| 18  | `Field` never bound its error to the control                                                                           | Component                        | 34 form fields where a red border was the only signal, with no `aria-invalid`.                                          |
| 19  | Two navigation landmarks shared one accessible name                                                                    | Component                        | Ambiguous landmark navigation for screen-reader users.                                                                  |
| 20  | The dropdown label overrode the trigger's own name                                                                     | Component                        | The workspace switcher announced "Workspace" instead of the workspace.                                                  |
| 21  | Arrow keys moved focus but not selection in a `radiogroup`                                                             | Component                        | The answer-style switch violated the pattern its own role promises.                                                     |
| 22  | The correction workflow had no review surface: the API could plan and generate, the web app could only start a plan    | Browser                          | The toast promised "you will review each proposed change" and there was nowhere to do it.                               |
| 23  | `CorrectionPlan.version` was required by the decide endpoint but never returned                                        | Integration                      | No client could ever accept a proposed change.                                                                          |
| 24  | The correction planner produced an empty plan when no review was named                                                 | Browser                          | "Generate corrected PDF" reported success and did nothing.                                                              |
| 25  | `pnpm db:migrate` / `db:seed` / `db:reset` failed from the repository root with "DATABASE_URL is not set"              | Following the README             | The documented setup did not work: dotenv reads the working directory, and pnpm sets that to the package.               |
| 26  | The seed wrote source rows pointing at storage keys whose bytes were never stored                                      | Browser                          | Every operation needing the original — download, reprocess, correction — failed in the demonstration workspace.         |
| 27  | `tsc` emitted build output into `packages/config`                                                                      | Lint                             | The shared React tsconfig set an `outDir` that resolves relative to itself, so every consumer that emitted wrote there. |
| 28  | The CORS preflight omitted `PUT`, the method upload bytes arrive on                                                    | Browser                          | **Every browser upload failed** with a network error wherever the API is a separate origin — the production topology.   |
| 29  | Upload tickets returned an absolute API URL, making the request cross-site                                             | Browser                          | The `SameSite=Lax` session cookie was not sent, so uploads arrived unauthenticated.                                     |
| 30  | Sign-out left the app rendering the signed-out user's workspace                                                        | Browser                          | `queryClient.clear()` drops the session query out from under its observer without giving it a new result.               |
| 31  | The profile button had no accessible name below 640px                                                                  | Accessibility                    | An unnamed control on every mobile screen.                                                                              |
| 32  | Picking a conversation on tablet or mobile left the history drawer covering it                                         | Browser                          | The picker obscured the thing it had just picked.                                                                       |
| 33  | White on the avatar tints was 3.0–3.6:1                                                                                | axe                              | Below WCAG AA on every avatar in the product.                                                                           |
| 34  | Every status badge label was 2.0–3.4:1 on its own tint                                                                 | axe                              | Compliant / Non-compliant / Needs evidence were all below AA.                                                           |
| 35  | Tertiary text was 2.6:1, danger text 3.9:1 and success text 3.1:1 on white                                             | axe                              | Below AA at 11–14px.                                                                                                    |
| 36  | A button wrapped a cell that already contained a link                                                                  | axe                              | Nested interactive controls, and a 21.7px target below the 24px minimum.                                                |
| 37  | A malformed session response crashed the whole application shell                                                       | Component                        | One missing field took down every screen instead of degrading.                                                          |

## Test results

| Suite                            | Tests | Result |
| -------------------------------- | ----- | ------ |
| Unit                             | 179   | Pass   |
| Component                        | 96    | Pass   |
| Integration — auth               | 20    | Pass   |
| Integration — knowledge          | 17    | Pass   |
| Integration — consultation       | 11    | Pass   |
| Integration — users and settings | 16    | Pass   |
| RAG evaluation                   | 8     | Pass   |
| Security                         | 37    | Pass   |

### RAG evaluation, measured

| Metric                      | Threshold       | Measured               |
| --------------------------- | --------------- | ---------------------- |
| Recall@5                    | ≥ 80%           | 100% (5/5)             |
| nDCG@5                      | ≥ 0.70          | 0.926                  |
| Quoted-text verification    | 100%            | 100% over 30 citations |
| Locator accuracy            | 100%            | 100% over 30 citations |
| Requirement coverage        | 100%            | 100% (4/4)             |
| Retrieval latency p50 / p95 | < 1.5 s / < 4 s | 5 ms / 8 ms            |
| Cross-tenant leakage        | 0               | 0                      |

Integration coverage includes 13 document fixtures: a text PDF, a scanned PDF through OCR,
DOCX, XLSX, PPTX, a corrupt PDF, a password-protected PDF, a ZIP claiming to be a PDF, an
EICAR sample, a zip bomb, an ELF with a `.pdf` extension, a prompt-injection PDF and a
benign archive.

## Observed behaviour on the fixture corpus

From `tests/integration/consultation.test.ts`, running the real pipeline:

- **Question:** "What illuminance does emergency lighting require?" → answered from the
  regulation, every citation verified, the excerpt containing "10 lux".
- **Question:** "What is the maximum permitted noise level for standby generators?" →
  abstained. Nothing in the corpus addresses it, and the answer says so.
- **No sources attached** → refused outright, with zero citations and an explanation.
- **Compliance review** → emergency illumination non-compliant (6 lux against a 10 lux
  minimum), travel distance compliant (38 m within 45 m), exit-sign luminance
  `needs_evidence`. Overall: **NO / Partially compliant**, with zero unverified citations.

## Verified in the browser

Beyond the automated suites, the following were driven through a real browser against the
seeded workspace and confirmed by inspecting the artifacts they produced:

| Flow                | Observed                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in → dashboard | Real KPIs from seeded rows; the consultant's given name and honorific in the greeting                                                                          |
| Edit a source       | Title, tags, effective date and access scope saved; tags appear immediately in the metadata card                                                               |
| Correction workflow | Plan produced two changes; accepting one and generating produced a corrected PDF and a redline                                                                 |
| Corrected document  | The generated PDF reads "The design illuminance at floor level is 10 lux" where the original read "6 lux"; the original source is unchanged at its own version |

## What was not executed

| Item                                | Why                                            | What was done instead                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare deployment               | No account was available in this environment   | Wrangler configurations for both workers across staging and production, plus a CI dry-run job that validates them                                           |
| Hosted model providers              | No API credentials                             | The adapters are implemented against the same interface and pass the same verification gate; the deterministic engine is the default and is fully exercised |
| Google / Microsoft OAuth round trip | No client credentials                          | The PKCE flow, state handling and callback are implemented and unit-tested; the redirect itself is untested                                                 |
| Managed PostgreSQL and R2           | Local Docker and a filesystem bucket were used | Both implement the identical driver interfaces the production drivers do                                                                                    |

## The single gate

```bash
pnpm verify
```

Runs format check, lint, typecheck, every Vitest project and the production build. The
browser layers are separate because they need a running stack:

```bash
pnpm test:e2e     # 49 tests across three viewports
pnpm test:a11y    # 37 axe and keyboard-only tests, nothing skipped
```

## Staging provisioning

`infra/staging/provision-postgres.sh` was exercised end to end on a clean
`ubuntu:24.04` host rather than only read for correctness. The full result is in
[infra/staging/README.md](../infra/staging/README.md); the part worth repeating
here is that the application's own migrations, seed and smoke test were then run
against the database the script produced — `applied 4, already present 0`, seven
sources seeded, and 10/10 smoke checks passed.

One defect was found and fixed that way: the script called `systemctl` directly,
so it aborted on any host where systemd is not PID 1. Service control now falls
back to `pg_ctlcluster` and then to `pg_ctl`.

## Reproducing

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm install
pnpm db:migrate
pnpm verify            # format, lint, types, every Vitest project, build

# Browser layers need a running stack
pnpm db:seed && pnpm dev
pnpm test:e2e
pnpm test:a11y
```
