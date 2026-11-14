"""Convert imported documents into the markdown the knowledge base stores.

A teacher's textbook is a PDF or a Word file; the knowledge base only indexes
markdown, so an import converts first and writes ``<stem>.md`` like any other
document. The PDF and Word parsers are optional dependencies and are imported
lazily, so the module itself imports with neither installed.
"""

import hashlib
import io
import os
import re
from collections import Counter

TEXT_SUFFIXES = {".md", ".txt"}
PDF_SUFFIXES = {".pdf"}
DOCX_SUFFIXES = {".docx"}

SCANNED_PDF_ERROR = "PDF 没有可提取的文字层（可能是扫描件）；请先 OCR 或改用可复制文本的 PDF"

_PAGE_MARKER = "---\n\n*第 {number} 页*"
# Characters after which a line break is a wrap, not a word gap.
_CJK_RE = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]")
# python-docx reports the built-in style as "Heading 1"; a document authored in
# Chinese Word stores the localized name, which python-docx hands back verbatim.
_HEADING_STYLE_RE = re.compile(r"^(?:heading|标题)\s*(\d+)$", re.IGNORECASE)
# A running header/footer lives in the top or bottom lines of a page, and a
# page number that changes per page keeps the line from looking repeated.
_MARGIN_ZONE = 2
_REPEAT_RATIO = 0.6


def convert_to_markdown(filename: str, data: bytes, assets=None) -> str:
    """Return markdown for an uploaded textbook page set.

    :param assets: optional ``save(bytes, suffix) -> relative_path`` callback.
        A textbook's figures live inside the PDF; with a callback the converter
        writes them beside the document and references them from the markdown,
        so a page of pictures is not silently dropped.
    :raises ValueError: unsupported suffix, unreadable PDF (no text layer)
    :raises ImportError: the optional parser for that suffix is not installed
    """
    suffix = os.path.splitext(filename or "")[1].lower()
    if suffix in TEXT_SUFFIXES:
        return _text_to_markdown(data)
    if suffix in PDF_SUFFIXES:
        return _pdf_to_markdown(data, assets)
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
def _pdf_to_markdown(data: bytes, assets=None) -> str:
    extract_pages, laparams, _text_container = _load_pdfminer()

    pages, figures, seen_figures = [], [], set()
    for page in extract_pages(io.BytesIO(data), laparams=laparams()):
        pages.append(_page_lines(page))
        figures.append(_page_images(page, assets, seen_figures) if assets else [])

    repeated = _repeated_margin_lines(pages)

    blocks = []
    for number, lines in enumerate(pages, start=1):
        paragraphs = _paragraphs(_strip_margins(lines, repeated))
        images = figures[number - 1]
        if not paragraphs and not images:
            # A blank page keeps its number out of the file.
            continue
        blocks.append(_PAGE_MARKER.format(number=number))
        blocks.extend(paragraphs)
        # A textbook page is often a picture and a caption; without this the
        # reader saw an empty page and called the import "garbled".
        for index, path in enumerate(images, start=1):
            blocks.append(f"![第 {number} 页 图 {index}]({path})")
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


def _page_lines(page) -> list:
    """Split one analysed page into readable lines, top to bottom.

    pdfminer's own line objects are used (not ``get_text()``) because textbook
    PDFs set every glyph as its own text box: splitting that text on newlines
    produced one character per line, which is what "the import is garbled"
    looked like. Fragments sharing a baseline are therefore joined in x order,
    and a vertical run of single glyphs (a CJK title set downwards) is joined
    into one line.
    """
    fragments = []
    for box, element in enumerate(page):
        # The pdfminer text box is the closest thing a PDF has to a paragraph:
        # its boundaries break paragraphs, its interior lines are wrapped text.
        fragments.extend(_text_fragments(element, box))

    # Group by baseline (top to bottom), then split each row into clusters that
    # are close enough to be one line: a two-column page puts two unrelated
    # lines on the same baseline.
    rows, used = [], set()
    for index, (x0, _x1, y0, y1, text, box) in enumerate(fragments):
        if index in used:
            continue
        used.add(index)
        height = max(y1 - y0, 1.0)
        centre = (y0 + y1) / 2
        row = [(x0, _x1, text)]
        for other, (ox0, ox1, oy0, oy1, otext, obox) in enumerate(fragments):
            if other in used:
                continue
            if abs(((oy0 + oy1) / 2) - centre) <= height * 0.5:
                used.add(other)
                row.append((ox0, ox1, otext))
        row.sort()
        for cluster in _clusters(row, height):
            text = _join_fragments(cluster, height)
            if text:
                rows.append((centre, height, text, cluster[0][0], cluster[-1][1]))

    rows = _reading_order(rows)
    if not rows:
        return []
    # A line break is a paragraph break only when the vertical gap is clearly
    # bigger than the leading. Wrapped lines (normal leading) stay together and
    # join into one sentence; over-splitting is the safe direction, because a
    # reader can merge two paragraphs but cannot split a mangled one.
    lines = []
    previous = None
    for centre, height, text, _x0, _x1 in rows:
        if previous is not None:
            prev_centre, prev_height = previous
            if prev_centre - centre > max(prev_height, 1.0) * 1.4:
                lines.append("")
        lines.append(text)
        previous = (centre, height)
    return _merge_vertical_runs(lines)


