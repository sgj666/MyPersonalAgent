"""Contract tests for the local .pptx renderer in agent/tools/pptx."""

import os
import zipfile

import pytest
from pptx import Presentation
from pptx.util import Emu

from agent.tools.pptx import MAX_BULLET_CHARS, MAX_SLIDES, THEMES, build_deck

SKILLS_SLIDE = {
    "title": "教学目标",
    "bullets": ["能说出 5 个周末活动短语", "能用 be going to 描述计划"],
    "notes": "先齐读目标，再进入导入；约 3 分钟。",
}


def _spec(theme="lecture", slides=None):
    return {
        "version": 1,
        "meta": {"title": "Unit 3 My weekend plan", "subtitle": "人教版 七年级上 · 第 2 课时"},
        "theme": theme,
        "slides": [{"layout": "cover", "title": "Unit 3 My weekend plan"}] + [
            {"layout": "bullets", **slide} for slide in (slides if slides is not None else [
            SKILLS_SLIDE,
            {"title": "活动：Pair work", "bullets": ["两人一组问答", "记录同伴的计划"]},
            {"title": "小结", "bullets": ["be going to + 动词原形"]},
        ])],
    }


def _build(tmp_path, theme="lecture", slides=None, name="deck.pptx"):
    out = tmp_path / name
    returned = build_deck(_spec(theme, slides), str(out))
    assert os.path.isabs(returned["path"])
    assert os.path.samefile(returned["path"], str(out))
    return out


@pytest.mark.parametrize("theme", sorted(THEMES))
def test_each_theme_builds_a_reopenable_deck(tmp_path, theme):
    out = _build(tmp_path, theme, name=f"{theme}.pptx")

    prs = Presentation(str(out))
    assert len(prs.slides) == 1 + 3

    first_texts = [
        shape.text_frame.text
        for shape in prs.slides[0].shapes
        if shape.has_text_frame
    ]
    assert "Unit 3 My weekend plan" in first_texts
    assert "人教版 七年级上 · 第 2 课时" in first_texts

    body_texts = [
        shape.text_frame.text
        for shape in prs.slides[1].shapes
        if shape.has_text_frame
    ]
    assert any("教学目标" in text for text in body_texts)
    assert any("能说出 5 个周末活动短语" in text for text in body_texts)

    assert out.stat().st_size > 10 * 1024


def test_title_slide_and_notes(tmp_path):
    out = _build(tmp_path)
    prs = Presentation(str(out))

    assert prs.slide_width == Emu(12192000)
    assert prs.slide_height == Emu(6858000)

    notes = [
        slide.notes_slide.notes_text_frame.text
        for slide in prs.slides
        if slide.has_notes_slide
    ]
    assert notes == [SKILLS_SLIDE["notes"]]


def test_fonts_are_named_never_embedded(tmp_path):
    out = _build(tmp_path, "activity")
    prs = Presentation(str(out))

    names = set()
    for slide in prs.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    names.add(run.font.name)
    assert names == {"Calibri"}

    with zipfile.ZipFile(str(out)) as archive:
        embedded = [n for n in archive.namelist() if "font" in n.lower()]
    assert embedded == []


def test_themes_are_visually_distinct():
    title_colors = {palette.title for palette in THEMES.values()}
    body_colors = {palette.body for palette in THEMES.values()}
    assert len(title_colors) == len(THEMES)
    assert len(body_colors) == len(THEMES)
    for palette in THEMES.values():
        assert palette.title != palette.body


def test_missing_output_directory_is_created(tmp_path):
    out = tmp_path / "nested" / "dir" / "deck.pptx"
    build_deck(_spec(), str(out))
    assert out.exists()


@pytest.mark.parametrize("spec", [
    pytest.param({"slides": [SKILLS_SLIDE]}, id="missing-title"),
    pytest.param({"title": " ", "slides": [SKILLS_SLIDE]}, id="blank-title"),
    pytest.param({"title": "T"}, id="missing-slides"),
    pytest.param({"title": "T", "slides": []}, id="empty-slides"),
    pytest.param({"title": "T", "slides": "nope"}, id="slides-not-a-list"),
    pytest.param({"title": "T", "theme": "noir", "slides": [SKILLS_SLIDE]}, id="unknown-theme"),
    pytest.param({"title": "T", "slides": [{"bullets": ["x"]}]}, id="slide-missing-title"),
    pytest.param({"title": "T", "slides": [{"title": "S", "bullets": ["a", 3]}]}, id="bullet-not-text"),
    pytest.param({"title": "T", "slides": [{"title": "S", "bullets": ["  "]}]}, id="blank-bullet"),
    pytest.param({"title": "T", "slides": [{"title": "S", "notes": 7}]}, id="notes-not-text"),
    pytest.param(["not", "a", "dict"], id="not-a-dict"),
])
def test_invalid_specs_raise_value_error(tmp_path, spec):
    if isinstance(spec, dict):
        title = spec.pop("title", None)
        spec.update(version=1, meta={"title": title})
        if isinstance(spec.get("slides"), list):
            spec["slides"] = [{"layout": "bullets", **slide} for slide in spec["slides"]]
    with pytest.raises(ValueError):
        build_deck(spec, str(tmp_path / "bad.pptx"))
    assert not (tmp_path / "bad.pptx").exists()


def test_rejects_too_many_slides(tmp_path):
    slides = [{"title": f"第 {i} 页", "bullets": ["要点"]} for i in range(MAX_SLIDES + 1)]
    with pytest.raises(ValueError, match="1–40"):
        build_deck(_spec(slides=slides), str(tmp_path / "long.pptx"))


def test_rejects_long_bullet(tmp_path):
    slides = [{"title": "长要点", "bullets": ["字" * (MAX_BULLET_CHARS + 1)]}]
    with pytest.raises(ValueError, match=str(MAX_BULLET_CHARS)):
        build_deck(_spec(slides=slides), str(tmp_path / "long.pptx"))

    # The boundary itself is legal.
    ok = _build(
        tmp_path,
        slides=[{"title": "长要点", "bullets": ["字" * MAX_BULLET_CHARS]}],
        name="boundary.pptx",
    )
    assert ok.stat().st_size > 10 * 1024
