# Product decisions

Decisions taken while building UXE Consulting AI that a reader would otherwise have to
reverse-engineer, and the reasoning behind them.

## The default answering engine is extractive, not generative

**Decision.** The engine that ships selects sentences from retrieved passages and composes
them under a fixed schema. Hosted models are optional and configured per workspace.

**Why.** The product's promise is that every claim is traceable to a quotation that exists.
An extractive engine cannot violate that promise, because it never writes a sentence that
was not already in a document or in the schema. It also needs no credentials, which means
the product works the moment it is installed rather than after a procurement cycle.

**Consequence.** Answers read as precise rather than fluent. For a compliance workspace,
that is the right trade — a consultant reading a verdict wants the clause, not prose.

**When to revisit.** If customers ask for narrative summaries, enable a hosted provider.
The verification gate is unchanged, so the guarantee holds either way.

## Partial compliance is NO

**Decision.** Any requirement that is not met, or that could not be tested, produces `NO`
with "Partially compliant" as a secondary label. There is no partial YES.

**Why.** A YES on a document with an untested requirement is the single most damaging
output this product could produce. Someone acts on it.

**Consequence.** The headline verdict is pessimistic. The evidence table beside it shows
exactly which requirements passed, so the pessimism is never opaque.

## Absence of evidence is never non-compliance

**Decision.** A requirement nothing addresses returns `needs_evidence`, never
`non_compliant`, and names what is missing.

**Why.** "Your document does not mention X" and "your document violates X" are different
statements with different consequences. Conflating them produces false accusations, which
destroys trust faster than a missed finding.

## Uploads are inputs until promoted

**Decision.** A document attached to a consultation is a consultation input. It becomes
part of the knowledge base only when somebody promotes it explicitly.

**Why.** A consultant reviewing a client's draft does not want that draft answering other
people's questions next week. Silent promotion would make the knowledge base accumulate
whatever anybody happened to attach.

## The original is never modified

**Decision.** A correction produces a new artifact. The source keeps its bytes, its
checksum and its version.

**Why.** The original is the evidence. Once it is mutated, every citation into it becomes
unverifiable, and the audit trail loses its anchor.

**Consequence.** Storage grows with every corrected edition. Retention policy handles it.

## A generated PDF never claims to preserve a signature

**Decision.** When a signed PDF is corrected, the original is retained unchanged and the
new edition is labelled an unsigned derivative — in the artifact metadata, in the UI and in
the report itself.

**Why.** A signature covers specific bytes. Any edit invalidates it. Claiming otherwise
would be a lie with legal consequences.

## Sessions end on a role change

**Decision.** Changing a member's role revokes their sessions.

**Why.** A session carries its permissions. Leaving one alive after a demotion means the
demotion did not take effect until they happened to sign out.

**Consequence.** A promoted user is signed out and must sign in again. Mildly surprising;
the alternative is a permission system that lies about when it applies.

## Not-found rather than forbidden across tenants

**Decision.** A request for another tenant's identifier returns 404, identical to a
request for an identifier that never existed.

**Why.** A 403 confirms the resource exists. That is an enumeration oracle.

## Registration answers identically for a known address

**Decision.** Registering an address that already has an account returns the same status and
the same body as a first-time registration; the account holder receives an email instead.

**Why.** Any difference — including a different status code — lets an attacker enumerate
customers.

## The document worker holds no credentials

**Decision.** The extraction service has no database handle, no object-store credential and
no outbound network access. Bytes arrive in the request and leave in the response.

**Why.** It is the component most likely to be compromised by a hostile file, because it is
the only one running native parsers on untrusted input. Giving it nothing to steal is
cheaper than making it unbreakable.

## Answer style is a view, not a query

**Decision.** Yes/No, Optimal and Details render from one `StructuredAnswer`. Changing style
never re-runs retrieval.

**Why.** If each depth re-queried, the three views could disagree — and a user who checked
the detailed view after reading the short one would have no way to know which was right.

## Confidence is computed, never self-reported

**Decision.** Confidence is a deterministic function of evidence coverage, retrieval
quality, citation verification, source authority, recency and contradiction, and its
derivation is shown on hover.

**Why.** A model asked how confident it is produces a number that correlates with fluency,
not correctness. A computed figure can be audited and reproduced.

## General knowledge is off by default

**Decision.** `knowledgeOnly` defaults to true. When fallback is enabled, every sentence not
drawn from the customer's sources is visibly labelled.

**Why.** The product is bought for grounding. A helpful sentence from general knowledge,
unlabelled, is indistinguishable from an invented one.

## Jobs are rows, not promises

**Decision.** Every long-running action is a database row with stages, attempts and a
result reference. The SSE stream reads from it rather than being the thing itself.

**Why.** A user who refreshes mid-generation must not lose their work, and an operator
diagnosing a stuck ingestion needs something to query.

## The audit trail is append-only in the database

**Decision.** A trigger rejects `UPDATE` and `DELETE` on `audit_events`.

**Why.** An audit trail an administrator can edit is not an audit trail. Enforcing it in the
application would leave the guarantee one migration script away from being untrue.
