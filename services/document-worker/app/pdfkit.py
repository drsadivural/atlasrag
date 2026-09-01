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

# Report furniture: the running head, section numbering, table chrome and callouts.
NAVY = (0.106, 0.196, 0.325)
HEADING = (0.098, 0.278, 0.522)
ZEBRA = (0.969, 0.973, 0.980)
LABEL_CELL = (0.937, 0.945, 0.957)
CALLOUT_TINTS = {
    "danger": ((0.992, 0.949, 0.957), (0.898, 0.749, 0.780)),
    "warning": ((1.000, 0.980, 0.918), (0.902, 0.831, 0.639)),
    "neutral": ((0.969, 0.973, 0.980), (0.847, 0.867, 0.898)),
}

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

    def __init__(
        self,
        width: float = 595.0,
        height: float = 842.0,
        margin: float = 48.0,
        header_left: str = "",
        header_right: str = "",
        footer_text: str = "UXE Consulting AI",
    ) -> None:
        self.doc = pymupdf.open()
        self.width = width
        self.height = height
        self.margin = margin
        self.page = self.doc.new_page(width=width, height=height)
        self.page_number = 1
        self.footer_text = footer_text
        # Constructor arguments, not attributes assigned afterwards: the first page's head
        # is drawn here, so setting them later would leave page one bare and every page
        # after it correct - the kind of difference nobody notices until it is printed.
        self.header_left = header_left
        self.header_right = header_right
        self.y = margin
        self._draw_header()

    @property
    def header_height(self) -> float:
        return 26.0 if (self.header_left or self.header_right) else 0.0

    def _draw_header(self) -> None:
        """Draws the running head, and leaves the cursor below it.

        Called for every page including the first, so the band is identical throughout
        rather than appearing from page two onward.
        """
        if not (self.header_left or self.header_right):
            return
        top = self.margin - 12
        if self.header_left:
            self.page.insert_text(
                pymupdf.Point(self.margin, top),
                sanitize(self.header_left.upper()),
                fontsize=7.5,
                fontname=BOLD,
                color=NAVY,
            )
        if self.header_right:
            label = sanitize(self.header_right)
            width = pymupdf.get_text_length(label, fontname=REGULAR, fontsize=7.5)
            self.page.insert_text(
                pymupdf.Point(self.width - self.margin - width, top),
                label,
                fontsize=7.5,
                fontname=REGULAR,
                color=MUTED,
            )
        self.page.draw_line(
            pymupdf.Point(self.margin, top + 6),
            pymupdf.Point(self.width - self.margin, top + 6),
            color=NAVY,
            width=0.8,
        )
        self.y = top + 6 + 18

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
        self._draw_header()

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

    def section(self, number: int | None, title: str, gap: float = 8.0) -> None:
        """A numbered section heading, in the report's heading colour."""
        label = f"{number}. {title}" if number is not None else title
        self.ensure(13 * LEADING * 3)
        self.text(label, size=12.5, color=HEADING, bold=True, gap=gap)

    def meta_table(self, pairs: list[tuple[str, str]], label_ratio: float = 0.26) -> None:
        """A bordered two-column table: shaded label cell, plain value cell.

        Used for the block at the head of a report that says what the document is, what it
        was built from and what it concluded, in a form a reader can scan rather than a
        paragraph they have to parse.
        """
        padding = 7.0
        size = 9.0
        label_width = self.content_width * label_ratio
        value_width = self.content_width - label_width

        for key, value in pairs:
            key_lines = wrap_lines(sanitize(key), BOLD, size, label_width - padding * 2)
            value_lines = wrap_lines(sanitize(value), REGULAR, size, value_width - padding * 2)
            rows = max(len(key_lines), len(value_lines), 1)
            height = rows * size * LEADING + padding * 2

            # A key/value pair split across a page break is unreadable, so it moves whole.
            self.keep_together(height)
            self.ensure(height)

            top = self.y
            left = pymupdf.Rect(self.margin, top, self.margin + label_width, top + height)
            right = pymupdf.Rect(
                self.margin + label_width, top, self.width - self.margin, top + height
            )
            self.page.draw_rect(left, color=RULE, fill=LABEL_CELL, width=0.7)
            self.page.draw_rect(right, color=RULE, fill=(1, 1, 1), width=0.7)

            for index, line in enumerate(key_lines):
                self.page.insert_text(
                    pymupdf.Point(left.x0 + padding, top + padding + size + index * size * LEADING),
                    line,
                    fontsize=size,
                    fontname=BOLD,
                    color=INK,
                )
            for index, line in enumerate(value_lines):
                self.page.insert_text(
                    pymupdf.Point(right.x0 + padding, top + padding + size + index * size * LEADING),
                    line,
                    fontsize=size,
                    fontname=REGULAR,
                    color=INK,
                )
            self.y = top + height
        self.space(12)

    def table(
        self,
        headers: list[str],
        rows: list[list[str]],
        widths: list[float],
        emphasis: list[int] | None = None,
    ) -> None:
        """A table with a dark header band and zebra body rows.

        `widths` are fractions of the content width and are normalised, so a caller cannot
        silently produce a table narrower or wider than the page. `emphasis` names the
        column indexes to set in bold — the verdict column, typically.
        """
        if not rows:
            return
        padding = 6.0
        size = 8.5
        emphasis = emphasis or []
        total = sum(widths) or 1.0
        cols = [self.content_width * (w / total) for w in widths]

        def draw_header() -> None:
            height = size * LEADING + padding * 2
            self.ensure(height + size * LEADING * 2)
            top = self.y
            self.page.draw_rect(
                pymupdf.Rect(self.margin, top, self.width - self.margin, top + height),
                color=NAVY,
                fill=NAVY,
            )
            x = self.margin
            for index, header in enumerate(headers):
                self.page.insert_text(
                    pymupdf.Point(x + padding, top + padding + size),
                    sanitize(header),
                    fontsize=size,
                    fontname=BOLD,
                    color=(1, 1, 1),
                )
                x += cols[index]
            self.y = top + height

        draw_header()

        for row_index, row in enumerate(rows):
            wrapped = [
                wrap_lines(sanitize(cell), BOLD if i in emphasis else REGULAR, size, cols[i] - padding * 2)
                for i, cell in enumerate(row)
            ]
            lines = max((len(cell) for cell in wrapped), default=1)
            height = max(lines, 1) * size * LEADING + padding * 2

            # A row taller than the page cannot be kept whole; everything else is, and the
            # header is redrawn so a continued table is still readable.
            if self.y + height > self.bottom and height < self.bottom - self.margin:
                self.new_page()
                draw_header()

            top = self.y
            if row_index % 2 == 1:
                self.page.draw_rect(
                    pymupdf.Rect(self.margin, top, self.width - self.margin, top + height),
                    color=ZEBRA,
                    fill=ZEBRA,
                )
            x = self.margin
            for index, cell in enumerate(wrapped):
                for line_index, line in enumerate(cell):
                    self.page.insert_text(
                        pymupdf.Point(
                            x + padding, top + padding + size + line_index * size * LEADING
                        ),
                        line,
                        fontsize=size,
                        fontname=BOLD if index in emphasis else REGULAR,
                        color=INK,
                    )
                x += cols[index]
            self.y = top + height
            self.page.draw_line(
                pymupdf.Point(self.margin, self.y),
                pymupdf.Point(self.width - self.margin, self.y),
                color=RULE,
                width=0.5,
            )
        self.space(12)

    def callout(self, title: str, body: str, tone: str = "neutral") -> None:
        """A bordered, tinted box for something the reader must not skim past."""
        fill, border = CALLOUT_TINTS.get(tone, CALLOUT_TINTS["neutral"])
        padding = 10.0
        size = 9.0
        inner = self.content_width - padding * 2

        title_width = pymupdf.get_text_length(sanitize(f"{title} "), fontname=BOLD, fontsize=size)
        # The title runs into the body on one line, so the first line is short by its width.
        first, *rest = wrap_lines(sanitize(body), REGULAR, size, inner - title_width) or [""]
        remainder = wrap_lines(" ".join(rest), REGULAR, size, inner) if rest else []
        lines = 1 + len(remainder)
        height = lines * size * LEADING + padding * 2

        self.keep_together(height)
        self.ensure(height)
        top = self.y
        self.page.draw_rect(
            pymupdf.Rect(self.margin, top, self.width - self.margin, top + height),
            color=border,
            fill=fill,
            width=0.8,
        )
        self.page.insert_text(
            pymupdf.Point(self.margin + padding, top + padding + size),
            sanitize(f"{title} "),
            fontsize=size,
            fontname=BOLD,
            color=INK,
        )
        self.page.insert_text(
            pymupdf.Point(self.margin + padding + title_width, top + padding + size),
            first,
            fontsize=size,
            fontname=REGULAR,
            color=INK,
        )
        for index, line in enumerate(remainder, start=1):
            self.page.insert_text(
                pymupdf.Point(self.margin + padding, top + padding + size + index * size * LEADING),
                line,
                fontsize=size,
                fontname=REGULAR,
                color=INK,
            )
        self.y = top + height
        self.space(12)

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
        if self.header_left or self.header_right:
            self.page.draw_line(
                pymupdf.Point(self.margin, self.height - 42),
                pymupdf.Point(self.width - self.margin, self.height - 42),
                color=RULE,
                width=0.7,
            )
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
