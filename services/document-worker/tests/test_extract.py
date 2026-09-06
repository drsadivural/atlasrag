"""Extraction regressions.

Two things happened to real customer drawings that these tests pin down: signature
detection walked every widget on every page of a 90 MB CAD file and took longer than the
API was willing to wait, and a running extraction blocked the service's event loop so
/health stopped answering while it worked.
"""

from __future__ import annotations

import dataclasses
import threading
import time

import pikepdf
import pymupdf
import pytest

from app import extract


def use_settings(monkeypatch, module, **overrides) -> None:
    """Swaps in a Settings copy. The real one is frozen, so fields cannot be assigned."""
    monkeypatch.setattr(module, "settings", dataclasses.replace(module.settings, **overrides))


# ---------------------------------------------------------------------------
# Fixtures: PDFs built by hand so each carries exactly the structure under test.
# ---------------------------------------------------------------------------


def _blank_pdf() -> pikepdf.Pdf:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(595, 842))
    return pdf


def _bytes(pdf: pikepdf.Pdf) -> bytes:
    import io

    out = io.BytesIO()
    pdf.save(out)
    return out.getvalue()


def signed_pdf() -> bytes:
    """A conforming signed document: SigFlags set, a /Sig field with a /ByteRange value."""
    pdf = _blank_pdf()
    page = pdf.pages[0]
    sig_value = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Sig"),
            Filter=pikepdf.Name("/Adobe.PPKLite"),
            ByteRange=pikepdf.Array([0, 0, 0, 0]),
            Contents=pikepdf.String(""),
        )
    )
    widget = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Sig"),
            T=pikepdf.String("Signature1"),
            Rect=pikepdf.Array([50, 50, 250, 100]),
            V=sig_value,
            P=page.obj,
        )
    )
    page.obj["/Annots"] = pikepdf.Array([widget])
    pdf.Root["/AcroForm"] = pikepdf.Dictionary(
        Fields=pikepdf.Array([widget]), SigFlags=3
    )
    return _bytes(pdf)


def signed_without_sigflags_pdf() -> bytes:
    """A signature field whose writer forgot SigFlags. Still signed; must still be seen."""
    pdf = _blank_pdf()
    page = pdf.pages[0]
    widget = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Sig"),
            T=pikepdf.String("Signature1"),
            Rect=pikepdf.Array([50, 50, 250, 100]),
            P=page.obj,
        )
    )
    page.obj["/Annots"] = pikepdf.Array([widget])
    pdf.Root["/AcroForm"] = pikepdf.Dictionary(Fields=pikepdf.Array([widget]))
    return _bytes(pdf)


def incremental_signature_pdf() -> bytes:
    """A signature dictionary that never registered as a field — an incremental update."""
    pdf = _blank_pdf()
    page = pdf.pages[0]
    sig_value = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Sig"),
            ByteRange=pikepdf.Array([0, 0, 0, 0]),
            Contents=pikepdf.String(""),
        )
    )
    # Present on the page but absent from AcroForm/Fields: nothing enumerates it as a
    # field, so only the raw-object sweep can find it.
    page.obj["/Annots"] = pikepdf.Array(
        [
            pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name("/Annot"),
                    Subtype=pikepdf.Name("/Widget"),
                    FT=pikepdf.Name("/Sig"),
                    Rect=pikepdf.Array([50, 50, 250, 100]),
                    V=sig_value,
                    P=page.obj,
                )
            )
        ]
    )
    return _bytes(pdf)


def form_without_signature_pdf() -> bytes:
    """A form with an ordinary text field. Has widgets, is not signed."""
    pdf = _blank_pdf()
    page = pdf.pages[0]
    widget = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"),
            T=pikepdf.String("Name"),
            Rect=pikepdf.Array([50, 50, 250, 100]),
            P=page.obj,
        )
    )
    page.obj["/Annots"] = pikepdf.Array([widget])
    pdf.Root["/AcroForm"] = pikepdf.Dictionary(Fields=pikepdf.Array([widget]))
    return _bytes(pdf)


def plain_pdf(pages: int = 3) -> bytes:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(595, 842))
    return _bytes(pdf)


def _open(data: bytes) -> pymupdf.Document:
    return pymupdf.open(stream=data, filetype="pdf")


# ---------------------------------------------------------------------------
# Signature detection
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("label", "builder"),
    [
        ("conforming", signed_pdf),
        ("no SigFlags", signed_without_sigflags_pdf),
        ("incremental update", incremental_signature_pdf),
    ],
)
def test_signature_is_detected(label: str, builder) -> None:
    # A false negative would let the product imply a signature survived an edit.
    assert extract._pdf_is_signed(_open(builder())) is True, label


def test_form_without_signature_is_not_signed() -> None:
    assert extract._pdf_is_signed(_open(form_without_signature_pdf())) is False


def test_plain_document_is_not_signed_and_never_walks_widgets(monkeypatch) -> None:
    # Without an AcroForm there is nothing a widget walk could find, and on a large
    # drawing that walk is what took minutes. It must not run at all.
    walked = []
    original = pymupdf.Page.widgets

    def spy(self):
        walked.append(self.number)
        return original(self)

    monkeypatch.setattr(pymupdf.Page, "widgets", spy)
    started = time.monotonic()
    assert extract._pdf_is_signed(_open(plain_pdf(pages=40))) is False
    assert walked == []
    assert time.monotonic() - started < 1.0


