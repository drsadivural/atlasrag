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

## Public staging exposure

The browser suites were then run against a public HTTPS origin rather than only against
loopback, which surfaced two defects that a same-machine run cannot see.

**Vite rejected the proxied Host.** `vite preview` answers only to hostnames it
recognises — correct, since it stops DNS rebinding from reaching a local server — so
every request through the tunnel returned 403. Turning the check off would have been the
wrong fix; `apps/web/vite.config.ts` now takes a `WEB_ALLOWED_HOSTS` list, so the public
name is named explicitly.

**The E2E and accessibility suites contaminated each other.** Answer depth is persisted
per consultation. The accessibility suite's keyboard case pressed ArrowRight on the depth
control and left it on "Details + references", where inline citation chips do not render;
the functional case that clicks _Open exact page_ then failed on the next run against the
same database. It had passed against loopback only because that database was reset
between runs. Both suites now restore the depth they change, and the functional case sets
the depth it depends on instead of inheriting it. Verified by running accessibility and
then E2E back to back against the same live database: 37 passed, then 49 passed.

## Permanent staging at consultnow.ayonix.com

Moving from an ad-hoc tunnel to a permanent one under systemd surfaced three more defects.

**The document worker lost its shared token.** As a `nohup` process it inherited the
token from the shell; as a unit it had no environment, so it answered every extraction
with 503 and the API reported the worker as unavailable. Every upload and every corrected
edition failed. The unit now reads the same `.env` the API loads, so the two cannot
disagree about the token, and `.env` was tightened from 0664 to 0600.

**A success toast swallowed clicks meant for the button underneath it.** The toast
viewport is bottom-right on desktop, which is also where a dialog puts its primary
action; the toast card was `pointer-events-auto`, so a click on _Generate corrected
edition_ hit the toast instead. The card is now transparent to the pointer and only its
own dismiss and action controls take clicks. This is a real defect, not a test artefact —
a user clicking during the toast's lifetime lost the click too. Covered by a component
test.

**A clean stop was recorded as a failure.** The web server exits on SIGTERM without
translating it, so `systemctl stop` left the unit in `failed`. `SuccessExitStatus=143`
makes an intentional stop read as one.

The API's bind address also became configurable (`API_HOST`, still `0.0.0.0` by default
for containers) and staging narrows it to `127.0.0.1`, so the tunnel is the only way in.

Verified against the live hostname: E2E 49 passed, accessibility 37 passed, smoke 10/10.

## Sign-up without a confirmation email

Registration ended at "check your inbox" on a deployment whose mail driver is `console` —
the message is written to a log, never delivered — so every new account was stuck behind
an email that was never coming.

`requiresEmailVerification` now decides this, and unset it follows the mail driver: the
gate applies exactly when mail can actually be sent. `REQUIRE_EMAIL_VERIFICATION` overrides
it either way, and staging sets it to `false` explicitly.

What did **not** change is the property that registration cannot be used to discover who
has an account. Both branches still return the same status and the same body, and neither
mints a session — so a caller cannot tell a new address from a taken one. The page reads
the server's answer rather than assuming a mode, and sends the new owner to sign-in with
their address already filled in.

The password floor moved from 12 characters to 8, the minimum NIST 800-63B sets for a
chosen secret. It was enforced in two places that had drifted apart in message wording;
`MIN_PASSWORD_LENGTH` in `@uxe/contracts` is now the single source, used by the Zod
schema, the server-side strength check and the hint under the field. Everything else in
the policy is unchanged: character classes, breach lists, personal information, repeated
runs and sequences all still apply at any length.

Both modes are covered in the integration suite — the default path signs in immediately,
and a second harness configured with `REQUIRE_EMAIL_VERIFICATION=true` proves the gate
still sends its email and still blocks sign-in until the link is used.

## Sign-up driven through a browser

The registration and sign-in flow is now covered end to end in the browser against the
live hostname, not only at the API: follow the link from sign-in, fill the form, land on
"Account created", sign in with the address carried across, and arrive in a workspace
named after the organization just given. A second case proves a short password is refused
at the field rather than silently.

Both are desktop-only. Registration is rate limited to five attempts an hour per IP, and
creating three accounts per suite run would spend that allowance on the suite itself.

