# Recommended next features

Five recommendations, each grounded in something observed while building and testing this
system rather than in what a compliance product usually has.

---

## 1 · Regulation version tracking with impact analysis

**Evidence.** `source_versions` already stores every version with its checksum, page count
and effective date, and citations pin the version they were created against. The integration
suite proves an old citation still resolves after a source is reprocessed. What is missing
is the step that makes that structure useful: when a new edition of a regulation is
ingested, nothing tells the consultant which of their past findings were based on a clause
that has since changed.

**What to build.** On ingesting a new version of a source that already has one:

1. diff the extracted requirements clause by clause;
2. find every finding whose governing citation points at a changed clause;
3. raise a "Requires re-review" queue naming the affected reports and the specific change.

**Why it matters more than it looks.** The failure mode it prevents is a consultant citing
a superseded clause with complete confidence, because the citation still verifies — the
text really was on that page, in that edition. Verification proves faithfulness to a
document, not that the document is current. That gap is invisible today.

**Cost.** Medium. The requirement extractor, the version history and the citation-to-clause
link all exist; the work is the diff and the queue.

---

## 2 · Evidence review queue with reviewer sign-off

**Evidence.** The Reviewer role exists with `review:approve`, and `compliance_reviews`
already stores findings with confidence scores. But nothing in the product asks a human to
approve anything: `review:approve` is a permission with no workflow behind it. The
correction path is review-first; the _finding_ path is not.

**What to build.** A queue of findings below a confidence threshold, or marked
`needs_evidence`, routed to a Reviewer who can confirm, override with a reason, or request
more evidence. The override and its justification join the audit trail and the report.

**Why.** Consultancies sign their names to these reports. A verdict produced by software
and never seen by a qualified person before it reaches a client is a professional-liability
problem, not just a product gap. It also produces the labelled data that would make every
other quality improvement measurable.

**Cost.** Medium. Schema exists; this is UI, routing and a state machine.

---

## 3 · Cross-document conflict detection across the knowledge base

**Evidence.** `detectConflict` in `packages/rag/src/citations.ts` already finds
contradictions between two passages, and the subject-overlap gate added during development
keeps it from firing on unrelated quantities (a 1.5 m exit width against a 38 m travel
distance is not a conflict). Today it runs only within one answer's evidence set.

**What to build.** A scheduled pass over the knowledge base that compares requirements
across sources, surfacing where a local code, a client standard and an international
standard disagree — with both citations and a recommendation on precedence.

**Why.** In practice the hard part of a compliance review is not finding the rule; it is
knowing which of three conflicting rules governs. The engine can already detect the
disagreement; it simply has never been pointed at the corpus as a whole.

**Cost.** Low to medium. The comparison exists. The work is scheduling, storage for the
findings, and a precedence model.

---

## 4 · Bilingual evidence with clause-aligned Japanese

**Evidence.** The i18n structure is complete and Japanese has a message catalogue. The
document worker installs `tesseract-ocr-jpn` and Noto CJK. But every evidence path assumes
one language per source: a citation quotes the text as extracted, and a Japanese regulation
cited in an English report shows Japanese in the excerpt column.

**What to build.** Per-source language detection, and clause-level alignment between a
regulation and its official translation, so a citation can display the excerpt in the
reader's language while still verifying against the authoritative original.

**Why.** UXE's market is bilingual by nature — a Japanese consultancy advising on UAE codes,
or the reverse. Verification must always run against the authoritative text, so this cannot
be solved by translating the excerpt at display time: the aligned pair has to be stored.

**Cost.** High. Alignment is genuinely difficult, and it must not weaken verification. Worth
scoping against real customer demand first.

---

## 5 · Retrieval quality telemetry with a feedback loop

**Evidence.** `uxe_retrieval_duration_ms`, `uxe_citation_verification_rate` and
`uxe_evidence_coverage` are already recorded, and message feedback (thumbs up/down) is
already stored. Nothing joins them: there is no way to ask "which questions are we
answering badly, and what did retrieval return for them?"

**What to build.** Persist the retrieval trace per answer — expanded query, candidates per
channel, fusion scores, rerank signals — joined to the feedback and to whether the answer
abstained. Then a small operator view showing the worst-performing question clusters, and
an offline harness that replays them against a configuration change.

**Why.** Every retrieval threshold in `docs/rag-evaluation.md` is measured against a
five-case gold set built by hand. That is enough to catch a regression, not enough to guide
an improvement. Real questions from real workspaces are the only source of truth about what
retrieval is getting wrong, and today they are discarded.

**Cost.** Low. The metrics and the feedback exist; this is storage, a join and a view. It is
the highest ratio of insight to effort on this list, which is why it is worth doing before
the more ambitious items above.