def test_extraction_reports_signature() -> None:
    result = extract.extract_pdf(signed_pdf(), max_pages=10)
    assert result.is_signed is True
    assert result.document_type == "pdf"
    assert len(result.pages) == 1


# ---------------------------------------------------------------------------
# Extraction still behaves after the spool-to-disk change
# ---------------------------------------------------------------------------


def _text_pdf(lines: list[str]) -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    y = 72
    for line in lines:
        page.insert_text((72, y), line, fontsize=11)
        y += 16
    data = doc.tobytes()
    doc.close()
    return data


def test_text_layer_is_extracted_with_word_boxes() -> None:
    result = extract.extract_pdf(_text_pdf(["Clause 1.5.2 Emergency lighting", "shall cover every exit"]), 10)
    assert result.pages[0].ocr_applied is False
    assert "Emergency lighting" in result.pages[0].text
    boxes = result.pages[0].word_boxes
    assert any(b["t"] == "Emergency" for b in boxes)
    assert all(0.0 <= b["x"] <= 1.0 and 0.0 <= b["y"] <= 1.0 for b in boxes)
    assert result.has_extractable_text is True
    assert result.is_scanned is False


def test_page_limit_is_honoured_with_a_warning() -> None:
    result = extract.extract_pdf(plain_pdf(pages=5), max_pages=2)
    assert len(result.pages) == 2
    assert any("first 2 of 5" in w for w in result.warnings)


def test_ocr_candidates_are_capped_in_page_order(monkeypatch) -> None:
    # Blank pages all need OCR; only the first OCR_MAX_PAGES of them may be sent.
    seen: list[list[int]] = []

    def fake_ocr_pages(path, indices, password):
        seen.append(list(indices))
        return {i: (f"page {i + 1} text", [], 0.9) for i in indices}

    monkeypatch.setattr(extract, "_ocr_pages", fake_ocr_pages)
    use_settings(monkeypatch, extract, ocr_enabled=True, ocr_max_pages=2)
    result = extract.extract_pdf(plain_pdf(pages=4), max_pages=10)
    assert seen == [[0, 1]]
    assert [p.ocr_applied for p in result.pages] == [True, True, False, False]
    assert result.pages[0].text == "page 1 text"
    assert result.ocr_applied is True


def test_an_ocr_page_that_never_finishes_falls_back_to_its_text_layer(monkeypatch) -> None:
    # The give-up branch: a page missing from the OCR result keeps its text layer and the
    # document says so, instead of the whole extraction failing or waiting for ever.
    monkeypatch.setattr(
        extract, "_ocr_pages", lambda path, indices, password: {indices[0]: ("only page one", [], 0.8)}
    )
    use_settings(monkeypatch, extract, ocr_enabled=True)
    result = extract.extract_pdf(plain_pdf(pages=3), max_pages=10)
    assert result.pages[0].ocr_applied is True
    assert result.pages[1].ocr_applied is False
    assert result.pages[2].ocr_applied is False
    assert any("did not finish for page(s) 2, 3" in w for w in result.warnings)


def test_parallel_ocr_bounds_its_wait(monkeypatch) -> None:
    # Pool tasks that never return must not hold the request: the batch deadline expires,
    # the missing pages are reported, and the pool is reset so the next document is not
    # queued behind a stuck worker.
    class NeverDone:
        def get(self, timeout):
            time.sleep(min(timeout, 0.05))
            raise extract.multiprocessing.TimeoutError()

    class FakePool:
        def apply_async(self, fn, args):
            return NeverDone()

    resets = []
    monkeypatch.setattr(extract, "_ocr_pool", lambda: FakePool())
    monkeypatch.setattr(extract, "_reset_ocr_pool", lambda: resets.append(True))
    use_settings(monkeypatch, extract, ocr_workers=4, ocr_page_timeout_seconds=0.05)
    started = time.monotonic()
    out = extract._ocr_pages("/nonexistent.pdf", [0, 1, 2, 3, 4, 5], None)
    assert out == {}
    assert resets == [True]
    assert time.monotonic() - started < 2.0


# ---------------------------------------------------------------------------
# The service keeps answering while it works
# ---------------------------------------------------------------------------


def test_health_answers_while_an_extraction_is_running(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from app import main

    use_settings(monkeypatch, main, worker_token="test-token")

    def slow_extract(data, max_pages, force_ocr=False, password=None):
        time.sleep(1.5)
        return extract.Extraction(document_type="pdf", pages=[])

    monkeypatch.setattr(main.extract, "extract_pdf", slow_extract)

    import base64

    payload = {
        "fileName": "slow.pdf",
        "contentType": "application/pdf",
        "bytesBase64": base64.b64encode(plain_pdf(1)).decode("ascii"),
        "maxPages": 10,
    }
    client = TestClient(main.app)
    outcome: dict[str, int] = {}

    def run_extract():
        outcome["status"] = client.post(
            "/extract", json=payload, headers={"x-worker-token": "test-token"}
        ).status_code

    thread = threading.Thread(target=run_extract)
    thread.start()
    time.sleep(0.2)  # let the extraction start
    started = time.monotonic()
    health = client.get("/health")
    health_latency = time.monotonic() - started
    thread.join(timeout=10)

    assert health.status_code == 200
    assert health_latency < 0.5, f"/health took {health_latency:.2f}s while extracting"
    assert outcome.get("status") == 200
