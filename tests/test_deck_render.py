"""The v1 deck contract and HTTP trust boundary, exercised with real files."""
import copy
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from PIL import Image
from pptx import Presentation

from agent.teaching.render.deck_html import render_deck_html
from agent.teaching.render.render import render_draft
from agent.tools.pptx import build_deck, THEMES
from agent.tools.pptx.validation import LAYOUTS


def deck_spec():
    slides = []
    for layout in LAYOUTS:
        slide = {'id': layout, 'layout': layout, 'title': '学习目标' if layout == 'cover' else layout,
                 'notes': '先观察，再回答。'}
        if layout in ('two-col', 'compare'):
            slide['columns'] = [{'heading': '易错', 'bullets': ['I going to read.']},
                                {'heading': '正确', 'bullets': ['I am going to read.']}]
        elif layout in ('process', 'timeline'):
            slide['steps'] = [{'label': '导入', 'text': '看图说话'}, {'label': '练习', 'text': '两人问答'}]
        elif layout == 'table':
            slide['table'] = {'headers': ['时间', '活动'], 'rows': [['周六', '看望祖父母']]}
        elif layout == 'image':
            slide['image'] = {'path': '', 'caption': '课本 P32 图 3', 'fit': 'contain'}
        elif layout == 'quote':
            slide['quote'] = 'What are you going to do this weekend?'
        else:
            slide['bullets'] = ['掌握 be going to 的用法', '用完整句子描述周末计划']
        slides.append(slide)
    return {'version': 1, 'theme': 'lecture', 'meta': {'title': '周末计划', 'teacher': '李老师'}, 'slides': slides}


@pytest.mark.parametrize('theme', THEMES)
def test_all_layouts_roundtrip_and_offline_html(tmp_path, theme):
    spec = deck_spec()
    spec['theme'] = theme
    result = build_deck(spec, tmp_path / f'{theme}.pptx')
    assert result['pages'] == 13
    assert result['path'] == str((tmp_path / f'{theme}.pptx').resolve())
    assert any('图片缺失' in warning for warning in result['warnings'])
    prs = Presentation(result['path'])
    assert len(prs.slides) == 13
    assert [slide.name for slide in prs.slides] == list(LAYOUTS)
    assert prs.slides[-1].name == 'end'
    assert '学习目标' in [s.text for s in prs.slides[0].shapes if s.has_text_frame]
    assert prs.slides[0].notes_slide.notes_text_frame.text == '先观察，再回答。'
    assert (prs.slide_width, prs.slide_height) == (12192000, 6858000)
    for slide in prs.slides:
        for shape in slide.shapes:
            assert shape.left >= 0 and shape.top >= 0
            assert shape.left + shape.width <= prs.slide_width
            assert shape.top + shape.height <= prs.slide_height
    with zipfile.ZipFile(result['path']) as archive:
        assert not any('fonts/' in n for n in archive.namelist())
        xml = archive.read('ppt/slides/slide1.xml').decode()
        assert 'Calibri' in xml and '等线' in xml
    html = render_deck_html(spec)
    assert html['pages'] == 13
    assert 'http' not in html['html']
    assert '<link' not in html['html'] and '<script' not in html['html']
    assert 'data-layout="end"' in html['html']
    assert '课本 P32 图 3' in html['html']


@pytest.mark.parametrize('mutation,message', [
    (lambda d: d.update(slides=[]), '1–40'),
    (lambda d: d.update(slides=d['slides'] * 4), '1–40'),
    (lambda d: d['slides'][0].update(layout='free'), 'layout 请改为'),
    (lambda d: d['slides'][0].update(bullets=['要点'] * 7), '单页最多 6'),
    (lambda d: d['slides'][0].update(bullets=['字'] * 9), '有 9 条'),
    (lambda d: d['slides'][0].update(bullets=['字' * 61]), '最多 60 字'),
    (lambda d: d['slides'][6].update(steps=[{'label': 'x'}] * 7), '1–6'),
    (lambda d: d['slides'][8].update(table={'headers': ['x'] * 7, 'rows': []}), '1–6 列'),
    (lambda d: d['slides'][8].update(table={'headers': ['x'], 'rows': [['x']] * 9}), '最多 8 行'),
])
def test_hard_limits_explain_fix_in_chinese(tmp_path, mutation, message):
    spec = deck_spec()
    mutation(spec)
    with pytest.raises(ValueError, match=message):
        build_deck(spec, tmp_path / 'invalid.pptx')
    assert not (tmp_path / 'invalid.pptx').exists()


