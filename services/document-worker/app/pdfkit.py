"""A small, correct text-flow layer over PyMuPDF.

PyMuPDF has no flow layout. `insert_textbox` renders *nothing* and returns a negative
number when the text does not fit the rectangle it was given, so any layout that guesses at
heights silently drops content — headings vanish, tables end early, and the failure is
invisible until somebody reads the generated report.

This module measures first. Text is wrapped using real glyph widths, the exact height is
computed from the wrapped line count, and pagination happens before anything is drawn. Text
is then written line by line with `insert_text`, which cannot fail silently.
"""

from __future__ import annotations

from dataclasses import dataclass

import pymupdf

# Product palette, so generated documents look like the application that produced them.
INK = (0.063, 0.086, 0.184)
MUTED = (0.400, 0.439, 0.522)
COBALT = (0.192, 0.337, 0.961)
VIOLET = (0.486, 0.227, 0.929)
SUCCESS = (0.071, 0.659, 0.420)
WARNING = (0.961, 0.620, 0.043)
DANGER = (0.898, 0.282, 0.302)
RULE = (0.894, 0.906, 0.929)
SURFACE = (0.973, 0.980, 1.000)

REGULAR = "helv"
BOLD = "hebo"

LEADING = 1.38

# PyMuPDF's base-14 fonts are WinAnsi-encoded and have no bullet, en-dash or curly-quote
# glyphs; those characters render as a stray dot. Text is therefore transliterated to
# characters the font actually carries, rather than silently printing noise.
_GLYPH_FALLBACKS = {
    "\u2022": "-",
    "\u2023": "-",
    "\u25aa": "-",
    "\u2013": "-",
    "\u2014": "-",
    "\u2018": "'",
    "\u2019": "'",
    "\u201c": '"',
    "\u201d": '"',
    "\u2026": "...",
    "\u00b7": "-",
    "\u2192": "->",
    "\u2265": ">=",
    "\u2264": "<=",
    "\u00a0": " ",
}


def sanitize(text: str) -> str:
    """Maps characters the base-14 fonts cannot draw onto ones they can."""
    for source, replacement in _GLYPH_FALLBACKS.items():
        text = text.replace(source, replacement)
    # Anything still outside WinAnsi would render as a blank box; drop it rather than
    # printing a placeholder in the middle of a citation.
    return "".join(ch if ord(ch) < 0x2000 else "?" for ch in text)


@dataclass
class Cursor:
    page: pymupdf.Page
    y: float


def wrap_lines(text: str, font_name: str, size: float, width: float) -> list[str]:
    """Wraps text to `width` using real glyph widths, honouring explicit newlines."""
    out: list[str] = []
    for paragraph in sanitize(text).split("\n"):
        if not paragraph.strip():
            out.append("")
            continue

        line = ""
        for word in paragraph.split(" "):
            candidate = f"{line} {word}".strip()
            if pymupdf.get_text_length(candidate, fontname=font_name, fontsize=size) <= width:
                line = candidate
                continue
            if line:
                out.append(line)
            # A single word longer than the line is broken by character rather than
            # allowed to overflow the margin.
            while pymupdf.get_text_length(word, fontname=font_name, fontsize=size) > width:
                cut = len(word)
                while (
                    cut > 1
                    and pymupdf.get_text_length(word[:cut], fontname=font_name, fontsize=size) > width
                ):
                    cut -= 1
                out.append(word[:cut])
                word = word[cut:]
            line = word
        if line:
            out.append(line)
    return out


