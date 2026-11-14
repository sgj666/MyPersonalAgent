"""PDF / Word textbooks become markdown on import.

The PDF fixture is written by hand: the suite must not depend on reportlab, and
a PDF with a text layer is a few objects and an xref away.
"""
import io
import sys

import pytest

from agent.knowledge.convert import convert_to_markdown
from agent.knowledge.service import KnowledgeService


class FakeStorage:
    def delete_by_path(self, path):
        pass


class FakeMemoryManager:
    def __init__(self):
        self.storage = FakeStorage()

    def mark_dirty(self):
        pass

    async def sync(self):
        pass


def _escape_pdf_text(line):
    return line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _content_stream(lines, leading):
    parts = ["BT", "/F1 12 Tf", "72 720 Td", f"{leading} TL"]
    for line in lines:
        parts.append(f"({_escape_pdf_text(line)}) Tj")
        parts.append("T*")
    parts.append("ET")
    return ("\n".join(parts) + "\n").encode("latin-1")


def _pdf_bytes(pages, leading=18):
    """A minimal one-column PDF where ``pages`` is a list of line lists.

    ``leading`` close to the font size keeps consecutive lines in one text box,
    which is how pdfminer models a wrapped paragraph.
    """
    objects = {}
    page_ids = []
    next_id = 4
    for _ in pages:
        page_ids.append(next_id)
        next_id += 2
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (
        " ".join(f"{page_id} 0 R" for page_id in page_ids), len(pages))).encode("ascii")
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    for index, lines in enumerate(pages):
        page_id = page_ids[index]
        content_id = page_id + 1
        stream = _content_stream(lines, leading)
        objects[page_id] = (
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % content_id
        ).encode("ascii")
        objects[content_id] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for object_id in sorted(objects):
        offsets[object_id] = len(out)
        out += b"%d 0 obj\n" % object_id + objects[object_id] + b"\nendobj\n"
    xref_at = len(out)
    size = max(objects) + 1
    out += b"xref\n0 %d\n" % size + b"0000000000 65535 f \n"
    for object_id in range(1, size):
        out += b"%010d 00000 n \n" % offsets[object_id]
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref_at)
    return bytes(out)


def _service(tmp_path):
    (tmp_path / "knowledge" / "教材").mkdir(parents=True)
    return KnowledgeService(str(tmp_path), FakeMemoryManager())



def _wait_for_import(svc, timeout=10.0):
    """PDF/Word imports convert in the background now; wait for the job."""
    import time

    end = time.time() + timeout
    while time.time() < end:
        jobs = svc.import_jobs()["jobs"]
        if jobs and jobs[0]["status"] in ("done", "failed", "skipped"):
            return jobs[0]
        time.sleep(0.05)
    raise AssertionError("import job did not finish")


def test_pdf_textbook_is_imported_as_markdown(tmp_path):
    pytest.importorskip("pdfminer.high_level")
    svc = _service(tmp_path)
    pdf = _pdf_bytes([["Unit 1 My new school", "This unit talks about the first day."]])

    result = svc.import_documents("教材", [{"filename": "Unit-01.pdf", "content": pdf}])

    # Queued, not converted on the request thread.
    assert result["queued"] == 1
    assert result["results"][0]["status"] == "queued"
    job = _wait_for_import(svc)
    assert job["status"] == "done", job
    assert result["results"][0]["path"] == "教材/Unit-01.md"
    md = tmp_path / "knowledge" / "教材" / "Unit-01.md"
    assert not (md.parent / "Unit-01.pdf").exists()
    content = md.read_text(encoding="utf-8")
    assert content.startswith("<!-- page 1 -->")
    assert "Unit 1 My new school" in content
    assert "This unit talks about the first day." in content


def test_wrapped_pdf_lines_join_into_one_paragraph():
    pytest.importorskip("pdfminer.high_level")
    # 14pt leading on 12pt text keeps both lines in one text box: the newline
    # is the page margin, not a sentence break.
    pdf = _pdf_bytes([["This unit talks about", "the first day at school."]], leading=14)

    content = convert_to_markdown("Unit-01.pdf", pdf)

    assert "This unit talks about the first day at school." in content


def test_page_marker_is_only_written_for_pages_with_text():
    pytest.importorskip("pdfminer.high_level")
    # A scanned cover followed by a text page: page 1 keeps no marker, so the
    # page numbers in the file still match the book.
    pdf = _pdf_bytes([[], ["Chapter 1"]], leading=14)

    content = convert_to_markdown("Unit-01.pdf", pdf)

    assert "<!-- page 1 -->" not in content
    assert "<!-- page 2 -->" in content


def test_repeated_page_headers_and_footers_are_dropped():
    pytest.importorskip("pdfminer.high_level")
    pages = [
        ["English Grade 7", f"body line {number}", "page footer"]
        for number in range(1, 4)
    ]

    content = convert_to_markdown("book.pdf", _pdf_bytes(pages))

    assert "English Grade 7" not in content
    assert "page footer" not in content
    assert "body line 1" in content and "body line 3" in content
    assert "<!-- page 2 -->" in content


def test_scanned_pdf_without_a_text_layer_is_rejected(tmp_path):
    pytest.importorskip("pdfminer.high_level")
    # A page with no text objects at all: what a scan looks like to a parser.
    scanned = _pdf_bytes([[]])

    with pytest.raises(ValueError) as raised:
        convert_to_markdown("scan.pdf", scanned)
    assert "扫描件" in str(raised.value)

    svc = _service(tmp_path)
    result = svc.import_documents("教材", [{"filename": "scan.pdf", "content": scanned}])
    # Queued; the failure lands on the job, and no file is written.
    assert result["queued"] == 1
    job = _wait_for_import(svc)
    assert job["status"] == "failed"
    assert "扫描件" in job["reason"]
    assert not list((tmp_path / "knowledge" / "教材").glob('*.md'))


