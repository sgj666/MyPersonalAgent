"""Local .pptx renderer for the courseware-ppt skill."""

from agent.tools.pptx.builder import (
    MAX_BULLET_CHARS,
    MAX_SLIDES,
    build_deck,
)
from agent.tools.pptx.themes import THEMES, Theme

__all__ = ["build_deck", "THEMES", "Theme", "MAX_SLIDES", "MAX_BULLET_CHARS"]
