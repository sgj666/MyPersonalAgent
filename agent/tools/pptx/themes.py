"""Color palettes for the five deck themes.

Hex strings, not RGBColor, so the palette can be read (and tested) without
python-pptx. Only title/body/accent change between themes; fonts never do —
a deck that names Calibri / 等线 is readable on every machine, whereas an
embedded font bloats the file and still fails outside PowerPoint.
"""

from typing import Dict, NamedTuple


class Theme(NamedTuple):
    key: str
    # Slide titles: the high-contrast ink color.
    title: str
    # Body copy, bullets and page numbers: readable, quieter than title.
    body: str
    # Rules, bands and bullet characters.
    accent: str


THEMES: Dict[str, Theme] = {
    # 讲授: navy ink, blue accent — calm, high contrast for long reading.
    "lecture": Theme("lecture", title="1B2A4A", body="3C4858", accent="2F6FB2"),
    # 活动: deep teal ink, warm orange accent — signals participation.
    "activity": Theme("activity", title="14524B", body="2F403C", accent="D9752B"),
    # 复习: plum ink, magenta accent — distinct from the other two at a glance.
    "review": Theme("review", title="4A1E3C", body="3A3038", accent="B0416E"),
    "warm": Theme("warm", title="593C28", body="655345", accent="B96336"),
    "mint": Theme("mint", title="183F38", body="36594E", accent="278675"),
}