def test_docx_textbook_keeps_headings_paragraphs_and_tables(tmp_path):
    docx = pytest.importorskip("docx")
    svc = _service(tmp_path)
    document = docx.Document()
    document.add_heading("Unit 1 My new school", level=1)
    document.add_paragraph("This unit talks about the first day.")
    document.add_heading("Lesson 1", level=2)
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Word"
    table.cell(0, 1).text = "Meaning"
    table.cell(1, 0).text = "school"
    table.cell(1, 1).text = "学校 | place"
    buffer = io.BytesIO()
    document.save(buffer)

    result = svc.import_documents("教材", [{"filename": "Unit-01.docx", "content": buffer.getvalue()}])

    assert result["queued"] == 1
    assert _wait_for_import(svc)["status"] == "done"
    md = tmp_path / "knowledge" / "教材" / "Unit-01.md"
    assert md.read_text(encoding="utf-8") == (
        "## Unit 1 My new school\n"
        "\n"
        "This unit talks about the first day.\n"
        "\n"
        "### Lesson 1\n"
        "\n"
        "| Word | Meaning |\n"
        "| --- | --- |\n"
        "| school | 学校 \\| place |\n"
    )


def test_plain_text_keeps_its_content_and_drops_a_bom():
    assert convert_to_markdown("notes.txt", b"\xef\xbb\xbf# Notes\n") == "# Notes\n"
    assert convert_to_markdown("notes.md", "# Notes".encode("utf-8")) == "# Notes"


def test_unsupported_suffix_is_rejected():
    with pytest.raises(ValueError, match="unsupported file type: .doc"):
        convert_to_markdown("book.doc", b"\xd0\xcf\x11\xe0")


def test_missing_pdf_parser_names_the_install_command(monkeypatch):
    monkeypatch.setitem(sys.modules, "pdfminer.high_level", None)

    with pytest.raises(ImportError, match="pip install pdfminer.six"):
        convert_to_markdown("book.pdf", _pdf_bytes([["text"]]))


def _pdf_with_image(page_text):
    """One page with a text line and a 40×40 RGB XObject (a textbook figure)."""
    width = height = 40
    raw = bytes(b for y in range(height) for x in range(width)
                for b in (x * 6 % 256, y * 6 % 256, 128))
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> "
            b"/Contents 4 0 R >>"),
        4: (lambda stream: (f"<< /Length {len(stream)} >>\nstream\n".encode("ascii")
                            + stream + b"\nendstream"))(_image_page_content(page_text)),
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        6: (f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} "
            f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length {len(raw)} >>\nstream\n").encode("ascii")
           + raw + b"\nendstream",
    }
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode("ascii") + objects[number] + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    out += b"0000000000 65535 f \n"
    for number in sorted(objects):
        out += f"{offsets[number]:010d} 00000 n \n".encode("ascii")
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("ascii")
    return bytes(out)


def _image_page_content(page_text):
    return (b"BT /F1 12 Tf 72 720 Td (" + page_text.encode("latin-1") + b") Tj ET\n"
            b"q 120 0 0 120 72 560 cm /Im1 Do Q")


def test_pdf_figures_are_saved_beside_the_document(tmp_path):
    pytest.importorskip("pdfminer.high_level")
    svc = _service(tmp_path)
    pdf = _pdf_with_image("Unit 1 My new school")

    result = svc.import_documents("教材", [{"filename": "Unit-01.pdf", "content": pdf}])
    assert result["queued"] == 1
    assert _wait_for_import(svc)["status"] == "done"

    md = tmp_path / "knowledge" / "教材" / "Unit-01.md"
    content = md.read_text(encoding="utf-8")
    assert "Unit 1 My new school" in content
    # The figure is referenced relatively and the files exist beside the doc.
    assert "![第 1 页 图 1](.Unit-01.assets/figure-1.png)" in content
    figures = list((tmp_path / "knowledge" / "教材" / ".Unit-01.assets").glob("figure-*.png"))
    assert figures and figures[0].stat().st_size > 100
    # The hidden folder is not a category in the tree.
    tree = svc.list_tree()
    assert all(not item["dir"].endswith(".assets") for item in tree["tree"])


def _glyph_per_box_pdf(chars, step=7):
    """A page that sets every CJK glyph as its own text box (what a textbook
    exported from a layout tool looks like), one glyph after another."""
    parts = ["BT", "/F1 12 Tf"]
    x = 72
    for char in chars:
        parts.append(f"1 0 0 1 {x} 720 Tm ({_escape_pdf_text(char)}) Tj")
        x += step * (2 if char == " " else 1)
    parts.append("ET")
    stream = ("\n".join(parts) + "\n").encode("latin-1")
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        4: f"<< /Length {len(stream)} >>\nstream\n".encode("ascii") + stream + b"\nendstream",
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    }
    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode("ascii") + objects[number] + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("ascii") + b"0000000000 65535 f \n"
    for number in sorted(objects):
        out += f"{offsets[number]:010d} 00000 n \n".encode("ascii")
    out += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("ascii")
    return bytes(out)


def test_a_glyph_per_box_pdf_reads_as_one_line():
    """Regression: the first version split on newlines, so a textbook exported
    glyph-by-glyph imported as one character per line and looked garbled.

    The fixture uses latin glyphs (a WinAnsi fixture cannot carry CJK); the
    merge it exercises is the same one that turns 义 务 教 育 back into
    义务教育.
    """
    pytest.importorskip("pdfminer.high_level")
    pdf = _glyph_per_box_pdf("My school")
    content = convert_to_markdown("book.pdf", pdf)
    assert "My school" in content
    assert "M y s c h o o l" not in content
