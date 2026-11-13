"""Homework notice cards: content, privacy, pagination and the render entry point.

The card is a class notice — what to do tonight, how long, when it is due — not
a worksheet, so these tests assert the *absence* of writing space too.
"""
import copy

import pytest

from agent.teaching.render.card_html import render_card_html
from agent.teaching.render.render import render_draft


def card_spec():
    return {'version': 1,
            'meta': {'title': 'Unit 3 课后作业', 'class_name': '七(3)班', 'class_ids': ['c1'],
                     'subject': '英语', 'unit': 'Unit 3', 'date': '2026-11-12',
                     'due': '2026-11-13', 'teacher': '李老师'},
            'summary': '明天上课前交给课代表，订正用红笔。',
            'sections': [{'heading': '必做', 'tier': 'basic', 'hint': '全班都做',
                          'items': [
                              {'no': 1, 'type': 'task', 'stem': 'Unit 3 单词抄写 3 遍',
                               'requirement': 'visit / picnic / cinema', 'duration': 10,
                               'answer': 'teacher-secret'},
                              {'no': 2, 'type': 'task', 'stem': '单元测试试卷一张', 'duration': 20}]},
                         {'heading': '挑战', 'tier': 'challenge',
                          'items': [{'no': 3, 'type': 'task', 'stem': '试卷订正', 'duration': 10}]}],
            'footer': {'score': True}}


@pytest.mark.parametrize('format', ['group', 'a4'])
def test_a_notice_lists_tasks_with_time_and_no_writing_space(format):
    student = render_card_html(card_spec(), format=format)
    assert student['pages'] >= 1
    html = student['html']
    assert 'http' not in html and '<link' not in html and '<script' not in html

    # What the notice must say: class, unit, the three tasks, their minutes,
    # the total, the tier tags and the reminder.
    for expected in ('七(3)班', '英语', 'Unit 3', 'Unit 3 课后作业',
                     'Unit 3 单词抄写 3 遍', '单元测试试卷一张', '试卷订正',
                     'visit / picnic / cinema', '10 分钟', '20 分钟',
                     '预计用时', '40', '必做', '挑战', '提醒'):
        assert expected in html, expected

    # What it must not contain: anything that turns it back into a worksheet,
    # and anything addressed to a parent.
    for forbidden in ('____________', '（    ）', 'answer-line', '姓名：',
                      '得分：', '家长', 'parent', '给家长'):
        assert forbidden not in html, forbidden

    # Answers stay out of the student copy.
    assert 'teacher-secret' not in html
    if format == 'group':
        assert 'width:1080px;height:1440px' in html
    else:
        assert '@page{size:A4;margin:12mm}' in html


def test_answer_copy_is_a_teacher_appendix_only():
    spec = card_spec()
    assert '讲评要点' not in render_card_html(spec)['html']
    answer = render_card_html(spec, answer=True)['html']
    assert '讲评要点' in answer and 'teacher-secret' in answer
    assert '请勿发群' in answer


def test_tier_tags_escape_and_optional_reminder():
    spec = card_spec()
    spec['sections'][0]['tier'] = 'advanced'
    spec['summary'] = '<img src=x onerror=alert(1)>'
    html = render_card_html(spec)['html']
    assert '提高' in html and '挑战' in html
    assert '<img src=x' not in html and '&lt;img' in html
    # No reminder means no empty reminder box.
    spec['summary'] = ''
    assert '<aside' not in render_card_html(spec)['html']


@pytest.mark.parametrize('mutation,message', [
    (lambda s: s.update(sections=[]), '1–4'),
    (lambda s: s.update(sections=s['sections'] * 5), '1–4'),
    (lambda s: s['sections'][0].update(items=[s['sections'][0]['items'][0]] * 9), '最多 8 题'),
    (lambda s: s['sections'][0]['items'][0].update(type='essay'), '类型请改为'),
    (lambda s: s['sections'][0].update(tier='impossible'), 'tier 请改为'),
    (lambda s: s['sections'][0]['items'][0].update(lines=-1), '0–20'),
    (lambda s: s['sections'][0]['items'][0].update(duration=0), '1–180'),
    (lambda s: s['sections'][0]['items'][0].update(duration=181), '1–180'),
    (lambda s: s['sections'][0]['items'][0].update(duration='10'), '1–180'),
    (lambda s: s['sections'][0]['items'][0].update(requirement='长' * 81), '80 字以内'),
])
def test_card_validation(mutation, message):
    spec = card_spec()
    mutation(spec)
    with pytest.raises(ValueError, match=message):
        render_card_html(spec)


def test_a_long_list_paginates_instead_of_dropping_tasks():
    spec = card_spec()
    items = [{'no': n, 'type': 'task', 'stem': f'第{n}项作业内容写得长一点，用来占满一页',
              'duration': 15} for n in range(1, 33)]
    # Four sections of eight is the largest card the contract allows.
    spec['sections'] = [{'heading': f'第 {n} 组', 'tier': 'basic', 'items': items[n * 8:(n + 1) * 8]}
                        for n in range(4)]
    result = render_card_html(spec)
    assert result['pages'] > 1
    assert result['html'].count('class="task ') == 32
    assert result['html'].count('class="card group"') == result['pages']


def test_a_short_list_uses_the_page_instead_of_blank_space():
    """Three items must not sit at the top of a 1440px page with a gap under them."""
    spec = card_spec()
    html = render_card_html(spec)['html']
    # The renderer grows type/row padding for sparse cards; --s above 1 proves
    # the fill step ran instead of leaving the page half empty.
    scale = float(html.split('--s:')[1].split(';')[0])
    assert scale > 1.0


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