class Document:
    """A paginated document with a measured text cursor."""

    def __init__(self, width: float = 595.0, height: float = 842.0, margin: float = 48.0) -> None:
        self.doc = pymupdf.open()
        self.width = width
        self.height = height
        self.margin = margin
        self.page = self.doc.new_page(width=width, height=height)
        self.y = margin
        self.page_number = 1
        self.footer_text = "UXE Consulting AI"

    @property
    def content_width(self) -> float:
        return self.width - self.margin * 2

    @property
    def bottom(self) -> float:
        return self.height - self.margin - 26

    def new_page(self) -> None:
        self._draw_footer()
        self.page = self.doc.new_page(width=self.width, height=self.height)
        self.page_number += 1
        self.y = self.margin

    def ensure(self, needed: float) -> None:
        if self.y + needed > self.bottom:
            self.new_page()

    def space(self, amount: float) -> None:
        self.y = min(self.y + amount, self.bottom)

    def text(
        self,
        value: str,
        size: float = 10.0,
        color: tuple[float, float, float] = INK,
        bold: bool = False,
        gap: float = 6.0,
        indent: float = 0.0,
        max_width: float | None = None,
    ) -> None:
        """Writes wrapped text, paginating mid-paragraph when necessary.

        Because the lines are measured and drawn individually, a paragraph that spans a page
        boundary continues onto the next page instead of being dropped.
        """
        if not value:
            self.space(gap)
            return

        font = BOLD if bold else REGULAR
        width = (max_width if max_width is not None else self.content_width) - indent
        leading = size * LEADING
        x = self.margin + indent

        for line in wrap_lines(value, font, size, width):
            self.ensure(leading)
            if line:
                # insert_text draws at the baseline, so the cursor is advanced first.
                self.page.insert_text(
                    pymupdf.Point(x, self.y + size),
                    line,
                    fontsize=size,
                    fontname=font,
                    color=color,
                )
            self.y += leading

        self.space(gap)

    def heading(self, value: str, size: float = 14.0, gap: float = 8.0) -> None:
        # Keep a heading with at least two lines of its section rather than stranding it.
        self.ensure(size * LEADING * 3)
        self.text(value, size=size, bold=True, gap=gap)

    def rule(self, gap: float = 12.0) -> None:
        self.ensure(gap + 2)
        self.page.draw_line(
            pymupdf.Point(self.margin, self.y),
            pymupdf.Point(self.width - self.margin, self.y),
            color=RULE,
            width=0.7,
        )
        self.space(gap)

    def pill(self, label: str, color: tuple[float, float, float], gap: float = 12.0) -> None:
        size = 9.0
        label = sanitize(label)
        text_width = pymupdf.get_text_length(label, fontname=BOLD, fontsize=size)
        height = 20.0
        self.ensure(height + gap)
        rect = pymupdf.Rect(self.margin, self.y, self.margin + text_width + 22, self.y + height)
        self.page.draw_rect(rect, color=color, fill=color, radius=0.3)
        self.page.insert_text(
            pymupdf.Point(rect.x0 + 11, rect.y0 + height / 2 + size * 0.36),
            label,
            fontsize=size,
            fontname=BOLD,
            color=(1, 1, 1),
        )
        self.y += height
        self.space(gap)

    def key_values(self, pairs: list[tuple[str, str]], size: float = 9.5, gap: float = 4.0) -> None:
        pairs = [(sanitize(k), sanitize(v)) for k, v in pairs]
        label_width = max(
            (pymupdf.get_text_length(k, fontname=BOLD, fontsize=size) for k, _ in pairs),
            default=0.0,
        ) + 12
        for key, value in pairs:
            leading = size * LEADING
            lines = wrap_lines(value, REGULAR, size, self.content_width - label_width)
            self.ensure(leading * max(1, len(lines)))
            self.page.insert_text(
                pymupdf.Point(self.margin, self.y + size),
                key,
                fontsize=size,
                fontname=BOLD,
                color=MUTED,
            )
            for index, line in enumerate(lines or [""]):
                if index > 0:
                    self.ensure(leading)
                self.page.insert_text(
                    pymupdf.Point(self.margin + label_width, self.y + size),
                    line,
                    fontsize=size,
                    fontname=REGULAR,
                    color=INK,
                )
                self.y += leading
            self.space(gap)

    def panel(self, lines: list[tuple[str, float, tuple[float, float, float], bool]], padding: float = 12.0) -> None:
        """Draws a tinted surface behind a group of lines, keeping them on one page."""
        total = sum(size * LEADING * max(1, len(wrap_lines(text, BOLD if bold else REGULAR, size, self.content_width - padding * 2)))
                    for text, size, _, bold in lines)
        self.ensure(total + padding * 2 + 8)

        top = self.y
        rect = pymupdf.Rect(self.margin, top, self.width - self.margin, top + total + padding * 2)
        self.page.draw_rect(rect, color=SURFACE, fill=SURFACE, radius=0.05)

        self.y = top + padding
        for text, size, color, bold in lines:
            self.text(text, size=size, color=color, bold=bold, gap=0, indent=padding)
        self.y = top + total + padding * 2
        self.space(10)

    def keep_together(self, estimated_height: float) -> None:
        """Starts a new page if `estimated_height` would not fit on the current one.

        Used to stop an evidence row being split so that its heading sits alone at the
        bottom of a page while its finding and citation appear on the next.
        """
        if self.y + estimated_height > self.bottom and self.y > self.margin + 40:
            self.new_page()

    def measure(self, value: str, size: float, bold: bool = False, indent: float = 0.0) -> float:
        """Height this text would occupy, without drawing it."""
        font = BOLD if bold else REGULAR
        lines = wrap_lines(value, font, size, self.content_width - indent)
        return len(lines) * size * LEADING

    def _draw_footer(self) -> None:
        self.page.insert_text(
            pymupdf.Point(self.margin, self.height - 30),
            self.footer_text,
            fontsize=8,
            fontname=REGULAR,
            color=MUTED,
        )
        label = f"Page {self.page_number}"
        width = pymupdf.get_text_length(label, fontname=REGULAR, fontsize=8)
        self.page.insert_text(
            pymupdf.Point(self.width - self.margin - width, self.height - 30),
            label,
            fontsize=8,
            fontname=REGULAR,
            color=MUTED,
        )

    def finish(self) -> bytes:
        self._draw_footer()
        output = self.doc.tobytes(garbage=3, deflate=True)
        self.doc.close()
        return output
