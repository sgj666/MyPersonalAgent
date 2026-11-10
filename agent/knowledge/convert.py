"""Convert imported documents into the markdown the knowledge base stores.

A teacher's textbook is a PDF or a Word file; the knowledge base only indexes
markdown, so an import converts first and writes ``<stem>.md`` like any other
document. The PDF and Word parsers are optional dependencies and are imported
lazily, so the module itself imports with neither installed.
"""

import io
import os
import re
from collections import Counter

TEXT_SUFFIXES = {".md", ".txt"}
PDF_SUFFIXES = {".pdf"}
DOCX_SUFFIXES = {".docx"}

SCANNED_PDF_ERROR = "PDF 没有可提取的文字层（可能是扫描件）；请先 OCR 或改用可复制文本的 PDF"

_PAGE_MARKER = "<!-- page {number} -->"
# Characters after which a line break is a wrap, not a word gap.
_CJK_RE = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]")
# python-docx reports the built-in style as "Heading 1"; a document authored in
# Chinese Word stores the localized name, which python-docx hands back verbatim.
_HEADING_STYLE_RE = re.compile(r"^(?:heading|标题)\s*(\d+)$", re.IGNORECASE)
# A running header/footer lives in the top or bottom lines of a page, and a
# page number that changes per page keeps the line from looking repeated.
_MARGIN_ZONE = 2
_REPEAT_RATIO = 0.6


def convert_to_markdown(filename: str, data: bytes) -> str:
    """Return markdown for an uploaded textbook page set.

    :raises ValueError: unsupported suffix, unreadable PDF (no text layer)
    :raises ImportError: the optional parser for that suffix is not installed
    """
    suffix = os.path.splitext(filename or "")[1].lower()
    if suffix in TEXT_SUFFIXES:
        return _text_to_markdown(data)
    if suffix in PDF_SUFFIXES:
        return _pdf_to_markdown(data)
    if suffix in DOCX_SUFFIXES:
        return _docx_to_markdown(data)
    raise ValueError(f"unsupported file type: {suffix or filename}")


# ----------------------------------------------------------------------
# text — unchanged apart from the BOM a Windows editor writes
# ----------------------------------------------------------------------
def _text_to_markdown(data) -> str:
    if isinstance(data, str):
        return data
    # Match the service's existing import path: a file that is not valid UTF-8
    # is imported with replacement characters instead of aborting the batch.
    return bytes(data).decode("utf-8-sig", errors="replace")


# ----------------------------------------------------------------------
# pdf
# ----------------------------------------------------------------------
def _pdf_to_markdown(data: bytes) -> str:
    extract_pages, laparams, text_container = _load_pdfminer()

    pages = [_page_lines(page, text_container)
             for page in extract_pages(io.BytesIO(data), laparams=laparams())]
    repeated = _repeated_margin_lines(pages)

    blocks = []
    for number, lines in enumerate(pages, start=1):
        paragraphs = _paragraphs(_strip_margins(lines, repeated))
        if not paragraphs:
            # A cover or an image-only page keeps its number out of the file.
            continue
        blocks.append(_PAGE_MARKER.format(number=number))
        blocks.extend(paragraphs)
    if not blocks:
        raise ValueError(SCANNED_PDF_ERROR)
    return "\n\n".join(blocks) + "\n"


def _load_pdfminer():
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LAParams, LTTextContainer
    except ImportError as exc:
        raise ImportError(
            "PDF import requires pdfminer.six; run: pip install pdfminer.six"
        ) from exc
    # LAParams() is the default analysis; passing it explicitly documents that
    # the layout analysis is what produces the per-line text below.
    return extract_pages, LAParams, LTTextContainer


def _page_lines(page, text_container) -> list:
    """Split one analysed page into stripped lines, top to bottom.

    pdfminer has already ordered the text boxes, so the page order is kept
    instead of re-sorting — a re-sort would interleave the columns of a
    two-column page. Each text box ends with an empty line: pdfminer groups
    lines into a box by vertical proximity, so a box boundary is the closest
    thing a PDF has to a paragraph break.
    """
    lines = []
    for element in page:
        if not isinstance(element, text_container):
            continue
        lines.extend(line.strip() for line in element.get_text().splitlines())
        lines.append("")
    return lines


