"""FastAPI application for the UXE Consulting AI document worker.

This service is the only component that opens original document bytes with native
libraries. It is deliberately isolated: no database, no tenant knowledge, no network egress
in normal operation. It receives bytes, returns structured data, and holds nothing.
"""

from __future__ import annotations

import base64
import hmac
import logging
import shutil
import subprocess
import time
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__, correct, detect, extract, report
from .config import settings

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":"%(message)s"}',
)
logger = logging.getLogger("uxe.document-worker")

app = FastAPI(
    title="UXE Consulting AI - Document Worker",
    version=__version__,
    docs_url=None,      # No interactive docs: this service is internal-only.
    redoc_url=None,
    openapi_url=None,
)


def require_token(token: str | None) -> None:
    """Constant-time shared-token check.

    When no token is configured the service refuses every request rather than running
    open: an unauthenticated document worker is a file-parsing oracle for anyone who can
    reach the network it sits on.
    """
    if not settings.worker_token:
        raise HTTPException(status_code=503, detail="Worker token is not configured.")
    if not token or not hmac.compare_digest(token, settings.worker_token):
        raise HTTPException(status_code=401, detail="Invalid worker token.")


def decode_payload(value: str, limit: int) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Payload is not valid base64.") from exc
    if len(data) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"File is {len(data) // (1024 * 1024)} MB, above the {limit // (1024 * 1024)} MB limit.",
        )
    return data


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class ExtractRequest(BaseModel):
    fileName: str = Field(max_length=512)
    contentType: str = Field(max_length=255)
    bytesBase64: str
    maxPages: int = Field(default=5000, ge=1, le=100_000)
    forceOcr: bool = False
    password: str | None = None


class ScanRequest(BaseModel):
    bytesBase64: str
    fileName: str = Field(max_length=512)
    declaredContentType: str = Field(max_length=255)


class ArchiveInspectRequest(BaseModel):
    bytesBase64: str
    maxEntries: int = Field(default=2000, ge=1)
    maxExpandedBytes: int = Field(default=2_147_483_648, ge=1)
    maxRatio: int = Field(default=120, ge=1)


class ChangeModel(BaseModel):
    ordinal: int
    pageNumber: int | None = None
    paragraphIndex: int | None = None
    sheetName: str | None = None
    cellRange: str | None = None
    slideNumber: int | None = None
    currentContent: str = ""
    proposedContent: str = ""
    reason: str = ""
    citation: str | None = None


class CorrectRequest(BaseModel):
    strategy: Literal["in_place_text", "tracked_changes", "overlay", "ocr_rebuild", "revised_edition"]
    documentType: str
    bytesBase64: str
    fileName: str
    title: str = "Corrected edition"
    changes: list[ChangeModel] = Field(default_factory=list)
    includeRedline: bool = True
    disclosures: list[str] = Field(default_factory=list)


class ReportRequest(BaseModel):
    format: Literal["pdf", "docx", "xlsx", "csv", "markdown"]
    title: str
    subtitle: str = ""
    generatedAt: str = ""
    summary: str = ""
    decision: str | None = None
    decisionQualifier: str | None = None
    confidence: float = 0.0
    coverage: float = 0.0
    documentsReviewed: list[dict[str, Any]] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    recommendations: list[dict[str, Any]] = Field(default_factory=list)
    disclosures: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


@app.get("/capabilities")
async def capabilities(x_worker_token: str | None = Header(default=None)) -> dict[str, Any]:
    """Reports what this worker can actually do.

    The API surfaces this so the product never offers a capability the deployment lacks —
    an OCR toggle on a worker without Tesseract would be a dead control.
    """
    require_token(x_worker_token)

    tesseract_version: str | None = None
    if shutil.which("tesseract"):
        try:
            result = subprocess.run(
                ["tesseract", "--version"], capture_output=True, text=True, timeout=5, check=False
            )
            tesseract_version = (result.stdout or result.stderr).splitlines()[0].strip() or None
        except Exception:  # noqa: BLE001
            tesseract_version = None

    return {
        "ocr": settings.ocr_enabled and tesseract_version is not None,
        "libreoffice": shutil.which("soffice") is not None or shutil.which("libreoffice") is not None,
        "pdf": True,
        "docx": True,
        "xlsx": True,
        "pptx": True,
        "tesseractVersion": tesseract_version,
    }


@app.post("/scan")
async def scan_endpoint(
    payload: ScanRequest, x_worker_token: str | None = Header(default=None)
) -> dict[str, Any]:
    require_token(x_worker_token)
    data = decode_payload(payload.bytesBase64, settings.max_bytes)
    result = detect.scan(data, payload.fileName, payload.declaredContentType)
    return {
        "clean": result.clean,
        "detectedContentType": result.detected_content_type,
        "reason": result.reason,
        "signatures": result.signatures,
    }


@app.post("/archive/inspect")
async def archive_inspect(
    payload: ArchiveInspectRequest, x_worker_token: str | None = Header(default=None)
) -> dict[str, Any]:
    require_token(x_worker_token)
    data = decode_payload(payload.bytesBase64, settings.max_bytes)
    result = detect.inspect_archive(
        data, payload.maxEntries, payload.maxExpandedBytes, payload.maxRatio
    )
    return {
        "safe": result.safe,
        "reason": result.reason,
        "entries": [
            {
                "name": e.name,
                "sizeBytes": e.size_bytes,
                "compressedBytes": e.compressed_bytes,
                "contentType": e.content_type,
            }
            for e in result.entries
        ],
    }


