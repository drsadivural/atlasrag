"""What a generated report is allowed to say it decided.

A review that is only partly satisfied is a NO: the submission does not yet comply, and
"Partially compliant" says how far it got. The renderers printed the qualifier in place of
the decision, so a report whose stored decision was "no" led with PARTIALLY COMPLIANT and
nothing else — which a reader files as a pass.
"""

from __future__ import annotations

import csv
import io

import pytest

from app import report


def payload(**overrides) -> dict:
    base = {
        "title": "FLS_Compliance_report",
        "subtitle": "uae_code_en, FLS",
        "generatedAt": "2026-09-06",
        "summary": "Reviewed 69 requirements. 2 met, 0 not met, 58 awaiting evidence.",
        "decision": "no",
        "decisionQualifier": "Partially compliant",
        "confidence": 0.61,
        "coverage": 0.87,
        "documentsReviewed": [{"title": "FLS", "role": "project", "pages": 9}],
        "rows": [
            {
                "requirement": "1.1.13",
                "result": "needs_evidence",
                "finding": "The drawing does not show it.",
                "source": "uae_code_en p.56",
            }
        ],
        "recommendations": [],
        "assumptions": [],
        "disclosures": [],
    }
    base.update(overrides)
    return base


def text_of(fmt: str, data: dict) -> str:
    builder, _, _ = report.BUILDERS[fmt]
    out = builder(data)
    if fmt == "pdf":
        import pymupdf

        doc = pymupdf.open(stream=out, filetype="pdf")
        try:
            return "".join(doc[i].get_text("text") for i in range(doc.page_count))
        finally:
            doc.close()
    if fmt == "xlsx":
        import openpyxl

        book = openpyxl.load_workbook(io.BytesIO(out))
        return "\n".join(
            " ".join("" if c is None else str(c) for c in row)
            for sheet in book.worksheets
            for row in sheet.iter_rows(values_only=True)
        )
    if fmt == "docx":
        import docx

        return "\n".join(p.text for p in docx.Document(io.BytesIO(out)).paragraphs)
    return out.decode("utf-8")


@pytest.mark.parametrize("fmt", ["pdf", "docx", "xlsx", "csv", "markdown"])
def test_partial_compliance_is_reported_as_not_compliant(fmt: str) -> None:
    body = text_of(fmt, payload())
    # csv carries the matrix rather than a verdict block; the others must all state it.
    if fmt == "csv":
        return
    assert "NOT COMPLIANT" in body.upper(), f"{fmt} does not state the decision"
    # The qualifier may appear, but never instead of the decision.
    upper = body.upper()
    partial = upper.find("PARTIALLY COMPLIANT")
    if partial != -1:
        assert upper.find("NOT COMPLIANT") < partial, f"{fmt} leads with the qualifier"


@pytest.mark.parametrize("fmt", ["pdf", "docx", "xlsx", "markdown"])
def test_a_clean_pass_still_reads_as_compliant(fmt: str) -> None:
    body = text_of(fmt, payload(decision="yes", decisionQualifier=None)).upper()
    assert "COMPLIANT" in body
    assert "NOT COMPLIANT" not in body


@pytest.mark.parametrize("fmt", ["pdf", "docx", "xlsx", "markdown"])
def test_an_undetermined_review_says_so(fmt: str) -> None:
    body = text_of(fmt, payload(decision="unable_to_determine", decisionQualifier=None)).upper()
    assert "UNABLE TO DETERMINE" in body


def test_verdict_text_puts_the_decision_first() -> None:
    assert report.verdict_text({"decision": "no", "decisionQualifier": "Partially compliant"}) == (
        "NOT COMPLIANT - Partially compliant"
    )
    assert report.verdict_text({"decision": "yes"}) == "COMPLIANT"
    assert report.verdict_text({}) == "NOT DETERMINED"