Writing them found a locator trap worth recording: a required field renders its label with
a trailing asterisk, so `getByLabel('Password', { exact: true })` matches on the sign-in
page and silently fails on the sign-up page, where the field is required. The tests match
on a prefix instead.

## The knowledge base 400

Reported as "Something went wrong / One or more query parameters are invalid" when adding
a document, with a trace id. The log named the path and the status but not the parameter,
so the first fix was to make the next one diagnosable: rejections now name the offending
fields, in the message the caller sees and in the log line.

The cause was general rather than specific to that page. `validateQuery` passed the query
string to Zod as-is, and an empty parameter — `?sort=&ownerId=`, which is what a form or a
hand-edited URL produces — reads as _present but invalid_ rather than as absent, so an
optional field rejected its own absence. Every endpoint with an optional query parameter
had the same hole; the fix is one line in the middleware and covers all of them.

The page was hardened too: `Number(searchParams.get('page'))` turns any junk in a URL into
`0` or `NaN` and sends it, which is how a bad link becomes a 400 with nothing on screen
but a banner. It now falls back to the default unless the value is a positive integer.

## Connectors

Google Drive, OneDrive and SharePoint can be attached from Settings, and their files land
in the knowledge base as ordinary sources. Full detail in
[docs/connectors.md](connectors.md); what matters here is what is and is not proven.

**Verified**: the provider catalogue and its availability reporting, the refusal to start a
flow this deployment cannot finish (naming the exact variables), permission enforcement,
callback rejection for a state that was never issued, and the entire sync — imported,
skipped-with-reasons, deduplicated by content hash, error recorded on the connector, and
status and timestamp afterwards. The sync runs against a stubbed provider on a harness
configured with an OAuth application; the client request construction and response parsing
are covered separately against stubbed fetch responses.

**Not verified**: the live handshake with Google or Microsoft. This deployment has no
registered OAuth application, so no request has ever reached either provider. That is the
one part of the feature standing on documentation rather than on a passing test.

One defect removed on the way: the knowledge base already had Drive, OneDrive and
SharePoint buttons that posted a hardcoded `accountEmail: 'me@example.com'` to an endpoint
that could only ever refuse them. They now sync when connected, start the consent flow
when the deployment can, and explain themselves with a link to the right screen when it
cannot.

## The Government Edition sign-in screen

`/login` is now the government screen from the approved references. Full detail in
[docs/government-login.md](government-login.md); what belongs here is what was found while
building it and what remains unproven.

**Defects found and fixed while testing it**

- Gold at `#9a7b3f` reaches only 3.75:1 as text on ivory. It is fine as a stroke, where
  3:1 is the bar, so the two uses were separated: `--gov-gold` for borders and lines,
  `--gov-gold-text` for words.
- The same gold lifted for the dark theme then sat on the authentication card at 1.81:1 —
  because the card is white in _both_ themes, as the references show. Gold on the card now
  has its own token that does not flip.
- The radio inputs in the accessibility panel were `sr-only`, which makes them invisible to
  a pointer as well as to the eye and left the choices unclickable for anything driving the
  page. They are transparent and stretched over their labels instead.
- The section wrapping the card was labelled by a screen-reader-only heading that repeated
  the card's own `h1`, giving the page two elements with the same name. It is labelled by
  the visible heading now.
- The hero photograph was covering a portrait column, which magnified the consultant to
  roughly twice the scale the references show. It is contained and bottom-anchored, and the
  blend sits on the photograph's own top edge rather than at a percentage of the hero, so
  it stays put at any column width.

**Deliberate departures from the previous sign-in screen**

- There is no registration link. Access is provisioned by an entity administrator, and the
  federated callbacks refuse an identity that is not already provisioned. `/register` still
  exists as a route and its tests still run; it is simply no longer reachable from
  sign-in.
- The hero photograph follows the theme rather than the clock. The references pair a night
  desert with the dark theme and a day desert with the light one, and the theme still
  defaults to the operating system's preference.