@app.post("/extract")
async def extract_endpoint(
    payload: ExtractRequest, x_worker_token: str | None = Header(default=None)
) -> dict[str, Any]:
    require_token(x_worker_token)
    started = time.monotonic()
    data = decode_payload(payload.bytesBase64, settings.max_bytes)

    content_type = detect.sniff(data, payload.fileName, payload.contentType)
    document_type = detect.document_type_for(content_type)
    max_pages = min(payload.maxPages, settings.max_pages)

    try:
        if document_type == "pdf":
            result = extract.extract_pdf(data, max_pages, payload.forceOcr, payload.password)
        elif document_type == "docx":
            result = extract.extract_docx(data)
        elif document_type == "xlsx":
            result = extract.extract_xlsx(data)
        elif document_type == "csv":
            result = extract.extract_csv(data)
        elif document_type == "pptx":
            result = extract.extract_pptx(data)
        elif document_type == "image":
            result = extract.extract_image(data)
        elif document_type in {"text", "markdown", "html"}:
            result = extract.extract_text(data, document_type)
        else:
            raise HTTPException(
                status_code=415,
                detail=f"{content_type} is not a supported document type.",
            )
    except HTTPException:
        raise
    except ValueError as exc:
        # A document the libraries genuinely cannot open. The message is written for the
        # end user, so it is passed through unchanged.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("extraction failed for %s", payload.fileName)
        raise HTTPException(
            status_code=422,
            detail="This file could not be processed. It may be corrupt or use an unsupported variant of its format.",
        ) from exc

    logger.info(
        "extracted %s (%s) in %.0fms: %d page(s)",
        payload.fileName,
        document_type,
        (time.monotonic() - started) * 1000,
        len(result.pages),
    )
    return result.to_dict()


@app.post("/correct")
async def correct_endpoint(
    payload: CorrectRequest, x_worker_token: str | None = Header(default=None)
) -> dict[str, Any]:
    require_token(x_worker_token)
    data = decode_payload(payload.bytesBase64, settings.max_bytes)
    changes = [correct.Change.from_dict(c.model_dump()) for c in payload.changes]

    try:
        if payload.strategy == "tracked_changes" or (
            payload.strategy == "in_place_text" and payload.documentType == "docx"
        ):
            output = correct.correct_docx(data, changes, payload.includeRedline)
        elif payload.strategy == "overlay":
            output = correct.correct_pdf_overlay(data, changes, payload.includeRedline)
        elif payload.strategy == "ocr_rebuild":
            extraction = extract.extract_pdf(data, settings.max_pages, force_ocr=True)
            output = correct.rebuild_pdf_from_text(
                [p.text for p in extraction.pages], changes, payload.title, payload.disclosures
            )
        elif payload.strategy == "in_place_text" and payload.documentType == "xlsx":
            output = correct.correct_xlsx(data, changes)
        elif payload.strategy == "in_place_text" and payload.documentType == "pptx":
            output = correct.correct_pptx(data, changes)
        else:
            # Fallback: a professionally formatted revised edition plus a change report.
            extraction = _extract_for_revision(data, payload.documentType)
            output = correct.revised_edition(
                payload.title, changes, payload.disclosures, [p.text for p in extraction.pages]
            )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("correction failed for %s", payload.fileName)
        raise HTTPException(
            status_code=422,
            detail="The corrected edition could not be generated from this file.",
        ) from exc

    return {
        "documentBase64": base64.b64encode(output.document).decode("ascii"),
        "redlineBase64": base64.b64encode(output.redline).decode("ascii") if output.redline else None,
        "contentType": output.content_type,
        "extension": output.extension,
        "validation": {
            "opened": True,
            "pages": output.pages,
            "textLength": output.text_length,
            "mediaCount": output.media_count,
            "pageSizes": output.page_sizes,
            "appliedChanges": output.applied_changes,
            "unmatchedChanges": output.unmatched_changes,
        },
        "warnings": output.warnings,
    }


def _extract_for_revision(data: bytes, document_type: str) -> extract.Extraction:
    if document_type == "pdf":
        return extract.extract_pdf(data, settings.max_pages)
    if document_type == "docx":
        return extract.extract_docx(data)
    if document_type == "xlsx":
        return extract.extract_xlsx(data)
    if document_type == "pptx":
        return extract.extract_pptx(data)
    return extract.extract_text(data, "text")


@app.post("/report")
async def report_endpoint(
    payload: ReportRequest, x_worker_token: str | None = Header(default=None)
) -> dict[str, Any]:
    require_token(x_worker_token)
    builder, content_type, extension = report.BUILDERS[payload.format]
    try:
        document = builder(payload.model_dump())
    except Exception as exc:  # noqa: BLE001
        logger.exception("report generation failed")
        raise HTTPException(status_code=500, detail="The report could not be generated.") from exc

    return {
        "documentBase64": base64.b64encode(document).decode("ascii"),
        "contentType": content_type,
        "extension": extension,
    }


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