def _repeated_margin_lines(pages) -> set:
    """Lines printed in the header/footer zone of most pages.

    Dropping them by content alone would eat body text that happens to repeat;
    the check only considers the first and last lines of each page, which is
    where a running header/footer lives.
    """
    if len(pages) < 2:
        return set()
    counts = Counter()
    for lines in pages:
        counts.update(set(_margin_lines(lines)))
    threshold = _REPEAT_RATIO * len(pages)
    return {line for line, count in counts.items() if count > threshold}


def _margin_lines(lines) -> list:
    nonempty = [line for line in lines if line]
    return nonempty[:_MARGIN_ZONE] + nonempty[-_MARGIN_ZONE:]


def _strip_margins(lines, repeated: set) -> list:
    if not repeated:
        return lines
    nonempty = [index for index, line in enumerate(lines) if line]
    margin = set(nonempty[:_MARGIN_ZONE]) | set(nonempty[-_MARGIN_ZONE:])
    return [
        "" if index in margin and line in repeated else line
        for index, line in enumerate(lines)
    ]


def _paragraphs(lines) -> list:
    """Join wrapped lines, using blank lines as the paragraph boundary."""
    paragraphs = []
    buffer = []
    for line in lines:
        if not line:
            if buffer:
                paragraphs.append(_join_wrapped(buffer))
                buffer = []
            continue
        buffer.append(line)
    if buffer:
        paragraphs.append(_join_wrapped(buffer))
    return paragraphs


def _join_wrapped(lines) -> str:
    # A PDF wraps at the margin; the newline is layout, not content. Chinese
    # text must not gain a space at the wrap, or every paragraph reads wrong.
    text = lines[0]
    for line in lines[1:]:
        separator = "" if _CJK_RE.match(text[-1]) or _CJK_RE.match(line[0]) else " "
        text = f"{text}{separator}{line}"
    return text


# ----------------------------------------------------------------------
# docx
# ----------------------------------------------------------------------
def _docx_to_markdown(data: bytes) -> str:
    try:
        from docx import Document
        from docx.oxml.ns import qn
        from docx.table import Table
        from docx.text.paragraph import Paragraph
    except ImportError as exc:
        raise ImportError(
            "Word import requires python-docx; run: pip install python-docx"
        ) from exc
    # Shares the read tool's paragraph extraction so inline content controls
    # and field text are not silently dropped from a textbook page.
    from common.office_text import _docx_paragraph_text

    document = Document(io.BytesIO(data))
    blocks = []
    for element in document.element.body.iterchildren():
        if element.tag == qn("w:p"):
            text = _docx_paragraph_text(element, document).strip()
            if not text:
                continue
            level = _heading_level(Paragraph(element, document))
            blocks.append(f"{'#' * level} {text}" if level else text)
        elif element.tag == qn("w:tbl"):
            table = _table_to_markdown(Table(element, document))
            if table:
                blocks.append(table)
    return ("\n\n".join(blocks) + "\n") if blocks else ""


def _heading_level(paragraph) -> int:
    """Markdown level for a paragraph style, or 0 when it is body text.

    "Heading 1" becomes ``##`` because ``#`` is the document title the
    knowledge index reads for its listing.
    """
    style = getattr(paragraph, "style", None)
    name = (getattr(style, "name", "") or "").strip()
    match = _HEADING_STYLE_RE.match(name)
    if not match:
        return 0
    return min(int(match.group(1)) + 1, 6)


def _table_to_markdown(table) -> str:
    rows = []
    for row in table.rows:
        values = []
        seen = set()
        for cell in row.cells:
            # python-docx repeats the same XML cell for every grid slot a
            # merged cell covers; keep the slot empty instead of duplicating.
            if cell._tc in seen:
                values.append("")
                continue
            seen.add(cell._tc)
            values.append(_cell_text(cell))
        rows.append(values)
    rows = [row for row in rows if any(value.strip() for value in row)]
    if not rows:
        return ""

    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    lines = [
        "| " + " | ".join(rows[0]) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    for row in rows[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _cell_text(cell) -> str:
    parts = ["<br>".join(part for part in paragraph.text.splitlines() if part.strip())
             for paragraph in cell.paragraphs]
    text = "<br>".join(part for part in parts if part)
    # An unescaped pipe would split the cell into two columns.
    return text.replace("|", "\\|")