**A sixth defect, found by measuring rather than by a test.** The hero heading and promise
were sized with `clamp()` carrying a `vw` term. A viewport unit does not grow with the root
font size, so at Extra large the fluid value became the binding constraint and the promise
moved 10% where every other element moved 25% — the accessibility preference was being
capped by the layout. Both are a rem ladder now, stepped at breakpoints, and every element
scales the full +12.5% and +25%. The measured scale is in
[docs/government-login.md](government-login.md).

The same pass tightened the tablet range: 1024px now gives the authentication panel 56% of
the width, as the brief asks, and the decorative strokes are dropped below 1280px where
they had nowhere to run without crossing the restricted badge.

**Not verified: the live handshake with UAE PASS or an Entra directory.** This deployment
has no registered application for either, so no request has reached them. The fail-closed
path is verified: an unconfigured provider disables its button, names the variables, and
refuses to start a flow it cannot finish.

## A 136MB upload that never reached the application

Reported as an upload that stalls. It was not the application: measured through the live
hostname, a request body of 90MB reaches the API and one of 110MB comes back **413 from
Cloudflare**, with `server: cloudflare` and no header of ours on it. Cloudflare caps a
request body at 100MB on most plans and rejects it at the edge, so a 136MB document never
arrived at all. Confirmed from the other side too: the same 90MB and 110MB bodies both
succeed against the origin directly.

One misleading result on the way. A large body sent to an endpoint that answers 401
produces `write EPIPE` in the web server's proxy and a 502, because the API replies
without draining the request. That is the correct behaviour of both, and not the fault
being chased — a genuine authenticated upload of 90MB through the same proxy returns 202.

**The fix is multi-part upload.** A file larger than 48MB is now cut into parts client
side, each part sent in its own request, and the server assembles them before anything
downstream sees a file. Nothing after the assembly knows a document arrived in pieces:
the hash, the duplicate check, the version and the ingest job are the ones that already
existed.

Verified end to end against the live hostname with a genuine 136MB PDF: three parts of
48MB, 202 on each, assembled, ingested and `ready`. The parts are scratch and are deleted
as soon as the file exists, including on the failure paths.

## A 1348-page fire code quarantined by a wrapped line

The upload completed and the document then went nowhere. The job had **succeeded**; the
document was `quarantined`. Reading the stages showed why: malware scan clean, extraction
complete at 1348 pages, and structure analysis failed with the single word "Quarantined".

The recorded reason was a `role_confusion` hit on this excerpt:

> …the fire strategy and overall intent of the proposed glazing
> **system:** a. The minimum fire rating specified relates to a full syste…

The rule was `/^\s*(system|assistant|developer)\s*[:>]\s*/im`. With the multiline flag,
`^` matches the head of _any_ line, so a regulation that happens to wrap before the word
"system" and continue with a list colon reads as somebody impersonating the system role.
On a long technical document that is not an edge case; it is inevitable.

The rule now requires the label to begin the text, follow a blank line, or follow a line
that ended a sentence — which is how an injected role header actually appears, and is not
how a wrapped noun does. Every injection shape in the suite still matches, and the fire
code no longer does. The reprocessed document is `ready`.

**Two supporting defects fixed in the same pass.** The stage recorded the verdict rather
than the reason, so the pipeline said "Quarantined" and nothing about what to do next; it
now carries the explanation. And the pipeline card was a set of counters — a stage could
say it was blocked without naming the document that blocked it. Each stage now opens, and
shows the documents still in it with whatever the stage recorded against each: a page
count, an OCR confidence, or the reason it stopped. A job outlives the document it ran on,
so one whose source has been deleted is left out rather than named.

## Ready in the table, failed in the pipeline

Both readings were true, and that was the problem. The pipeline counted every ingest job
in the workspace, so a document that failed and was then reprocessed successfully appeared
twice: once as the failure it used to be, once as the success it now is. The table showed
the document, the pipeline showed the history.

Two rules now define what the card counts.

**The newest attempt per document wins.** A reprocess supersedes the attempt it replaced,
which is what a reprocess is for. Nothing else makes "Ready" and "failed at structure
analysis" impossible to hold at the same time.

**The card is the current batch, not a lifetime total.** Everything still working, plus
everything started within ten minutes of the newest job. Uploading a file starts a new
batch rather than adding one more row to a tally nobody can find their document in — which
is what makes the card useful for the thing people actually use it for, watching an upload
go through.

