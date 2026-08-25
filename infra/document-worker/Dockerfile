# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# UXE Consulting AI — document worker
#
# Python is not available on Cloudflare Workers, and the libraries this service
# depends on (PyMuPDF, LibreOffice, Tesseract) are native. It therefore runs as a
# container on a private network; the API reaches it over a shared-secret token and
# it is never exposed to the internet.
# ---------------------------------------------------------------------------

FROM python:3.12.8-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System packages:
#   tesseract-ocr        scanned-page OCR
#   libreoffice-*        format conversion for the corrected-document path
#   fonts-dejavu-core    a real Unicode font, so generated PDFs are not full of boxes
#   ghostscript          PDF/A normalisation
#   libmagic1            content-type sniffing that does not trust the file extension
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      tesseract-ocr \
      tesseract-ocr-eng \
      tesseract-ocr-jpn \
      libreoffice-writer-nogui \
      libreoffice-calc-nogui \
      libreoffice-impress-nogui \
      fonts-dejavu-core \
      fonts-noto-cjk \
      ghostscript \
      libmagic1 \
      curl \
 && rm -rf /var/lib/apt/lists/*

FROM base AS deps
WORKDIR /app
COPY services/document-worker/requirements.txt ./requirements.txt
RUN pip install --require-hashes=false -r requirements.txt

FROM deps AS runtime
WORKDIR /app

# Unprivileged: a document parser is the most likely place for a hostile file to find a
# bug, so the process that opens customer documents owns nothing it can damage.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin worker \
 && mkdir -p /app/tmp \
 && chown -R worker:worker /app

COPY --chown=worker:worker services/document-worker/app ./app

USER worker

ENV HOME=/home/worker \
    TMPDIR=/app/tmp \
    PORT=8000 \
    OCR_ENABLED=true \
    OCR_LANGUAGE=eng \
    LOG_LEVEL=info

EXPOSE 8000

# The health endpoint is unauthenticated by design so the orchestrator can probe it
# without holding the worker token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:8000/health || exit 1

# One worker process per container; scale horizontally instead of threading, because
# PyMuPDF holds the GIL for long stretches on large documents.
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "1", \
     "--timeout-keep-alive", "65", \
     "--no-server-header"]