def test_table_boundary_is_native_and_fits(tmp_path):
    spec = deck_spec()
    spec['slides'] = [{'title': '6×8 表格', 'layout': 'table', 'table': {
        'headers': [f'第{i}列' for i in range(6)],
        'rows': [[f'{r}-{c}' for c in range(6)] for r in range(8)],
    }}]
    result = build_deck(spec, tmp_path / 'table.pptx')
    prs = Presentation(result['path'])
    table = next(s.table for s in prs.slides[0].shapes if s.has_table)
    assert len(table.columns) == 6 and len(table.rows) == 9  # Eight data rows + header.
    assert table.cell(8, 5).text == '7-5'
    assert str(table.cell(0, 0).fill.fore_color.rgb) == THEMES['lecture'].accent
    assert '<table' in render_deck_html(spec)['html']


@pytest.mark.parametrize('fit', ['contain', 'cover'])
def test_local_image_fit_and_embedding(tmp_path, fit):
    image_path = tmp_path / 'wide.png'
    Image.new('RGB', (400, 100), 'red').save(image_path)
    spec = deck_spec()
    spec['slides'] = [{'title': '图片', 'layout': 'image', 'image': {
        'path': str(image_path), 'caption': '实物观察', 'fit': fit}}]
    result = build_deck(spec, tmp_path / 'image.pptx')
    assert result['warnings'] == []
    prs = Presentation(result['path'])
    pictures = [s for s in prs.slides[0].shapes if s.shape_type == 13]
    assert len(pictures) == 1
    picture = pictures[0]
    assert (picture.crop_left > 0) == (fit == 'cover')
    if fit == 'contain':
        assert picture.width / picture.height == pytest.approx(4, rel=.001)
    html = render_deck_html(spec)['html']
    assert 'data:image/png;base64,' in html and f'object-fit:{fit}' in html
    assert 'http' not in html


def test_missing_path_and_capacity_warnings(tmp_path):
    spec = deck_spec()
    spec['slides'][0]['title'] = '过长的标题' * 1000
    spec['slides'][9]['image']['path'] = str(tmp_path / 'missing.png')
    result = build_deck(spec, tmp_path / 'overflow.pptx')
    assert any('14 号后截断' in warning for warning in result['warnings'])
    prs = Presentation(result['path'])
    assert any('…' in s.text for s in prs.slides[0].shapes if s.has_text_frame)
    assert any('图片占位' in s.text for s in prs.slides[9].shapes if s.has_text_frame)


def api_call(handler, method, workspace, payload=None, **query):
    from channel.web.api import teaching as api
    raw = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else b''
    with patch.object(api, '_require_auth') as auth, patch.object(api.web, 'header'), \
         patch.object(api.web, 'data', return_value=raw), \
         patch.object(api.web, 'input', return_value=SimpleNamespace(agent_id='', **query)), \
         patch.object(api, '_get_workspace_root', return_value=str(workspace)):
        response = json.loads(getattr(getattr(api, handler)(), method)())
        auth.assert_called_once()
        return response


