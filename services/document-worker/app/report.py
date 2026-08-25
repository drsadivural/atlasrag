"""Report generation: compliance reports, summaries and evidence matrices.

Every row in a generated report comes from a verified citation supplied by the API. This
module formats; it never asserts. A row whose citation failed verification arrives with
`verified: false` and is rendered as such rather than being dropped, so the reader sees the
gap instead of a silently shorter table.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from .pdfkit import (
    BOLD,
    COBALT,
    DANGER,
    Document,
    INK,
    MUTED,
    SUCCESS,
    WARNING,
)

RESULT_COLORS = {
    "compliant": SUCCESS,
    "non_compliant": DANGER,
    "needs_evidence": WARNING,
    "not_assessed": MUTED,
}

RESULT_LABELS = {
    "compliant": "Compliant",
    "non_compliant": "Non-compliant",
    "needs_evidence": "Needs evidence",
    "not_assessed": "Not assessed",
}


def build_pdf(payload: dict[str, Any]) -> bytes:
    """Renders a report PDF.

    Layout goes through `pdfkit.Document`, which measures every line before drawing it, so
    a long evidence matrix paginates rather than silently truncating.
    """
    doc = Document()
    doc.footer_text = "UXE Consulting AI  -  verified answers, exact evidence, corrected documents"

    doc.text("UXE CONSULTING AI", size=9.5, color=COBALT, bold=True, gap=4)
    doc.text(payload.get("title") or "Compliance report", size=22, bold=True, gap=4)
    if payload.get("subtitle"):
        doc.text(payload["subtitle"], size=11.5, color=MUTED, gap=8)
    doc.text(f"Generated {payload.get('generatedAt', '')}", size=8.5, color=MUTED, gap=12)

    decision = payload.get("decision")
    qualifier = payload.get("decisionQualifier")
    if decision:
        label = (qualifier or decision).upper()
        color = DANGER if decision == "no" else SUCCESS if decision == "yes" else MUTED
        doc.pill(label, color, gap=8)

    coverage = float(payload.get("coverage") or 0) * 100
    confidence = float(payload.get("confidence") or 0) * 100
    doc.key_values(
        [
            ("Evidence coverage", f"{coverage:.0f}%"),
            ("Confidence", f"{confidence:.0f}%"),
        ],
        gap=2,
    )
    doc.rule()

    doc.heading("Summary")
    doc.text(payload.get("summary") or "", size=10, gap=14)

    documents = payload.get("documentsReviewed") or []
    if documents:
        doc.heading("Documents reviewed")
        for item in documents:
            pages = f", {item.get('pages')} pages" if item.get("pages") else ""
            doc.text(
                f"-  {item.get('title')}  ({item.get('version')}, {item.get('role')}{pages})",
                size=9.5,
                gap=3,
            )
        doc.space(10)

    assumptions = payload.get("assumptions") or []
    if assumptions:
        doc.heading("Assumptions and scope limits")
        for item in assumptions:
            doc.text(f"-  {item}", size=9, color=MUTED, gap=3)
        doc.space(10)

    rows = payload.get("rows") or []
    if rows:
        doc.rule()
        doc.heading("Evidence matrix")
        for index, row in enumerate(rows, start=1):
            result = row.get("result", "not_assessed")
            requirement = f"{index}.  {row.get('requirement', '')}"
            # Reserve the whole row so a heading never strands at the foot of a page.
            doc.keep_together(
                doc.measure(requirement, 11, bold=True)
                + doc.measure(row.get("finding", ""), 9.5)
                + doc.measure(row.get("excerpt", ""), 9, indent=14)
                + 60
            )
            doc.text(requirement, size=11, bold=True, gap=3)
            doc.text(
                RESULT_LABELS.get(result, result).upper(),
                size=8.5,
                color=RESULT_COLORS.get(result, MUTED),
                bold=True,
                gap=4,
            )
            doc.text(row.get("finding", ""), size=9.5, gap=5)

            page = f"  -  p. {row.get('page')}" if row.get("page") else ""
            verified = "verified" if row.get("verified") else "UNVERIFIED"
            doc.text(
                f"{row.get('source', '-')} ({row.get('version', '-')})  -  {row.get('location') or '-'}{page}  -  [{verified}]",
                size=8.5,
                color=MUTED if row.get("verified") else WARNING,
                gap=4,
            )

            excerpt = (row.get("excerpt") or "").strip()
            if excerpt:
                doc.text(f'"{excerpt}"', size=9, color=MUTED, indent=14, gap=8)
            doc.rule(gap=10)

    recommendations = payload.get("recommendations") or []
    if recommendations:
        doc.heading("Recommended actions")
        for item in recommendations:
            priority = str(item.get("priority", "")).upper()
            color = DANGER if priority == "CRITICAL" else WARNING if priority == "HIGH" else INK
            doc.text(f"[{priority}]  {item.get('action', '')}", size=9.5, color=color, gap=5)
        doc.space(10)

    disclosures = payload.get("disclosures") or []
    if disclosures:
        doc.rule()
        doc.heading("Disclosures", size=12)
        for item in disclosures:
            doc.text(f"-  {item}", size=8.5, color=MUTED, gap=3)

    return doc.finish()


def build_docx(payload: dict[str, Any]) -> bytes:
    import docx
    from docx.shared import Pt, RGBColor

    document = docx.Document()

    brand = document.add_paragraph()
    brand_run = brand.add_run("UXE Consulting AI")
    brand_run.bold = True
    brand_run.font.color.rgb = RGBColor(0x31, 0x56, 0xF5)
    brand_run.font.size = Pt(11)

    document.add_heading(payload.get("title") or "Compliance report", level=0)
    if payload.get("subtitle"):
        document.add_paragraph(payload["subtitle"])
    document.add_paragraph(f"Generated {payload.get('generatedAt', '')}")

    decision = payload.get("decision")
    if decision:
        paragraph = document.add_paragraph()
        run = paragraph.add_run((payload.get("decisionQualifier") or decision).upper())
        run.bold = True
        run.font.color.rgb = (
            RGBColor(0xE5, 0x48, 0x4D) if decision == "no" else RGBColor(0x12, 0xA8, 0x6B)
        )

    document.add_paragraph(
        f"Evidence coverage {float(payload.get('coverage') or 0) * 100:.0f}%  |  "
        f"Confidence {float(payload.get('confidence') or 0) * 100:.0f}%"
    )

    document.add_heading("Summary", level=1)
    document.add_paragraph(payload.get("summary") or "")

    documents = payload.get("documentsReviewed") or []
    if documents:
        document.add_heading("Documents reviewed", level=1)
        for doc in documents:
            document.add_paragraph(
                f"{doc.get('title')} ({doc.get('version')}, {doc.get('role')})", style="List Bullet"
            )

    assumptions = payload.get("assumptions") or []
    if assumptions:
        document.add_heading("Assumptions and scope limits", level=1)
        for item in assumptions:
            document.add_paragraph(item, style="List Bullet")

    rows = payload.get("rows") or []
    if rows:
        document.add_heading("Evidence matrix", level=1)
        table = document.add_table(rows=1, cols=6)
        table.style = "Light Grid Accent 1"
        headers = ["Requirement", "Result", "Finding", "Source", "Location", "Excerpt"]
        for index, header in enumerate(headers):
            cell = table.rows[0].cells[index]
            cell.text = header
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.bold = True

        for row in rows:
            cells = table.add_row().cells
            cells[0].text = str(row.get("requirement", ""))
            cells[1].text = RESULT_LABELS.get(row.get("result", ""), str(row.get("result", "")))
            cells[2].text = str(row.get("finding", ""))
            cells[3].text = f"{row.get('source', '')} ({row.get('version', '')})"
            page = f" p.{row.get('page')}" if row.get("page") else ""
            verified = "" if row.get("verified") else " [UNVERIFIED]"
            cells[4].text = f"{row.get('location', '')}{page}{verified}"
            cells[5].text = str(row.get("excerpt", ""))

    recommendations = payload.get("recommendations") or []
    if recommendations:
        document.add_heading("Recommended actions", level=1)
        for item in recommendations:
            document.add_paragraph(
                f"[{str(item.get('priority', '')).upper()}] {item.get('action', '')}",
                style="List Bullet",
            )

    disclosures = payload.get("disclosures") or []
    if disclosures:
        document.add_heading("Disclosures", level=1)
        for item in disclosures:
            document.add_paragraph(item, style="List Bullet")

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


EVIDENCE_HEADERS = [
    "Requirement",
    "Result",
    "Finding",
    "Source",
    "Version",
    "Chapter / Section / Clause",
    "Page",
    "Exact location",
    "Supporting excerpt",
    "Confidence",
    "Verified",
]


def _evidence_row(row: dict[str, Any]) -> list[str]:
    return [
        str(row.get("requirement", "")),
        RESULT_LABELS.get(row.get("result", ""), str(row.get("result", ""))),
        str(row.get("finding", "")),
        str(row.get("source", "")),
        str(row.get("version", "")),
        str(row.get("location", "")),
        str(row.get("page") or ""),
        str(row.get("location", "")),
        str(row.get("excerpt", "")),
        f"{float(row.get('confidence') or 0) * 100:.0f}%",
        "yes" if row.get("verified") else "no",
    ]


def build_csv(payload: dict[str, Any]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_ALL)
    writer.writerow(EVIDENCE_HEADERS)
    for row in payload.get("rows") or []:
        writer.writerow(_evidence_row(row))
    # BOM so Excel opens UTF-8 correctly on Windows without mangling accented characters.
    return b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8")


def build_xlsx(payload: dict[str, Any]) -> bytes:
    import openpyxl
    from openpyxl.styles import Alignment, Font, PatternFill

    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.title = "Evidence matrix"

    header_fill = PatternFill("solid", fgColor="3156F5")
    header_font = Font(color="FFFFFF", bold=True)

    sheet.append(EVIDENCE_HEADERS)
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(vertical="center", wrap_text=True)

    for row in payload.get("rows") or []:
        sheet.append(_evidence_row(row))

    widths = [34, 16, 58, 28, 12, 26, 8, 26, 64, 12, 10]
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[openpyxl.utils.get_column_letter(index)].width = width

    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    # Freeze the header so a long matrix stays readable while scrolling.
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions

    summary = workbook.create_sheet("Summary")
    summary.append(["Title", payload.get("title", "")])
    summary.append(["Generated", payload.get("generatedAt", "")])
    summary.append(["Decision", payload.get("decisionQualifier") or payload.get("decision") or ""])
    summary.append(["Evidence coverage", f"{float(payload.get('coverage') or 0) * 100:.0f}%"])
    summary.append(["Confidence", f"{float(payload.get('confidence') or 0) * 100:.0f}%"])
    summary.append([])
    summary.append(["Summary", payload.get("summary", "")])
    summary.append([])
    summary.append(["Assumptions"])
    for item in payload.get("assumptions") or []:
        summary.append(["", item])
    summary.append([])
    summary.append(["Disclosures"])
    for item in payload.get("disclosures") or []:
        summary.append(["", item])
    summary.column_dimensions["A"].width = 22
    summary.column_dimensions["B"].width = 100

    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def build_markdown(payload: dict[str, Any]) -> bytes:
    lines: list[str] = [
        f"# {payload.get('title', 'Compliance report')}",
        "",
        payload.get("subtitle") or "",
        "",
        f"_Generated {payload.get('generatedAt', '')}_",
        "",
    ]

    if payload.get("decision"):
        lines.append(f"**{(payload.get('decisionQualifier') or payload['decision']).upper()}**")
        lines.append("")

    lines.extend(
        [
            f"Evidence coverage **{float(payload.get('coverage') or 0) * 100:.0f}%** - "
            f"Confidence **{float(payload.get('confidence') or 0) * 100:.0f}%**",
            "",
            "## Summary",
            "",
            payload.get("summary") or "",
            "",
        ]
    )

    if payload.get("documentsReviewed"):
        lines.extend(["## Documents reviewed", ""])
        for doc in payload["documentsReviewed"]:
            lines.append(f"- {doc.get('title')} ({doc.get('version')}, {doc.get('role')})")
        lines.append("")

    if payload.get("assumptions"):
        lines.extend(["## Assumptions and scope limits", ""])
        for item in payload["assumptions"]:
            lines.append(f"- {item}")
        lines.append("")

    if payload.get("rows"):
        lines.extend(
            [
                "## Evidence matrix",
                "",
                "| Requirement | Result | Finding | Source | Location | Page | Excerpt | Confidence | Verified |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
            ]
        )
        for row in payload["rows"]:
            cells = [
                str(row.get("requirement", "")),
                RESULT_LABELS.get(row.get("result", ""), ""),
                str(row.get("finding", "")),
                str(row.get("source", "")),
                str(row.get("location", "")),
                str(row.get("page") or ""),
                str(row.get("excerpt", "")),
                f"{float(row.get('confidence') or 0) * 100:.0f}%",
                "yes" if row.get("verified") else "no",
            ]
            # Escape pipes so a citation containing one cannot break the table.
            lines.append("| " + " | ".join(c.replace("|", "\\|").replace("\n", " ") for c in cells) + " |")
        lines.append("")

    if payload.get("recommendations"):
        lines.extend(["## Recommended actions", ""])
        for item in payload["recommendations"]:
            lines.append(f"- **[{str(item.get('priority', '')).upper()}]** {item.get('action', '')}")
        lines.append("")

    if payload.get("disclosures"):
        lines.extend(["## Disclosures", ""])
        for item in payload["disclosures"]:
            lines.append(f"- {item}")
        lines.append("")

    return "\n".join(lines).encode("utf-8")


BUILDERS = {
    "pdf": (build_pdf, "application/pdf", "pdf"),
    "docx": (
        build_docx,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
    "xlsx": (
        build_xlsx,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    "csv": (build_csv, "text/csv", "csv"),
    "markdown": (build_markdown, "text/markdown", "md"),
}
