# Verification log

What was actually run, and what it produced. Every figure here comes from a command
executed against the real stack — PostgreSQL 16 with pgvector, the real migrations, the
real Python document worker — not from inspection.

Where something could not be executed in the build environment, that is stated plainly
rather than glossed.

## Environment

| Component | Version |
| --- | --- |
| Node | 22.19.2 |
| pnpm | 11.16.0 |
| TypeScript | 5.9.3 |
| PostgreSQL | 16 with pgvector 0.8.6 (`pgvector/pgvector:pg16`) |
| Python | 3.12 with PyMuPDF 1.28.2, Tesseract 5.3.4 |
| Playwright | 1.62.1, Chromium |

## Static checks

| Check | Command | Result |
| --- | --- | --- |
| Format | `pnpm format:check` | Clean |
| Lint | `pnpm lint` | Clean — zero errors, zero warnings |
| Types | `pnpm -r typecheck` | Clean across all 10 projects |

Lint began at 235 problems and finished at zero. Fourteen of those were genuine defects
rather than style: a `<tr onClick>` unreachable by keyboard, a `tabIndex` on four
non-interactive tooltip anchors, a `<label>` bound to nothing, a heading that could render
empty, five `setState` calls in effects that rendered a stale value first, a mutation
during render, and a dead assignment.

## Defects found by running the system

The table below lists what the test suites found that inspection had not. Each was fixed
and is now covered.

| # | Defect | Found by | Consequence if shipped |
| --- | --- | --- | --- |
| 1 | MFA verification returned 500 on every attempt — the handler re-read a request body the validator had already consumed | Integration | **Two-factor sign-in was completely broken.** Anyone with MFA enabled could not sign in. |
| 2 | Recovery codes were rejected by validation (`/^\d{6}$/`) despite being offered on the sign-in screen | Integration | A user who lost their authenticator was permanently locked out. |
| 3 | Registering an existing address returned 200 while a new one returned 201 | Integration | A status-code oracle for enumerating customers. |
| 4 | A failed ingestion left the source at `pending` for ever | Integration | A document stuck in "Processing" with no reason and no retry — the dead end the brief forbids. |
| 5 | Worker failure detail was replaced with "The document worker rejected this file" | Integration | "This PDF is password protected" became a message the user could do nothing with. |
| 6 | `PATCH /sources/:id` required a `version` the API never exposed | Integration | Source editing was impossible for any client. |
| 7 | The invitation email linked to `/accept-invite`, which existed in neither the API nor the web app | Integration | **Invited members could never join.** The entire invitation flow was a dead end. |
| 8 | The upload endpoint ignored the size its own ticket declared | Security | The declared size — used for quota accounting — was unenforceable. |
| 9 | CSRF failures were indistinguishable from permission failures | Integration | A stale token showed "forbidden", so a client could not know to refresh and retry. |
| 10 | `utm_*` parameters were never stripped (the regex was anchored on the prefix alone) | Unit | The same page ingested repeatedly under tracking-parameter variants. |
| 11 | Storage keys kept `..` sequences from a client-supplied filename | Unit | Defence in depth weakened; a filename of `..` produced a traversal segment. |
| 12 | Log redaction missed every camelCase credential (`csrfToken`, `sessionToken`, `apiKey`) | Unit | Tokens written to logs in the naming convention this codebase actually uses. |
| 13 | Redaction hid bare `code` fields, including job error codes | Integration (observed in output) | The reason a job failed was `[redacted]` in the logs. |
| 14 | Citation excerpts were stored whitespace-normalised while offsets pointed at the raw text | Integration | The evidence viewer could not find its own quotation on the page. |
| 15 | An unverified citation was rendered in quieter chrome than a verified one | Component | The one citation needing attention was the least visually prominent. |
| 16 | A clickable table row had no keyboard path | Lint + component | Every list in the product was mouse-only. |
| 17 | `DataTable` accepted a `loading` prop and did nothing with it | Component | Headers over an empty body read as "no results" while the request was still running. |
| 18 | `Field` never bound its error to the control | Component | 34 form fields where a red border was the only signal, with no `aria-invalid`. |
| 19 | Two navigation landmarks shared one accessible name | Component | Ambiguous landmark navigation for screen-reader users. |
| 20 | The dropdown label overrode the trigger's own name | Component | The workspace switcher announced "Workspace" instead of the workspace. |
| 21 | Arrow keys moved focus but not selection in a `radiogroup` | Component | The answer-style switch violated the pattern its own role promises. |

## Test results

| Suite | Tests | Result |
| --- | --- | --- |
| Unit | 179 | Pass |
| Component | 96 | Pass |
| Integration — auth | 20 | Pass |
| Integration — knowledge | 17 | Pass |
| Integration — consultation | 11 | Pass |
| Integration — users and settings | 16 | Pass |

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

## What was not executed

| Item | Why | What was done instead |
| --- | --- | --- |
| Cloudflare deployment | No account was available in this environment | Wrangler configurations for both workers across staging and production, plus a CI dry-run job that validates them |
| Hosted model providers | No API credentials | The adapters are implemented against the same interface and pass the same verification gate; the deterministic engine is the default and is fully exercised |
| Google / Microsoft OAuth round trip | No client credentials | The PKCE flow, state handling and callback are implemented and unit-tested; the redirect itself is untested |
| Managed PostgreSQL and R2 | Local Docker and a filesystem bucket were used | Both implement the identical driver interfaces the production drivers do |

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