def _clusters(row, height: float):
    """Split one baseline into runs that are visually one line."""
    cluster = []
    last_x1 = None
    for item in row:
        if last_x1 is not None and item[0] - last_x1 > height * 2.5:
            yield cluster
            cluster = []
        cluster.append(item)
        last_x1 = item[1]
    if cluster:
        yield cluster


def _text_fragments(element, box: int = 0):
    """(x0, x1, y0, y1, text) for every non-empty line inside a container.

    Recursion stops at the line: a line is the unit a PDF means to be read as
    one run of text, and descending into its individual glyphs is what turned
    "body line" into "b o d y".
    """
    try:
        from pdfminer.layout import LTTextLine
    except ImportError:  # pragma: no cover - pdfminer is a hard dependency here
        LTTextLine = ()  # type: ignore[assignment]

    if LTTextLine and isinstance(element, LTTextLine):
        # Rebuild the line from its glyphs. pdfminer's own ``get_text()`` puts a
        # space between glyphs it saw as separately positioned, which is exactly
        # the "one character per line" damage; the glyph positions are truthful.
        glyphs = []
        for child in element:
            text = getattr(child, "get_text", lambda: "")()
            if not text:
                continue
            # LTAnno carries the auto-inserted spaces pdfminer guessed; they
            # are the guess we are replacing, so they are skipped.
            if not hasattr(child, "x0"):
                continue
            if not text.strip():
                text = " "
            glyphs.append((child.x0, child.x1, child.y0, child.y1, text, box))
        return glyphs

    out = []
    for child in getattr(element, "__iter__", lambda: [])():
        out.extend(_text_fragments(child, box))
    if out:
        return out
    # A glyph that pdfminer kept outside any line.
    text = (getattr(element, "get_text", lambda: "")() or "").strip()
    if text and hasattr(element, "x0") and hasattr(element, "x1"):
        return [(element.x0, element.x1, element.y0, element.y1, text, box)]
    return out


def _join_fragments(row, height: float) -> str:
    """Concatenate fragments on one baseline, spacing only real word gaps.

    A glyph-per-box PDF yields ``["义", "务", "教"]``; joining them with spaces
    would spell the title out letter by letter, so a space is only put where the
    x gap between two fragments is wide enough to be a word break.
    """
    text, prev_x1 = "", None
    for x0, x1, part in row:
        stripped = part.strip()
        if not stripped:
            if text and not text.endswith(" "):
                text += " "
            continue
        if text and prev_x1 is not None and not text.endswith(" "):
            # A word break the PDF expressed by position instead of a space
            # glyph: wide enough to be one (a real inter-glyph gap is ~0).
            gap = x0 - prev_x1
            if gap > max(height * 0.28, 1.2) and not (
                _CJK_RE.match(text[-1]) or _CJK_RE.match(stripped[0])
            ):
                text += " "
        text += stripped
        prev_x1 = x1
    return text.strip()


def _reading_order(rows):
    """Top-to-bottom, but column by column when the page is laid out in columns.

    A textbook scan is usually a two-page spread: reading across the gutter
    interleaves the two pages, which is how "SECTION A" ended up glued to a
    sentence from the other page.
    """
    if len(rows) < 6:
        return sorted(rows, key=lambda item: -item[0])
    x0s = [row[3] for row in rows]
    x1s = [row[4] for row in rows]
    left, right = min(x0s), max(x1s)
    if right - left < 1:
        return sorted(rows, key=lambda item: -item[0])
    middle = (left + right) / 2
    crossing = [row for row in rows if row[3] < middle < row[4]]
    if len(crossing) > len(rows) * 0.3:
        return sorted(rows, key=lambda item: -item[0])
    # Two columns: everything that lives on one side of the gutter, in order.
    left_column = [row for row in rows if (row[3] + row[4]) / 2 < middle]
    right_column = [row for row in rows if (row[3] + row[4]) / 2 >= middle]
    return (sorted(left_column, key=lambda item: -item[0])
            + sorted(right_column, key=lambda item: -item[0]))


