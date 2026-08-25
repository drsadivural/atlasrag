# Testing

What each layer proves, how to run it, and what has to be true before the work is
considered done.

## The layers

| Project       | Command                 | Environment                            | Proves                                                                                                                                       |
| ------------- | ----------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit`        | `pnpm test:unit`        | node                                   | Business rules in isolation: permissions, evidence coverage, confidence, compliance arithmetic, correction selection, redaction, SSRF guards |
| `component`   | `pnpm test:component`   | jsdom                                  | Every UI state a user can reach, driven by real user events                                                                                  |
| `integration` | `pnpm test:integration` | real PostgreSQL + real document worker | The API as deployed: HTTP in, database and files out                                                                                         |
| `rag-evals`   | `pnpm test:rag-evals`   | same                                   | Retrieval quality and grounding thresholds                                                                                                   |
| `security`    | `pnpm test:security`    | same                                   | Cross-tenant isolation and the attack surface                                                                                                |
| `e2e`         | `pnpm test:e2e`         | Playwright, real stack                 | The product through a browser at three viewports                                                                                             |
| `a11y`        | `pnpm test:a11y`        | Playwright + axe                       | WCAG 2.2 AA, and keyboard-only operation                                                                                                     |

## Prerequisites for the database-backed layers

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
```

`TEST_DATABASE_URL` must differ from `DATABASE_URL`. The bootstrap refuses to run
otherwise, because the suite truncates every table between cases.

## What is real and what is substituted

Real: PostgreSQL with pgvector, all migrations, every repository, the whole HTTP stack, the
job runner, the Python document worker, PDF and DOCX generation, OCR.

Substituted: object storage uses a temporary filesystem bucket implementing the same
`StorageDriver` interface as R2; email uses the console driver, whose outbox the tests read
to extract verification and invitation tokens exactly as a user would read the message.

Nothing in the answering path is faked. A test asserting that a citation is verified is
asserting against text that was genuinely extracted from a genuine PDF.

## The fixtures

`tests/fixtures/documents/` holds one file per hazard the product must survive:

| File                                           | Exercises                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `regulation-native.pdf`                        | Text-based PDF with numbered clauses; the governing document             |
| `project-plan.pdf`                             | The project document, containing both compliant and non-compliant values |
| `scanned.pdf`                                  | OCR path, and the confidence recorded for it                             |
| `policy.docx`, `vendors.xlsx`, `playbook.pptx` | Office formats and their locators                                        |
| `corrupt.pdf`                                  | A file the parser genuinely cannot open                                  |
| `encrypted.pdf`                                | Password protection                                                      |
| `fake.pdf`                                     | A ZIP claiming to be a PDF: content sniffing, not extension trust        |
| `eicar.txt`                                    | Signature scanning                                                       |
| `zipbomb.zip`                                  | Archive expansion limits                                                 |
| `injection.pdf`                                | A document that tries to issue instructions                              |

Every one is asserted to be _handled_ — with an actionable message — rather than merely not
crashing.

## Thresholds that fail the build

| Metric                                              | Threshold                                                |
| --------------------------------------------------- | -------------------------------------------------------- |
| Quoted-text verification rate                       | 100%                                                     |
| Locator accuracy                                    | 100%                                                     |
| Cross-tenant leakage                                | 0                                                        |
| Requirement coverage                                | 100% assessed or explicitly recorded as needing evidence |
| Recall@5                                            | ≥ 80%                                                    |
| nDCG@5                                              | ≥ 0.70                                                   |
| Retrieval latency p50 / p95                         | < 1.5 s / < 4 s                                          |
| Coverage: lines / functions / branches / statements | 55 / 55 / 70 / 55                                        |

The coverage floor is set where the suite genuinely sits rather than at an aspirational
number, so it functions as a ratchet instead of a warning everyone learns to ignore.

## Visual regression

Screenshots are taken at exactly the three viewports the brief names — 1440×900, 1024×768
and 390×844 — with a 2% maximum diff ratio. Update them deliberately:

```bash
pnpm test:e2e --update-snapshots
```

A visual diff that nobody explains is a defect, not a snapshot to bless.

## Signing in

Both browser suites authenticate **once**, in a `setup` project that saves the session, and
every other test reuses it. Sign-in is rate limited per IP — deliberately, and the security
suite asserts it — so a suite that re-authenticated 49 times would trip a control the
product is supposed to have and report a failure that is really a success.

The specs that are _about_ signing in, and the read-only permission test, start from an
empty context instead:

```ts
test.use({ storageState: { cookies: [], origins: [] } });
```

## Writing a new test

Follow what is already there:

- Name the behaviour, not the function. `refuses a password-protected PDF and says so`
  survives a rename; `test extractPdf error` does not.
- Assert on what a user or an operator would notice. A test that only checks an internal
  call happened will pass while the product is broken.
- Prefer the real thing. If a test needs a stub to pass, ask what that says about the code.

## The gate

```bash
pnpm verify
```

Runs format check, lint, typecheck, every Vitest project, and the production build.
Browser layers are separate because they need a running stack:

```bash
pnpm test:e2e
pnpm test:a11y
```

The work is not complete unless all of it passes.
