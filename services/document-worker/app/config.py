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
    log_level: str = field(default_factory=lambda: os.environ.get("LOG_LEVEL", "info"))


settings = Settings()
