"""PowerPoint stays editable and themes preserve the shared layout geometry."""
from pptx import Presentation
import pytest

from agent.tools.pptx import build_deck, THEMES


def test_themes_preserve_geometry_and_editable_text(tmp_path):
    shapes = []
    for theme in THEMES:
        spec = {'version': 1, 'meta': {'title': '边界'}, 'theme': theme,
                'slides': [{'layout': 'bullets', 'title': '六条要点',
                            'bullets': ['字' * 60] * 6}]}
        result = build_deck(spec, tmp_path / f'{theme}.pptx')
        slide = Presentation(result['path']).slides[0]
        assert sum('字' in shape.text for shape in slide.shapes if shape.has_text_frame) == 6
        shapes.append([(shape.left, shape.top, shape.width, shape.height) for shape in slide.shapes])
        for shape in slide.shapes:
            if shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    for run in paragraph.runs:
                        assert run.font.size.pt in (32, 24, 20, 16, 14)
    assert all(geometry == shapes[0] for geometry in shapes)


@pytest.mark.parametrize('theme', [[], {}, 1, None])
def test_malformed_theme_is_a_correctable_value_error(tmp_path, theme):
    with pytest.raises(ValueError, match='theme 请改为'):
        build_deck({'version': 1, 'meta': {'title': '测试'}, 'theme': theme,
                    'slides': [{'layout': 'cover', 'title': '测试'}]}, tmp_path / 'bad.pptx')