Verified on the live deployment: the workspace holding the reprocessed fire code went from
`structure_analysis blocked 1/2` to every stage `complete 1/1`, and a fresh upload then
reset the card to that upload alone.

## A byte counter that never moved

The upload bar advanced; the number beside it read "136 MB" from the first frame to the
last. It was the file's own size — printed once, correct, and completely useless, because
the one thing somebody watching a large upload wants to know is how much of it has gone.

While bytes are moving the row now says how many: `71 MB of 120 MB · 59%`. When they stop,
it goes back to the file's size, because there is nothing left to count.

The figure comes from the transfer rather than from the percentage. A percentage rounded
to a whole number moves in 1.4MB steps on a 136MB file, which looks like a counter
sticking; and for a file sent in parts the count has to run across the whole file rather
than restart at each part — the person watching is waiting for a document and has no idea
it was cut into three.

Verified on the live deployment with a 120MB upload, sampled as it ran:

```
1.1 MB of 120 MB · 1%      48 MB of 120 MB · 40%      96 MB of 120 MB · 80%
15 MB of 120 MB · 12%      53 MB of 120 MB · 44%     108 MB of 120 MB · 90%
33 MB of 120 MB · 27%      71 MB of 120 MB · 59%     120 MB of 120 MB · 100%
```

The readings either side of 48MB are the part boundary: it crosses without resetting.

## An answer that never appeared

Reported as a consultation stopping at "Ayumi is reviewing your sources…". The backend
turned out to be blameless in every variant tried: no sources in scope, sources in scope,
check-compliance mode, and the 1348-page code as the governing document all answered in
about a second, and every `consultation_answer` job on the deployment had succeeded.

Two findings, one of them uncomfortable.

**The screen could only be updated by a socket.** The consultation view drove itself
entirely from the SSE stream, and the stream module's own comment says it is "a live view
over durable state, never the only delivery path" — but in practice it was. If the stream
missed the window, nothing else refetched, and the spinner stayed over an answer that had
already been written. The detail query now polls every two seconds while any message is
outstanding and stops the moment nothing is, so the stream is the fast path rather than
the only one. Proved by blocking the stream outright: the answer still arrives in 3.8s.

**The stall itself was not reproduced.** After a dozen attempts across every task mode,
document size and connection state, the screen never hung. The fix above closes a real
gap and is verified against a blocked stream; it is not confirmed to be the gap that was
hit. That distinction belongs in the record rather than in a claim.

What was reproduced, and is worth its own fix: a consultation with **no sources selected**
can only ever answer "unable to determine — none are currently selected". Correct, and a
poor way to learn it after waiting. The composer now says so before the question is sent,
with a way to fix it.

## The consultant, the logo, and asking a provider what it serves

**A composite rather than a sticker.** The two supplied portraits were cut from their
backgrounds by flooding in from the borders rather than by a brightness threshold — the
white headdress is as bright as the backdrop, and a threshold punches holes in it. Each
figure is then graded towards its scene's own key light (warm and lifted at midday, dim
cool and desaturated at night) and given a contact shadow, because a cut-out dropped
straight onto a photograph keeps the light of wherever it was shot and reads as a sticker.

**The mark is two files, not one recoloured by CSS.** The navy letterforms vanish on the
dark header, and the orange chevron must not be lifted with them — it is the accent and
the only part that stays exactly as drawn in both themes.

**Model identifiers are asked for, not guessed.** Settings → Models now has _Load available
models_, which asks the provider which models the workspace's own key will actually serve
and turns the free-text field into a list. It fails closed like every other provider here:
no key, no list, and a message naming the variable.

That answered a question this codebase had no business answering from memory. The models
named in the request — `gpt-5.6-terra`, `gpt-5.6-sol` — are real and on the account; the
identifier already saved in this workspace, plain `gpt-5.6`, is not among the 88 the key
serves, which is why its health reads "Not configured".

## The page that deleted itself when a refresh failed

The suite caught this against the live host, not in a unit test: the desktop run of
_generates a corrected edition_ could not find the button, and the keyboard run could not
put the answer style back. Both had the same cause, visible in the failure snapshot —
`Too many requests. Please slow down.` where the consultation had been.

