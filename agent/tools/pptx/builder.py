"""Build a 16:9 .pptx deck from a plain dict spec, offline.

Everything is drawn as plain shapes and text boxes on the blank layout: no
Office install, no bundled .potx template, no network. Only two fonts are ever
named (Calibri for Latin, 等线 for CJK) and nothing is embedded, so the file
opens the same on a machine without the original author's fonts.

The spec, as produced by the courseware-ppt skill::

    {
        "title": "Unit 3 My weekend plan",
        "subtitle": "人教版 七年级上 · 第 2 课时",     # optional
        "theme": "lecture" | "activity" | "review",
        "slides": [
            {"title": "教学目标", "bullets": ["…", "…"], "notes": "…"}  # notes optional
        ],
    }

A title slide is generated from ``title``/``subtitle``; one content slide is
generated per ``slides`` entry.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt
from pptx.oxml.xmlchemy import OxmlElement

from agent.tools.pptx.themes import THEMES, Theme

# 16:9, exact EMU rather than truncated inches.
SLIDE_WIDTH = Emu(12192000)   # 13.333 in
SLIDE_HEIGHT = Emu(6858000)   # 7.5 in

FONT_LATIN = "Calibri"
FONT_EA = "等线"

MAX_SLIDES = 40
MAX_BULLET_CHARS = 200

_BLANK_LAYOUT = 6


def build_deck(spec: Dict[str, Any], out_path: str) -> str:
    """Render ``spec`` to ``out_path`` and return the absolute path written.

    Raises ValueError when the spec cannot become a usable deck: not a dict, no
    title, no slides, more than 40 slides, a bullet over 200 characters, or a
    theme/font-irrelevant field of the wrong type.
    """
    title, subtitle, theme, slides = _normalize(spec)
    if not isinstance(out_path, (str, os.PathLike)) or not os.fspath(out_path).strip():
        raise ValueError("out_path must be a non-empty path")

    prs = Presentation()
    prs.slide_width = SLIDE_WIDTH
    prs.slide_height = SLIDE_HEIGHT

    _add_title_slide(prs, theme, title, subtitle)
    for number, entry in enumerate(slides, start=2):
        _add_content_slide(prs, theme, entry, number)

    path = os.path.abspath(os.fspath(out_path))
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    prs.save(path)
    return path


# ---------------------------------------------------------------- validation

def _normalize(spec: Dict[str, Any]):
    if not isinstance(spec, dict):
        raise ValueError("spec must be an object")

    title = spec.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("spec.title is required and must be non-empty text")

    subtitle = spec.get("subtitle")
    if subtitle is not None and not isinstance(subtitle, str):
        raise ValueError("spec.subtitle must be text")

    theme_key = spec.get("theme", "lecture")
    if not isinstance(theme_key, str) or theme_key not in THEMES:
        raise ValueError("spec.theme must be one of: " + ", ".join(sorted(THEMES)))

    raw_slides = spec.get("slides")
    if not isinstance(raw_slides, list) or not raw_slides:
        raise ValueError("spec.slides must be a non-empty list")
    if len(raw_slides) > MAX_SLIDES:
        raise ValueError(
            f"spec.slides has {len(raw_slides)} entries; at most {MAX_SLIDES} are allowed"
        )

    slides: List[Dict[str, Any]] = []
    for index, raw in enumerate(raw_slides):
        where = f"spec.slides[{index}]"
        if not isinstance(raw, dict):
            raise ValueError(f"{where} must be an object")

        slide_title = raw.get("title")
        if not isinstance(slide_title, str) or not slide_title.strip():
            raise ValueError(f"{where}.title is required and must be non-empty text")

        bullets = raw.get("bullets", [])
        if not isinstance(bullets, list):
            raise ValueError(f"{where}.bullets must be a list of strings")
        clean_bullets = []
        for position, bullet in enumerate(bullets):
            label = f"{where}.bullets[{position}]"
            if not isinstance(bullet, str):
                raise ValueError(f"{label} must be text")
            text = " ".join(bullet.split())
            if not text:
                raise ValueError(f"{label} is empty")
            if len(text) > MAX_BULLET_CHARS:
                raise ValueError(
                    f"{label} is {len(text)} characters; the limit is {MAX_BULLET_CHARS}"
                )
            clean_bullets.append(text)

        notes = raw.get("notes")
        if notes is not None and not isinstance(notes, str):
            raise ValueError(f"{where}.notes must be text")

        slides.append({
            "title": slide_title.strip(),
            "bullets": clean_bullets,
            "notes": notes.strip() if isinstance(notes, str) and notes.strip() else None,
        })

    return title.strip(), (subtitle or "").strip(), THEMES[theme_key], slides


# ------------------------------------------------------------------- drawing

def _rgb(hex_value: str) -> RGBColor:
    return RGBColor.from_string(hex_value)


def _style(run, size: int, color: RGBColor, bold: bool = False) -> None:
    font = run.font
    font.name = FONT_LATIN
    font.size = Pt(size)
    font.bold = bold
    font.color.rgb = color
    _set_east_asian_font(run)


def _set_east_asian_font(run) -> None:
    """Name 等线 for CJK runs.

    python-pptx only exposes ``a:latin``; without ``a:ea`` PowerPoint falls back
    to the theme's CJK font and the deck's typography splits in two.
    """
    rPr = run._r.get_or_add_rPr()
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = OxmlElement("a:ea")
        latin = rPr.find(qn("a:latin"))
        if latin is not None:
            latin.addnext(ea)
        else:
            rPr.append(ea)
    ea.set("typeface", FONT_EA)


def _text_box(slide, left, top, width, height):
    box = slide.shapes.add_textbox(left, top, width, height)
    frame = box.text_frame
    frame.word_wrap = True
    return frame


def _rect(slide, left, top, width, height, color: RGBColor) -> None:
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    shape.fill.solid()
    shape.fill.fore_color.rgb = color
    shape.line.fill.background()
    shape.shadow.inherit = False


def _set_bullet(paragraph, color: RGBColor) -> None:
    """Draw a real • bullet with hanging indent, so wrapped lines align."""
    pPr = paragraph._p.get_or_add_pPr()
    indent = int(Inches(0.34))
    pPr.set("marL", str(indent))
    pPr.set("indent", str(-indent))

    buClr = OxmlElement("a:buClr")
    srgb = OxmlElement("a:srgbClr")
    srgb.set("val", str(color))
    buClr.append(srgb)

    buFont = OxmlElement("a:buFont")
    buFont.set("typeface", FONT_LATIN)

    buChar = OxmlElement("a:buChar")
    buChar.set("char", "\u2022")

    for element in (buClr, buFont, buChar):
        pPr.append(element)


def _body_size(bullet_count: int) -> int:
    if bullet_count <= 4:
        return 26
    if bullet_count <= 6:
        return 23
    if bullet_count <= 9:
        return 20
    return 18


def _add_title_slide(prs, theme: Theme, title: str, subtitle: str) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[_BLANK_LAYOUT])
    accent = _rgb(theme.accent)

    _rect(slide, 0, 0, Inches(0.42), SLIDE_HEIGHT, accent)
    _rect(slide, Inches(1.05), Inches(2.05), Inches(0.09), Inches(2.15), accent)

    frame = _text_box(slide, Inches(1.42), Inches(1.95), Inches(10.9), Inches(1.9))
    paragraph = frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.LEFT
    run = paragraph.add_run()
    run.text = title
    _style(run, 40, _rgb(theme.title), bold=True)

    if subtitle:
        frame = _text_box(slide, Inches(1.45), Inches(3.95), Inches(10.6), Inches(0.9))
        paragraph = frame.paragraphs[0]
        run = paragraph.add_run()
        run.text = subtitle
        _style(run, 20, _rgb(theme.body))


def _add_content_slide(prs, theme: Theme, entry: Dict[str, Any], number: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[_BLANK_LAYOUT])
    accent = _rgb(theme.accent)

    _rect(slide, 0, 0, SLIDE_WIDTH, Inches(0.16), accent)

    frame = _text_box(slide, Inches(0.85), Inches(0.5), Inches(11.6), Inches(0.95))
    paragraph = frame.paragraphs[0]
    run = paragraph.add_run()
    run.text = entry["title"]
    _style(run, 30, _rgb(theme.title), bold=True)

    _rect(slide, Inches(0.9), Inches(1.52), Inches(1.5), Inches(0.05), accent)

    bullets = entry["bullets"]
    if bullets:
        frame = _text_box(slide, Inches(0.9), Inches(1.9), Inches(11.45), Inches(4.55))
        size = _body_size(len(bullets))
        for position, text in enumerate(bullets):
            paragraph = frame.paragraphs[0] if position == 0 else frame.add_paragraph()
            paragraph.space_after = Pt(12)
            _set_bullet(paragraph, accent)
            run = paragraph.add_run()
            run.text = text
            _style(run, size, _rgb(theme.body))

    frame = _text_box(slide, Inches(12.15), Inches(6.62), Inches(0.75), Inches(0.4))
    paragraph = frame.paragraphs[0]
    paragraph.alignment = PP_ALIGN.RIGHT
    run = paragraph.add_run()
    run.text = str(number)
    _style(run, 12, _rgb(theme.body))

    if entry["notes"]:
        slide.notes_slide.notes_text_frame.text = entry["notes"]
