# Data retention and deletion

What the product stores, for how long, and what "delete" actually means. Written so a
customer's compliance officer can read it without needing the code.

## What is stored

| Category           | Examples                                         | Where                         |
| ------------------ | ------------------------------------------------ | ----------------------------- |
| Original documents | The exact bytes uploaded                         | R2 `uxe-originals`, immutable |
| Derived text       | Page text, sections, chunks, embeddings          | PostgreSQL                    |
| Evidence           | Citations with locators, offsets and coordinates | PostgreSQL                    |
| Consultations      | Questions, answers, findings, attachments        | PostgreSQL                    |
| Artifacts          | Reports, evidence matrices, corrected editions   | R2 `uxe-artifacts`            |
| Operations         | Jobs, attempts, audit events, sessions           | PostgreSQL                    |
| Identity           | Users, memberships, groups, invitations          | PostgreSQL                    |

Originals are never modified. A corrected edition is a new artifact; the source it came
from is untouched and remains downloadable at its original version.

## Default retention

Configurable per workspace under **Settings → Retention**.

| Data                                    | Default                        | Range                             |
| --------------------------------------- | ------------------------------ | --------------------------------- |
| Consultations and their answers         | 365 days                       | 1–3650                            |
| Artifacts (reports, corrected editions) | 365 days                       | 1–3650                            |
| Audit events                            | 730 days                       | 30–3650                           |
| Purge grace period                      | 30 days                        | 0–365                             |
| Sessions                                | Idle 60 min / absolute 30 days | Idle 5–1440 min, absolute 1–720 h |
| Invitations                             | 7 days                         | Fixed                             |
| Password reset and verification tokens  | 60 minutes                     | Fixed                             |
| MFA challenges                          | 10 minutes                     | Fixed                             |

Audit retention is separately floored at 30 days: an audit trail short enough to lose an
incident is not an audit trail.

## What deletion does

Three distinct operations, deliberately not conflated:

### Archive

Removes a source from retrieval immediately. Existing citations keep resolving, so a report
issued last month can still be audited. Reversible.

### Delete

Marks the source deleted and removes it from every list and every retrieval query at once.
Citations that already exist stay resolvable for authorised audit until the purge, which is
why the confirmation dialog says so rather than implying instant erasure.

### Purge

The irreversible one. After the grace period, a retention job:

1. deletes the original object from R2;
2. deletes chunks, embeddings, page text and sections;
3. redacts the excerpt on every affected citation, keeping the locator so the audit trail
   still records that a citation existed and to what;
4. deletes artifacts derived from the source;
5. writes an audit event recording exactly what was purged.

The audit event survives the purge. That is the point: the record of deletion is itself part
of the record.

## Legal hold

A workspace under legal hold suspends every purge. Nothing is destroyed while the hold is
in place, including data already past its retention window. Setting and clearing a hold are
both audited, and clearing one does not retroactively purge — the next scheduled run does.

## Deleting an account or a workspace

- **A member** is removed from the workspace; their authored consultations and audit events
  remain, attributed to them, because removing them would corrupt the record of who did
  what.
- **A workspace** deletion cascades to its sources, consultations and artifacts on the
  normal purge schedule.
- **An organization** deletion is an Owner-only action requiring the workspace name to be
  typed, and it is subject to the same grace period.

## Backups

Backups are a customer-infrastructure concern, but they interact with deletion:

- PostgreSQL point-in-time recovery retains up to 7 days by default. Data purged today may
  exist in a backup taken yesterday until that window rolls off.
- R2 buckets are configured without versioning for originals: an overwrite is impossible
  because keys are content-addressed per version, and a delete is a delete.

A customer requiring guaranteed erasure inside the backup window should shorten the PITR
retention; the trade-off is a narrower recovery window.

## Training

Customer data is never used to train or fine-tune any model. There is no code path that
sends document content anywhere except the model provider explicitly configured for
inference, and that provider is off by default.

If a customer opts into a data-sharing arrangement, it requires a separately signed
agreement and an explicit workspace setting; nothing in the product enables it implicitly.

## Exercising a data-subject request

1. **Access** — the activity export (`GET /audit-events/export`) covers actions; document
   downloads cover content.
2. **Rectification** — source metadata is editable; a corrected edition handles content.
3. **Erasure** — delete the source or the member, then run the purge or wait for the
   scheduled one. The audit event proves it happened.
4. **Portability** — reports export as PDF, DOCX, CSV and XLSX; evidence matrices as CSV.

## Where this is enforced

| Rule               | Enforced by                                                      |
| ------------------ | ---------------------------------------------------------------- |
| Retention windows  | `retention_policies` + the `retention_purge` job                 |
| Grace period       | The same job; a source is purged only after `deleted_at + grace` |
| Legal hold         | Checked at the start of every purge run                          |
| Audit immutability | A database trigger rejecting `UPDATE` and `DELETE`               |
| Session expiry     | Checked on every request, not only at sign-in                    |