Two defects, one behind the other.

**The refresh was allowed to destroy the page.** Every polling view rendered
`query.error ? <ErrorState/> : <content/>`. React Query keeps the last good response when a
_refetch_ fails, so a single 429 on a background poll replaced a finished answer, its
citations and the correction controls with a full-page failure. Nothing had gone wrong with
the content; only the refresh failed. The error state now appears when there is nothing to
show, and a stalled refresh says so in a strip above content that stays put.

**Deciding when to say so is not a count of failures.** `failureCount` looks like the
signal and is not: React Query resets it at the start of every fetch, so with retries off
for 4xx — right, since a permission error will not fix itself — it never climbs above one
however long the outage runs. Measured instead is what the reader actually cares about,
how far behind the numbers in front of them have fallen: the gap between the last success
and the last failure. Four seconds, which at a two-second poll is the second consecutive
miss.

**And 300 requests a minute was too tight.** The budget is per signed-in user, so a
ministry behind one address is not one bucket — that part was right. The number was not.
Four views poll every two to two and a half seconds while work is outstanding, roughly 110
requests a minute before anyone touches anything, and a page navigation costs another
dozen. One tab sat close enough to the ceiling that a second one crossed it, and what a
user got for reading their own documents in two windows was an error. 600 carries three
busy tabs and still refuses anything trying to enumerate a corpus.

## Changing your mind faster than the network

The keyboard suite could not put the answer style back where it found it — but only when
the whole suite ran, never on its own. Holding the _reads_ open for two seconds while
leaving the writes alone made it happen every time, and showed two faults sharing one
cause: every control in the evidence panel saved by asking the server to re-read the
consultation afterwards.

A second change inside one round trip then lost twice. The patch carried a version the
re-read had not yet refreshed, so the server — correctly — refused it as somebody else's
edit. And React Query folded the second re-read into the first, which had been issued
before the second change existed, so the panel snapped back to the earlier choice and
stayed there. Both endings read the same to the user: _Could not save_, for changing their
mind too quickly.

Writes are chained now and seeded from what the write itself returns — the response is the
whole consultation — so there is no second read left to lose a race with. Optimistic
concurrency is for two editors, not for one person pressing a button twice.

The test that covers it fails on the old code in all three viewports and passes on the new,
which is the only version of that sentence worth writing down.

## Light, medium, high, extra high

The models named in the request were half right in a way worth writing down. `gpt-5.6-sol`
and `gpt-5.6-terra` are real and on the account. "5.6 sol light", "5.6 sol medium", "5.6 sol
high" and "5.6 sol extra high" are not models at all — the catalogue offers one `sol` — and
guessing which they were would have been exactly the sort of invention this codebase is not
allowed to make.

So it asked. A request carrying a deliberately invalid level came back naming the real
ones: `none`, `low`, `medium`, `high`, `xhigh`. They are a parameter, not a product line,
and this application was not sending it — the request would have gone out at whatever depth
the provider defaults to, which is not the depth somebody who asked for extra high thinks
they are getting.

The setting now exists end to end, and three things about its shape are deliberate:

**Unset is not `none`.** A model without a reasoning mode rejects the parameter outright,
so an unconfigured effort has to mean _send nothing_, not _send none_.

**A rejected `temperature` is dropped and retried; a rejected effort is not.** Temperature
carries nobody's instruction — this code sends zero so a grounded answer does not wander,
and a reasoning model that refuses it is already deterministic enough. The effort is
somebody's setting, and answering at a depth they did not choose while reporting success is
the failure mode this whole application exists to avoid.

**A saved key follows the account, not the model name.** Configurations are keyed by model,
so choosing a different one from the loaded list makes a new row; asking for the same key
again is how a working provider gets replaced by an unconfigured one.

What could not be checked from here: whether the app's existing request shape works against
these models beyond the parameter question — the reasoning models may also refuse
`response_format`, and that is not something to find out by guessing either.

## The document nobody read

Reported as: upload a document, ask whether it satisfies the regulations, get a clause of
the code back with nothing said about the file. The cause was a single missing line, and
finding it turned up four more faults stacked behind it.