def _merge_vertical_runs(lines) -> list:
    """Join a column of single CJK glyphs into one line.

    A cover title set top-to-bottom arrives as ``义``, ``务``, ``教`` … one per
    line; keeping that order inside one line is what a reader expects.
    """
    out, run = [], []
    for line in lines:
        stripped = line.strip()
        is_glyph = len(stripped) == 1 and _CJK_RE.match(stripped)
        if is_glyph:
            run.append(stripped)
            continue
        if len(run) > 1:
            out.append("".join(run))
            out.append("")
        elif run:
            out.extend(run)
            out.append("")
        run = []
        out.append(line)
    if len(run) > 1:
        out.append("".join(run))
    elif run:
        out.extend(run)
    return out


_IMAGE_MAGIC = ((b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"),
                (b"GIF8", ".gif"))


def _page_images(page, assets, seen=None) -> list:
    """Save the figures embedded in one page; return their relative paths.

    A PDF stores figures as image XObjects with no file format of their own:
    JPEG ones come out as JPEG bytes, everything else is raw samples that are
    re-encoded as PNG. Undecodable objects are skipped, never fatal.
    """
    paths = []
    seen = seen if seen is not None else set()
    for image in _iter_images(page):
        width, height = getattr(image, "srcsize", (0, 0))
        # Bullets, rules and spacer art are a few pixels across; a figure is not.
        if width * height < 512:
            continue
        saved = _save_image(image)
        if not saved:
            continue
        data, suffix = saved
        if len(data) < 96:
            continue
        digest = hashlib.md5(data).hexdigest()
        if digest in seen:  # the same art embedded once per page
            continue
        seen.add(digest)
        try:
            paths.append(assets(data, suffix))
        except Exception:  # noqa: BLE001 - one bad figure must not kill the import
            continue
    return paths


def _save_image(image):
    """(bytes, suffix) for one XObject, or None when it cannot be decoded."""
    stream = getattr(image, "stream", None)
    if stream is None or getattr(image, "imagemask", False):
        return None
    filters = stream.attrs.get("Filter")
    filters = filters if isinstance(filters, list) else [filters] if filters else []
    # An image with a soft mask, an inverted /Decode array, an ICC profile or an
    # indexed palette is not the bytes it claims: re-encoding those produced the
    # negative-looking strips a teacher saw in the text view. The original page
    # (shown beside it) has the real figure, so these are simply skipped.
    if any(key in stream.attrs for key in ("SMask", "Mask", "Decode", "Indexed")):
        return None
    if "ICCBased" in str(stream.attrs.get("ColorSpace")):
        return None
    try:
        data = stream.get_data()
    except Exception:  # noqa: BLE001 - a broken XObject is skipped
        return None
    if not data:
        return None
    for magic, suffix in _IMAGE_MAGIC:
        if data.startswith(magic):
            return data, suffix
    if any(str(name).endswith("DCTDecode") for name in filters):
        return data, ".jpg"
    return _raw_samples_to_png(image, stream, data)


def _raw_samples_to_png(image, stream, data):
    width, height = getattr(image, "srcsize", (0, 0))
    if not width or not height:
        return None
    bits = stream.attrs.get("BitsPerComponent", 8)
    # pdfminer hands back a PSLiteral (``/'DeviceRGB'``) or a list for
    # ICCBased colour spaces; only the named device spaces map to a PIL mode.
    colorspace = stream.attrs.get("ColorSpace")
    name = getattr(colorspace, "name", None)
    if not name:
        pieces = colorspace if isinstance(colorspace, list) else [colorspace]
        name = next((str(piece).lstrip("/'") for piece in pieces
                     if str(piece).lstrip("/'").startswith("Device")), "")
    mode = {"DeviceRGB": "RGB", "DeviceGray": "L", "DeviceCMYK": "CMYK"}.get(name or "")
    if not mode or bits != 8:
        return None
    try:
        from PIL import Image

        picture = Image.frombytes(mode, (int(width), int(height)), data)
        if mode == "CMYK":
            picture = picture.convert("RGB")
        buffer = io.BytesIO()
        picture.save(buffer, format="PNG")
        return buffer.getvalue(), ".png"
    except Exception:  # noqa: BLE001 - PIL missing or unexpected sample layout
        return None


def _iter_images(element):
    from pdfminer.layout import LTImage

    if isinstance(element, LTImage):
        yield element
        return
    for child in getattr(element, "__iter__", lambda: [])():
        yield from _iter_images(child)


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