def test_draft_save_list_read_render_and_isolation(tmp_path):
    first, second = tmp_path / 'a', tmp_path / 'b'
    spec = deck_spec()
    saved = api_call('TeachingDraftHandler', 'PUT', first,
                     {'kind': 'deck', 'slug': 'unit-3', 'draft': spec})
    assert saved['path'] == 'artifacts/教学工具/deck/unit-3.json'
    loaded = api_call('TeachingDraftHandler', 'GET', first, kind='deck', slug='unit-3')
    assert loaded['draft'] == spec
    assert api_call('TeachingDraftHandler', 'GET', second, kind='deck', slug='unit-3')['code'] == 'not_found'
    listing = api_call('TeachingDraftsHandler', 'GET', first, kind='deck', limit='10')
    assert listing['items'][0]['title'] == '周末计划'
    assert api_call('TeachingDraftsHandler', 'GET', second, kind='deck', limit='10')['items'] == []
    result = api_call('TeachingRenderHandler', 'POST', first,
                      {'kind': 'deck', 'draft_path': saved['path'], 'out_name': 'unit-3'})
    assert result['status'] == 'success', result
    assert {f['format'] for f in result['files']} == {'pptx', 'html'}
    assert all(f['pages'] == 13 for f in result['files'])
    assert all(f['size'] > 0 for f in result['files'])
    # Direct draft wins even when the fallback path is invalid.
    direct = api_call('TeachingRenderHandler', 'POST', first,
                      {'kind': 'deck', 'draft': spec, 'draft_path': '../bad', 'formats': ['html']})
    assert direct['status'] == 'success'


@pytest.mark.parametrize('value', ['../outside', '..', 'a/b', 'a\\b', '/tmp/escape'])
def test_api_refuses_traversal(tmp_path, value):
    response = api_call('TeachingDraftHandler', 'PUT', tmp_path,
                        {'kind': 'deck', 'slug': value, 'draft': deck_spec()})
    assert response['code'] == 'bad_request'
    response = api_call('TeachingRenderHandler', 'POST', tmp_path,
                        {'kind': 'deck', 'draft_path': value})
    assert response['code'] == ('not_found' if value in ('a/b', 'a\\b') else 'bad_request')


def test_symlink_outputs_and_image_escape_rejected(tmp_path):
    outside = tmp_path / 'outside'
    outside.mkdir()
    root = tmp_path / 'workspace'
    root.mkdir()
    (root / 'artifacts').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='workspace'):
        render_draft('deck', deck_spec(), workspace=root)
    (root / 'artifacts').unlink()
    spec = deck_spec()
    spec['slides'][9]['image']['path'] = '../secret.png'
    with pytest.raises(ValueError, match='路径'):
        render_draft('deck', spec, workspace=root)
    assert not list(outside.iterdir())


def test_stable_overwrite_and_no_input_mutation(tmp_path):
    spec = deck_spec()
    before = copy.deepcopy(spec)
    first = render_draft('deck', spec, workspace=tmp_path)
    second = render_draft('deck', spec, workspace=tmp_path)
    assert [f['path'] for f in first['files']] == [f['path'] for f in second['files']]
    assert spec == before


def test_render_accepts_local_image_absolute_or_relative(tmp_path):
    path = tmp_path / 'local.png'
    Image.new('RGB', (40, 20), 'green').save(path)
    spec = deck_spec()
    for source in ('local.png', str(path)):
        spec['slides'][9]['image']['path'] = source
        result = render_draft('deck', spec, formats=('html',), workspace=tmp_path)
        assert result['warnings'] == []
        from pathlib import Path
        assert 'data:image/png;base64,' in Path(result['files'][0]['path']).read_text()


def test_draft_listing_skips_bad_documents_and_external_symlinks(tmp_path):
    directory = tmp_path / 'artifacts/教学工具/deck'
    directory.mkdir(parents=True)
    (directory / 'invalid.json').write_text('{')
    (directory / 'bad-meta.json').write_text('{"meta": []}')
    (directory / 'not-an-object.json').write_text('[]')
    outside = tmp_path.parent / (tmp_path.name + '-private.json')
    outside.write_text(json.dumps(deck_spec()))
    (directory / 'external.json').symlink_to(outside)
    (directory / 'valid.json').write_text(json.dumps(deck_spec()))
    response = api_call('TeachingDraftsHandler', 'GET', tmp_path, kind='deck', limit='10')
    assert response['status'] == 'success'
    assert [item['slug'] for item in response['items']] == ['valid']