**The upload was never attached.** `POST /consultations/:id/uploads` created the source and
the ticket and enqueued the indexing, and never joined the finished document to the
conversation. `addSource` existed, took a role, and had no callers anywhere in the
codebase. So the file indexed perfectly and sat outside the conversation's scope, and the
only thing in scope to answer from was the code. It is attached now when indexing
completes — not at upload time, because the version has to be promoted first and the
pinned version is what makes the answer reproducible.

**Already indexed is not already attached.** The same bytes arriving a second time hit
duplicate detection, which discarded the new source and returned "already in your knowledge
base". For a conversation that means the upload appears to succeed and reviews nothing. The
existing copy is attached instead.

**A thousand-page code drowns a three-page submittal.** Both corpora were retrieved and
ranked together, and a code has hundreds of passages on any topic where a submittal has
one. Each role now gets its own retrieval and a guaranteed share — a third to the project
side, which is the smaller corpus while the obligation still has to be quoted in full.

**"All reviewed requirements are met", having reviewed none.** Asking a compliance question
inside a conversation runs the answering path, not the full review, so it reached assembly
with no findings — and the compliance branch ended at that sentence whenever nothing had
failed. Zero of zero is not a pass. With nothing tested it now falls through to describing
the evidence, and the reason names both documents rather than going silent.

**The headline was a quotation.** Asked for a headline the model returns the most relevant
sentence it was given, so somebody who asked whether their submittal complies read a clause
of the fire code, mid-sentence. A headline already sitting inside a verified excerpt is a
quotation rather than a conclusion and is refused; a decided question is headed by the
question, which invents nothing and sits under the verdict where an answer belongs.

Separately: choosing the Yes / No style now always produces a verdict. Reading the
question's grammar is the right guess when nobody has said what they want, but a screen
showing no verdict at all to somebody who asked for exactly one has ignored the only
instruction it was given.

## Words the page broke in half

Visible in the quotation above before it was fixed: _the capaci- ty of the pump sets_. A
hyphen a typesetter put at a line end comes out of a PDF as a real character, and
collapsing the newline after it leaves that — in the stored page text, in every chunk built
from it, and so in the sentence printed under an answer as what the regulation says. It
does not say that.

The join is narrow: a letter, a hyphen, whitespace, a lower-case letter. `fire-rated` has
no whitespace and is left alone; a dash with a space before it does not match; a capital
after the break says the break was not one.

Worth recording is what the fix broke. Excerpt verification builds its own normalised copy
of the page, character by character, to keep an index map back to the original — so
rejoining only the needle meant a genuine quotation could no longer be found in the
haystack. Every citation quoting a wrapped word went unverified, coverage collapsed, and a
working consultation started answering "the selected sources do not answer this question".
The live probe caught it one request later. Both sides join now, and there is a test that
fails if they ever disagree again.

## An invitation nobody received

The invitation worked. The email did not exist.

`EMAIL_DRIVER=console` writes every message to a log and delivers nothing, which is right
for development and was what this deployment was running. The invite endpoint called
`send`, got no error — the console driver cannot fail — and the screen said _Invitation
sent_. So an administrator invited somebody, was told it had gone, and waited.

Two things were wrong and they are different problems.

**Nothing could send.** `smtp` had been in the driver enum from the beginning with no
implementation behind it, so selecting it fell through to the console driver silently:
configuration that said mail was being sent, and mail going into a log file. `.env.example`
documented an `SMTP_URL` that no schema had ever read. There is a real driver now, and
STARTTLS is required rather than preferred — the alternative is a password on the wire
against any server that does not advertise it.

**Saying it was sent was the worse half.** An invitation is a membership and a message. The
membership always succeeds; the message needs a transport this deployment may not have.
Reporting the first as though it were both is the fake success state the brief rules out,
and it costs a week of somebody's time before anyone thinks to check. The response now says
which of the two happened, and when nothing was sent it returns the accept link so an
administrator can pass it on — a working invitation today, with no credentials at all,
rather than an apology.

## A route to an account, or a sentence saying there is none

The Government Edition was specified with no public registration: access is provisioned by
an entity administrator, and the card said so. Adding a registration link while keeping
that sentence would have contradicted itself on one screen, so it is one or the other,
chosen by `ALLOW_PUBLIC_REGISTRATION` and answered by the config endpoint the screen
already asks. The screen never offers a route the API would refuse, or withholds one it
would allow.

