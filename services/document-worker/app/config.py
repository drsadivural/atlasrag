"""Runtime configuration for the document worker."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    """Configuration read once at import time.

    The shared token is the only authentication between the API and this service. The
    worker is never exposed publicly: in production it sits on a private network and the
    token guards against lateral movement inside it.
    """

    worker_token: str = field(default_factory=lambda: os.environ.get("DOCUMENT_WORKER_TOKEN", ""))
    max_pages: int = field(default_factory=lambda: int(os.environ.get("MAX_DOCUMENT_PAGES", "5000")))
    max_bytes: int = field(default_factory=lambda: int(os.environ.get("MAX_UPLOAD_BYTES", "524288000")))
    ocr_enabled: bool = field(
        default_factory=lambda: os.environ.get("OCR_ENABLED", "true").lower() in {"1", "true", "yes"}
    )
    ocr_language: str = field(default_factory=lambda: os.environ.get("OCR_LANGUAGE", "eng"))
    # A page whose extractable text falls below this many characters is treated as scanned
    # and sent to OCR. Chosen empirically: a genuinely text-based page almost always
    # exceeds it, while a scan of the same page yields little more than stray artefacts.
    ocr_text_threshold: int = field(
        default_factory=lambda: int(os.environ.get("OCR_TEXT_THRESHOLD", "40"))
    )
    ocr_dpi: int = field(default_factory=lambda: int(os.environ.get("OCR_DPI", "200")))
    ocr_max_pages: int = field(default_factory=lambda: int(os.environ.get("OCR_MAX_PAGES", "300")))
    # OCR runs page-parallel in a process pool this wide. Tesseract is CPU-bound and a
    # drawing set is many pages, so the default takes the cores it can find, capped so a
    # large host does not start dozens of Tesseracts per document.
    ocr_workers: int = field(
        default_factory=lambda: max(
            1, int(os.environ.get("OCR_WORKERS", str(min(8, os.cpu_count() or 1))))
        )
    )
    # A single page is given this long before its OCR is abandoned and the text layer used.
    ocr_page_timeout_seconds: float = field(
        default_factory=lambda: float(os.environ.get("OCR_PAGE_TIMEOUT_SECONDS", "120"))
    )
    # How many documents may be worked on at once: the handlers are synchronous, so this
    # is the size of the thread pool Starlette runs them in.
    thread_pool_size: int = field(
        default_factory=lambda: max(1, int(os.environ.get("UXE_THREAD_POOL_SIZE", "16")))
    )
    log_level: str = field(default_factory=lambda: os.environ.get("LOG_LEVEL", "info"))


settings = Settings()
