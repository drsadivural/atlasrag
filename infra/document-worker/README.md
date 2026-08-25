# Document worker deployment

The worker is a stateless HTTP service. It holds no database connection and no customer
data at rest: bytes arrive in the request, are processed in a temporary directory, and are
gone when the response is written.

## Build

```bash
docker build -f infra/document-worker/Dockerfile -t uxe-document-worker:1.0.0 .
```

The build context is the repository root, so the image can copy both the service source
and its pinned `requirements.txt`.

## Run

```bash
docker run --rm -p 8000:8000 \
  -e DOCUMENT_WORKER_TOKEN="$(openssl rand -base64 32)" \
  -e MAX_UPLOAD_BYTES=524288000 \
  -e OCR_LANGUAGE=eng+jpn \
  uxe-document-worker:1.0.0
```

## Configuration

| Variable                | Default     | Purpose                                                                           |
| ----------------------- | ----------- | --------------------------------------------------------------------------------- |
| `DOCUMENT_WORKER_TOKEN` | _(empty)_   | Shared secret the API presents. Empty disables auth and is refused in production. |
| `MAX_DOCUMENT_PAGES`    | `5000`      | Hard ceiling before a document is rejected as unreasonable.                       |
| `MAX_UPLOAD_BYTES`      | `524288000` | Largest accepted request body.                                                    |
| `OCR_ENABLED`           | `true`      | Whether scanned pages are OCR'd at all.                                           |
| `OCR_LANGUAGE`          | `eng`       | Tesseract language packs; `eng+jpn` for bilingual corpora.                        |
| `OCR_TEXT_THRESHOLD`    | `40`        | Characters of extractable text below which a page is treated as scanned.          |
| `OCR_DPI`               | `200`       | Rasterisation DPI for OCR. Higher is slower and rarely more accurate.             |
| `OCR_MAX_PAGES`         | `300`       | Upper bound on OCR'd pages per document.                                          |

## Sizing and autoscaling

One request occupies one worker process for its duration. OCR dominates: roughly 1–3
seconds per page at 200 DPI on a modern vCPU, against 20–60 ms per page for a text-based
PDF.

| Signal                         | Target                            | Action                                        |
| ------------------------------ | --------------------------------- | --------------------------------------------- |
| CPU utilisation                | 70%                               | Scale out                                     |
| Request duration p95           | < 30 s for text, < 180 s with OCR | Scale out                                     |
| In-flight requests per replica | 1                                 | The API's own queue provides the backpressure |

Recommended container size is 2 vCPU / 4 GiB. Memory scales with page size, not page
count: PyMuPDF renders one page at a time.

## Health and readiness

`GET /health` returns `{"status":"ok"}` and requires no token. `GET /capabilities`
requires the token and reports which optional dependencies are present (Tesseract,
LibreOffice, Ghostscript), so an operator can confirm an image was built completely rather
than discovering a missing binary during an ingestion run.

## Network policy

The worker must not be reachable from the internet. Expected policy:

- inbound: from the API service only, port 8000
- outbound: none — the worker never fetches a URL, and blocking egress removes a whole
  class of SSRF risk from a service whose input is untrusted documents