## Locked out of the workspace you just joined

Reported as: the invitation link says _Something went wrong — complete two-factor
authentication to continue._

The accept endpoint minted its session with `mfaSatisfied: false`. The account is created
by that same request, has no authenticator enrolled, and there is no challenge it could
answer — so `requireAuth` refused everything after the accept, with no way forward and no
way back. A second factor is satisfied when there is none to satisfy; somebody who does
hold one keeps the gate, because an invitation link is not a way around their own
authenticator.

## Signed up, and could not sign in

Reported as: after signing up, the password is not accepted. Reproduced in one line —
invite an address, then register with it, and the API answers `"status":"registered"` for
an account it did not create. The invitation had already made the user row, with no
password on it.

The response is right and has to stay: a different answer for an address that exists tells
any stranger which addresses are registered. Setting the password here instead would fix
the symptom and hand anybody who guesses an invited address the account it was meant for —
the invitation goes to a mailbox precisely so that holding the mailbox is the test.

So the caller still learns nothing and the mailbox learns everything. What went there was
a _verification_ email, which reads as "your new account is ready" and is the opposite of
what happened; it is now a notice that says this address already has an account, here is
how to sign in, and — when one is still pending — open the invitation instead.

## Removing somebody

`member:remove` had been in the permission catalogue and in the Owner and Admin grants from
the beginning, with no endpoint and no control: a translated label for an action that did
not exist. It exists now, soft, because the audit trail names actors by id and hard-deleting
the row would leave every entry they ever produced pointing at nothing. Sessions are revoked
in the same breath — the point of removing access is that it stops now, not at the next
token expiry — and group memberships go too, scoped through the workspace's own groups so
that removing somebody here does not strip them from groups in another workspace.

Three guards, the same as suspension: not yourself, not somebody at or above your level,
never the last active Owner.

## An authority that crosses workspaces, and stops there

Platform administration is the first permission in this system that is not granted by a
membership. Every other one is bounded by the workspace that granted it; this one exists so
somebody can administer accounts across the deployment — see who exists, suspend them, get
them back in, add them.

The whole design is in what it does not carry. It reaches identities and nothing else:
there is no route through it to a source, a consultation, an answer or an artifact, and the
tenant checks every retrieval makes are untouched by the flag. Being able to administer the
accounts is not permission to read what those accounts hold, and granting both with one
boolean would have made it so. The test that matters most in that file asserts a platform
administrator listing sources still sees only their own workspace's.

Three smaller decisions worth keeping:

**A reset is a link, never a password.** The endpoint does not accept one. An administrator
who could set a password could sign in as that person; one who sends a link can only help
them back in, and the difference is the entire point of the feature.

**Add user leads with the link too.** Leaving the password blank sends one and nobody else
ever knows it. Typing one is offered because sometimes it is what a situation needs, and
the field says plainly that the administrator will know it.

**Two lists, not one with a switch of meaning.** "Who is in this workspace" has a single
role and status that mean something. Across a deployment somebody can be an Owner in one
workspace and read-only in another, so the platform row is about the person and the
memberships are a list.

## A consultation that could not answer anything

Opening one attached no sources, so the first thing anybody saw was "No sources are
selected" and an instruction to go and choose some — from a knowledge base they had already
approved, every document of which they would have picked. Saying nothing about sources now
means the approved ones, which is what the same screen says two lines above.

Only when the field is absent. An explicit empty list is somebody saying none and stays
none, which is the only way left to open a consultation with no scope at all. The list is
read through the repository, so it is filtered by what that caller may actually see rather
than by what the workspace holds.

## Confidence that moved on its own

Found by the suite while the above was being verified: `computeConfidence` failed its own
"deterministic for identical inputs" test, by roughly 1e-13. It read `new Date()` and fed
it into a recency term, so the same answer scored fractionally differently on every
recomputation.

Recency is measured in years and has no business knowing what minute it is. The instant is
truncated to the day now — for a supplied timestamp as well as for the default, because a
caller that passes one is entitled to the same guarantee. A number printed beside a
citation should not depend on when somebody looked at it.

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
