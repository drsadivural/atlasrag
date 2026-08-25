"""MIME sniffing and safety checks.

The declared content type from a browser is a hint, never a fact. Every file is identified
from its own bytes before anything else looks at it, so a `.pdf` that is actually a ZIP of
executables is caught before extraction opens it.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass

# (offset, magic bytes, content type)
_SIGNATURES: list[tuple[int, bytes, str]] = [
    (0, b"%PDF-", "application/pdf"),
    (0, b"\x89PNG\r\n\x1a\n", "image/png"),
    (0, b"\xff\xd8\xff", "image/jpeg"),
    (0, b"GIF87a", "image/gif"),
    (0, b"GIF89a", "image/gif"),
    (0, b"BM", "image/bmp"),
    (0, b"II*\x00", "image/tiff"),
    (0, b"MM\x00*", "image/tiff"),
    (0, b"\x1f\x8b", "application/gzip"),
    (0, b"Rar!\x1a\x07", "application/x-rar-compressed"),
    (0, b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    (0, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/x-ole-storage"),  # legacy .doc/.xls
    (0, b"{\\rtf", "application/rtf"),
]

# Executable formats. None of these is ever a legitimate consultation document.
_EXECUTABLE_SIGNATURES: list[tuple[bytes, str]] = [
    (b"MZ", "windows-executable"),
    (b"\x7fELF", "linux-executable"),
    (b"\xca\xfe\xba\xbe", "mach-o-fat"),
    (b"\xcf\xfa\xed\xfe", "mach-o"),
    (b"\xfe\xed\xfa\xce", "mach-o-be"),
    (b"#!/", "script-shebang"),
    (b"\xde\xad\xbe\xef", "unknown-binary"),
]

_OOXML_MARKERS = {
    "word/document.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xl/workbook.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "ppt/presentation.xml": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

# The EICAR test string. A real deployment fronts this with ClamAV (see the Dockerfile);
# recognising EICAR lets the scanner path be exercised end to end in tests and in CI.
_EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


@dataclass
class ScanResult:
    clean: bool
    detected_content_type: str
    reason: str | None
    signatures: list[str]


def sniff(data: bytes, file_name: str, declared: str) -> str:
    """Identifies a file from its bytes, falling back to the extension only for plain text."""
    head = data[:512]

    for offset, magic, content_type in _SIGNATURES:
        if head[offset : offset + len(magic)] == magic:
            return content_type

    if head[:2] == b"PK":
        ooxml = _sniff_zip(data)
        if ooxml:
            return ooxml
        return "application/zip"

    extension = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    if extension in {"txt", "text", "log"}:
        return "text/plain"
    if extension in {"md", "markdown"}:
        return "text/markdown"
    if extension in {"csv"}:
        return "text/csv"
    if extension in {"htm", "html"}:
        return "text/html"
    if extension in {"json"}:
        return "application/json"

    # If it decodes as UTF-8 and contains no NULs, it is text regardless of what it claims.
    if b"\x00" not in head:
        try:
            head.decode("utf-8")
            if b"<html" in head.lower() or b"<!doctype html" in head.lower():
                return "text/html"
            return "text/plain"
        except UnicodeDecodeError:
            pass

    return declared or "application/octet-stream"


def _sniff_zip(data: bytes) -> str | None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = set(archive.namelist())
            for marker, content_type in _OOXML_MARKERS.items():
                if marker in names:
                    return content_type
    except Exception:  # noqa: BLE001
        return None
    return None


def scan(data: bytes, file_name: str, declared: str) -> ScanResult:
    """Rejects anything that is executable, hostile, or not what it claims to be."""
    detected = sniff(data, file_name, declared)
    signatures: list[str] = []

    if _EICAR in data[:4096]:
        return ScanResult(False, detected, "Antivirus test signature detected (EICAR).", ["EICAR"])

    head = data[:8]
    for magic, label in _EXECUTABLE_SIGNATURES:
        if head.startswith(magic):
            return ScanResult(
                False,
                detected,
                f"This file is an executable ({label}), which cannot be used as a consultation document.",
                [label],
            )

    if detected == "application/x-ole-storage":
        # Legacy Office binaries are the classic macro-malware carrier and cannot be parsed
        # safely here. Ask for the modern format instead of half-supporting them.
        return ScanResult(
            False,
            detected,
            "Legacy Office formats (.doc/.xls/.ppt) are not supported. Save the file as .docx, .xlsx or .pptx and upload it again.",
            ["ole-storage"],
        )

    # An OOXML package that carries a macro project is accepted but flagged; the macro is
    # never executed and never survives into a corrected edition.
    if detected.startswith("application/vnd.openxmlformats"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = archive.namelist()
                if any(n.endswith("vbaProject.bin") for n in names):
                    signatures.append("macro-project")
                # External relationships can silently pull remote content on open.
                for name in names:
                    if name.endswith(".rels"):
                        content = archive.read(name)[:200_000]
                        if b'TargetMode="External"' in content and b"http" in content:
                            signatures.append("external-relationship")
                            break
        except Exception:  # noqa: BLE001
            return ScanResult(False, detected, "This Office file appears to be corrupt.", ["corrupt-zip"])

    if detected in {"application/x-rar-compressed", "application/x-7z-compressed"}:
        return ScanResult(
            False,
            detected,
            "Only ZIP archives can be expanded. Re-package the files as a .zip and upload again.",
            ["unsupported-archive"],
        )

    return ScanResult(True, detected, None, signatures)


@dataclass
class ArchiveEntry:
    name: str
    size_bytes: int
    compressed_bytes: int
    content_type: str


@dataclass
class ArchiveInspection:
    safe: bool
    reason: str | None
    entries: list[ArchiveEntry]


_UNSAFE_PATH = re.compile(r"(^/)|(^[A-Za-z]:)|(\.\.[\\/])")


def inspect_archive(
    data: bytes, max_entries: int, max_expanded_bytes: int, max_ratio: int
) -> ArchiveInspection:
    """Refuses zip bombs and path-traversal archives before anything is expanded.

    Three independent limits are applied because each defeats a different attack: entry
    count stops a million tiny files, total expanded size stops one enormous file, and the
    compression ratio stops the classic nested-bomb that satisfies both other limits.
    """
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception:  # noqa: BLE001
        return ArchiveInspection(False, "This archive could not be read.", [])

    infos = archive.infolist()
    if len(infos) > max_entries:
        return ArchiveInspection(
            False,
            f"This archive contains {len(infos)} entries, above the limit of {max_entries}.",
            [],
        )

    total_expanded = 0
    total_compressed = 0
    entries: list[ArchiveEntry] = []

    for info in infos:
        if info.is_dir():
            continue
        if _UNSAFE_PATH.search(info.filename):
            return ArchiveInspection(
                False,
                f"This archive contains an unsafe path ({info.filename}).",
                [],
            )

        total_expanded += info.file_size
        total_compressed += max(info.compress_size, 1)

        if total_expanded > max_expanded_bytes:
            return ArchiveInspection(
                False,
                f"This archive expands to more than the {max_expanded_bytes // (1024 * 1024)} MB limit.",
                [],
            )

        entries.append(
            ArchiveEntry(
                name=info.filename,
                size_bytes=info.file_size,
                compressed_bytes=info.compress_size,
                content_type=sniff(b"", info.filename, "application/octet-stream"),
            )
        )

    if total_compressed > 0 and total_expanded / total_compressed > max_ratio:
        return ArchiveInspection(
            False,
            f"This archive has a compression ratio of {total_expanded / total_compressed:.0f}:1, above the {max_ratio}:1 limit. It looks like a decompression bomb.",
            [],
        )

    archive.close()
    return ArchiveInspection(True, None, entries)


def document_type_for(content_type: str) -> str:
    """Maps a MIME type onto the product's document-type vocabulary."""
    mapping = {
        "application/pdf": "pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
        "text/csv": "csv",
        "text/html": "html",
        "text/markdown": "markdown",
        "text/plain": "text",
        "application/json": "text",
        "application/zip": "archive",
    }
    if content_type.startswith("image/"):
        return "image"
    return mapping.get(content_type, "unknown")
