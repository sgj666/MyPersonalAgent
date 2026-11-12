"""Card forms, answer privacy, pagination and the public render entry point."""
import copy

import pytest

from agent.teaching.render.card_html import render_card_html
from agent.teaching.render.render import render_draft


def card_spec():
    return {'version': 1,
            'meta': {'title': 'Unit 3 课后作业', 'class_name': '七(3)班', 'class_ids': ['c1'],
                     'subject': '英语', 'unit': 'Unit 3', 'date': '2026-11-12', 'teacher': '李老师'},
            'summary': '今晚 20 分钟，重点练习 be going to 的三种句型。',
            'sections': [{'heading': '一、词汇巩固', 'tier': 'basic', 'hint': '每题 2 分',
                          'items': [{'no': 1, 'type': 'fill', 'stem': '看望祖父母', 'answer': 'visit grandparents'},
                                    {'no': 2, 'type': 'choice', 'stem': 'What are you going to do?',
                                     'options': ['A. I am going to read.', 'B. I read yesterday.'], 'answer': 'A'},
                                    {'no': 3, 'type': 'short', 'stem': '描述你的周末计划：', 'lines': 3, 'answer': 'teacher-secret'},
                                    {'no': 4, 'type': 'read', 'stem': 'Read and write about your weekend.', 'lines': 2},
                                    {'no': 5, 'type': 'match', 'stem': '将时间与活动配对', 'lines': 2}]}],
            'footer': {'score': True, 'parent_sign': True}}


@pytest.mark.parametrize('format', ['group', 'a4'])
def test_all_question_types_and_answer_privacy(format):
    spec = card_spec()
    student = render_card_html(spec, format=format)
    assert student['pages'] >= 1
    html = student['html']
    assert 'http' not in html and '<link' not in html and '<script' not in html
    for expected in ('七(3)班', '英语', 'Unit 3', '2026-11-12', '姓名：', '基础',
                     '____________', '（    ）', 'answer-line', '给家长的话', '得分', '家长签字'):
        assert expected in html
    assert 'teacher-secret' not in html and 'visit grandparents' not in html
    assert '>答案版<' not in html
    answer = render_card_html(spec, format=format, answer=True)
    assert '>答案版<' in answer['html']
    assert 'teacher-secret' in answer['html'] and 'visit grandparents' in answer['html']
    if format == 'group':
        assert 'width:1080px;height:1440px' in html
    else:
        assert '@page{size:A4;margin:12mm}' in html


def test_tier_tags_optional_footer_and_escaping():
    spec = card_spec()
    spec['sections'] = [copy.deepcopy(spec['sections'][0]) for _ in range(3)]
    for section, tier in zip(spec['sections'], ('basic', 'advanced', 'challenge')):
        section['tier'] = tier
    spec['footer'] = {}
    spec['summary'] = '<img src=x onerror=alert(1)>'
    html = render_card_html(spec)['html']
    assert all(tier in html for tier in ('基础', '提升', '挑战'))
    assert '得分：' not in html and '家长签字：' not in html
    assert '<img src=x' not in html and '&lt;img' in html


@pytest.mark.parametrize('mutation,message', [
    (lambda s: s.update(sections=[]), '1–4'),
    (lambda s: s.update(sections=s['sections'] * 5), '1–4'),
    (lambda s: s['sections'][0].update(items=[s['sections'][0]['items'][0]] * 9), '最多 8 题'),
    (lambda s: s['sections'][0]['items'][0].update(type='essay'), '题型请改为'),
    (lambda s: s['sections'][0].update(tier='impossible'), 'tier 请改为'),
    (lambda s: s['sections'][0]['items'][0].update(lines=-1), '0–20'),
])
def test_card_validation(mutation, message):
    spec = card_spec()
    mutation(spec)
    with pytest.raises(ValueError, match=message):
        render_card_html(spec)


def test_large_card_paginates_instead_of_dropping_questions():
    spec = card_spec()
    spec['sections'] *= 4
    for section in spec['sections']:
        section['items'] = [{'no': n, 'type': 'short', 'stem': f'第{n}题写一个句子', 'lines': 3} for n in range(8)]
    result = render_card_html(spec)
    assert result['pages'] > 1
    assert result['html'].count('<article class="question"') == 32
    assert result['html'].count('class="card group"') == result['pages']


def test_long_stem_truncates_after_minimum_font_and_warns():
    spec = card_spec()
    spec['sections'][0]['items'] = [{'no': 1, 'type': 'short', 'stem': '长题目' * 2000, 'lines': 20}]
    result = render_card_html(spec)
    assert any('截断' in w for w in result['warnings'])
    assert '…' in result['html']
    assert result['pages'] == 1


def test_render_files_and_stable_paths(tmp_path):
    spec = card_spec()
    original = copy.deepcopy(spec)
    result = render_draft('card', spec, a4=True, workspace=tmp_path)
    assert [file['format'] for file in result['files']] == ['html', 'a4']
    for file in result['files']:
        from pathlib import Path
        path = Path(file['path'])
        assert path.is_absolute() and file['rel'].startswith('artifacts/教学工具/card/')
        assert path.stat().st_size == file['size']
        assert file['pages'] >= 1
    again = render_draft('card', spec, formats=('html', 'a4'), workspace=tmp_path)
    assert [f['path'] for f in again['files']] == [f['path'] for f in result['files']]
    assert spec == original
    with pytest.raises(ValueError, match='formats'):
        render_draft('card', spec, formats=('pptx',), workspace=tmp_path)
