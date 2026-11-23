"""Dictation player: one word at a time, both modes, embedded audio, printing."""
import json
import re

import pytest

from agent.teaching.render.dictation_html import render_dictation_html
from agent.teaching.render.render import render_draft


def spec(mode='zh'):
    return {'version': 1,
            'meta': {'title': 'Unit 3 单词听写', 'book': '人教新版七上',
                     'unit': 'Unit 3 My weekend plan', 'date': '2026-11-12', 'mode': mode},
            'words': [
                {'word': 'visit', 'phonetic': '/ˈvɪzɪt/',
                 'senses': [{'pos': 'v.', 'meaning': '参观；拜访'}]},
                {'word': 'see a film', 'phonetic': '',
                 'senses': [{'pos': 'phr.', 'meaning': '看电影'}]},
                {'word': 'picnic', 'phonetic': '', 'on': False,
                 'senses': [{'pos': 'n.', 'meaning': '野餐'}]},
            ]}


def payload(html):
    """The player's word list, as the browser parses it."""
    match = re.search(r'<script type="application/json" id="dict-data">(.*?)</script>', html, re.S)
    return json.loads(match.group(1))


def test_the_player_holds_one_word_at_a_time_and_carries_both_audio_slots():
    html = render_dictation_html(spec())['html']
    words = payload(html)
    assert [word['word'] for word in words] == ['visit', 'see a film']
    assert words[0]['senses'] == [{'pos': 'v.', 'meaning': '参观；拜访', 'read': '动词 参观；拜访', 'zhAudio': ''}]
    assert words[0]['enAudio'] == ''
    # One card, one prompt, one answer block: the class sees a single word.
    assert 'id="prompt-zh"' in html and 'id="a-word"' in html
    assert html.count('id="a-word"') == 1
    # The part of speech is printed before the meaning, and read before it too.
    assert 'v.' in html and '动词 参观；拜访' in html
    # The unselected word is on neither the player nor the print sheet.
    assert '野餐' not in html
    assert '<body class="kind-dictation mode-zh">' in html
    assert "mode: 'zh'" in html


def test_standard_audio_is_embedded_for_english_and_chinese():
    audio = {'en:visit': 'data:audio/mpeg;base64,AAA',
             'zh:动词 参观；拜访': 'data:audio/mpeg;base64,BBB'}
    html = render_dictation_html(spec(), audio=audio)['html']
    words = payload(html)
    assert words[0]['enAudio'].endswith(',AAA')
    assert words[0]['senses'][0]['zhAudio'].endswith(',BBB')
    assert words[1]['enAudio'] == ''
    # No streaming: the clip travels inside the file.
    assert 'data:audio/mpeg;base64,AAA' in html
    assert 'https://' not in html and 'http://' not in html


def test_english_opens_on_english_and_the_page_owns_the_switch():
    html = render_dictation_html(spec('en'))['html']
    assert '<body class="kind-dictation mode-en">' in html
    assert "mode: 'en'" in html
    assert 'data-mode="zh"' in html and 'data-mode="en"' in html
    assert '听发音 · 写单词' in html
    # Auto dictation and its knobs are part of the page, not the app.
    assert '自动听写' in html and 'id="interval"' in html and 'id="repeat"' in html
    assert 'id="countdown"' in html
    assert 'SpeechSynthesisUtterance' in html  # fallback when a clip is missing


def test_translation_mode_shows_english_and_reveals_chinese():
    draft = spec()
    draft['meta'].update(kind='translation', title='Unit 3 英译汉')
    html = render_dictation_html(draft)['html']
    assert '<body class="kind-translation mode-zh">' in html
    assert '英译汉' in html
    # The player keeps one stage: English prompt, hidden Chinese answer.
    assert 'id="prompt-trans"' in html and 'id="trans-word"' in html
    assert 'id="reveal-hint"' in html and '点击显示中文答案' in html
    # Auto check has its own two phases and an audio toggle.
    assert 'id="think"' in html and 'id="hold"' in html and 'id="autoread"' in html
    assert 'id="loop"' in html and '循环播放' in html
    assert 'think: 2' in html and 'hold: 1' in html
    assert 'dictation-translation' in html
    assert '<option value="10">10 秒</option>' in html
    assert '12 秒' not in html and '15 秒' not in html and '20 秒' not in html
    assert '思考' in html and '答案 ' in html
    # The print sheet asks for English -> Chinese, not the word.
    assert '<span class="p p-en">visit</span>' in html
    assert 'class="print-hint">看英文，写出中文意思' in html
    # The summary swaps the columns: English prompt, Chinese answer.
    assert '英 译 汉 · 汇 总' in html
    assert 'TRANSLATION' in html and 'tickTranslation' in html
    meta = json.loads(re.search(r'id="dict-meta">(.*?)</script>', html, re.S).group(1))
    assert meta['kind'] == 'translation'


def test_a_legacy_draft_without_kind_stays_dictation():
    draft = spec()
    draft['meta'].pop('kind', None)
    html = render_dictation_html(draft)['html']
    assert '<body class="kind-dictation mode-zh">' in html
    meta = json.loads(re.search(r'id="dict-meta">(.*?)</script>', html, re.S).group(1))
    assert meta['kind'] == 'dictation'


def test_a_player_is_offline_escaped_and_printable():
    draft = spec()
    draft['words'][0]['senses'][0]['meaning'] = '<img src=x onerror=alert(1)>'
    draft['meta']['title'] = '<script>bad()</script>'
    html = render_dictation_html(draft)['html']
    assert '<img src=x' not in html and '&lt;img' in html
    assert '<script>bad()' not in html and '&lt;script&gt;' in html
    # The JSON payload cannot close its own block either.
    assert payload(html)[0]['senses'][0]['meaning'] == '<img src=x onerror=alert(1)>'
    assert 'http://' not in html and 'https://' not in html
    assert '<link' not in html
    # The printable list is still there, behind @media print.
    assert 'class="print-sheet"' in html and '@media print' in html
    assert '@page{size:A4' in html
    assert '打印词表' in html
    # After the last word the player asks about the summary, which saves images.
    assert '查看听写汇总' in html and '保存全部图片' in html
    assert 'toDataURL' in html and 'summary-img' in html
    assert 'summary-prev' in html and 'summary-next' in html and '保存本页' in html


def test_reading_fixes_the_de_particle_but_not_di_nouns():
    from agent.teaching.render.dictation_audio import read_text

    assert read_text({'pos': 'phr.', 'meaning': '部分地'}) == '短语 部分的'
    assert read_text({'pos': 'adv.', 'meaning': '效率高地'}) == '副词 效率高的'
    assert read_text({'pos': 'phr.', 'meaning': '在某种程度上；部分地'}) == '短语 在某种程度上；部分的'
    # The same character inside a noun keeps its dì reading.
    assert read_text({'pos': 'n.', 'meaning': '土地'}) == '名词 土地'
    assert read_text({'pos': 'n.', 'meaning': '目的地'}) == '名词 目的地'
    assert read_text({'pos': 'n.', 'meaning': '高地'}) == '名词 高地'


def test_translation_render_only_synthesizes_the_english_voice(tmp_path, monkeypatch):
    from agent.teaching.render import dictation_audio

    voices = []
    monkeypatch.setattr(dictation_audio, '_clip',
                        lambda text, voice, cache: voices.append(voice) or b'ID3')
    draft = spec()
    draft['meta']['kind'] = 'translation'
    result = render_draft('dictation', draft, workspace=str(tmp_path), tts=True)
    assert result['files'][0]['format'] == 'html'
    assert voices and all('Aria' in voice for voice in voices)


def test_render_draft_writes_one_html_file(tmp_path):
    result = render_draft('dictation', spec(), workspace=str(tmp_path), tts=False)
    assert result['warnings'] == []
    [file] = result['files']
    assert file['format'] == 'html' and file['rel'].endswith('单词听写.html')
    with open(file['path'], encoding='utf-8') as handle:
        assert '自动听写' in handle.read()


def test_audio_is_embedded_by_the_render_path(tmp_path, monkeypatch):
    from agent.teaching.render import dictation_audio

    monkeypatch.setattr(dictation_audio, '_clip', lambda text, voice, cache: b'ID3fake')
    result = render_draft('dictation', spec(), workspace=str(tmp_path), tts=True)
    assert result['warnings'] == []
    [file] = result['files']
    with open(file['path'], encoding='utf-8') as handle:
        html = handle.read()
    words = payload(html)
    assert words[0]['enAudio'] == 'data:audio/mpeg;base64,SUQzZmFrZQ=='
    assert words[0]['senses'][0]['zhAudio'] == 'data:audio/mpeg;base64,SUQzZmFrZQ=='


def test_a_missing_clip_warns_without_breaking_the_file(tmp_path, monkeypatch):
    from agent.teaching.render import dictation_audio

    monkeypatch.setattr(dictation_audio, '_clip', lambda text, voice, cache: None)
    result = render_draft('dictation', spec(), workspace=str(tmp_path), tts=True)
    assert [file['format'] for file in result['files']] == ['html']
    assert any('标准发音' in warning for warning in result['warnings'])


@pytest.mark.parametrize('mutation,message', [
    (lambda d: d.update(words=[]), '至少需要 1 个单词'),
    (lambda d: d['words'][0].update(word='  '), '缺少英文拼写'),
    (lambda d: d.update(words=[{'word': f'w{i}'} for i in range(121)]), '最多 120'),
    (lambda d: d['words'][0].update(on=False) or d['words'][1].update(on=False)
     or d['words'][2].update(on=False), '至少选择一个单词'),
])
def test_a_bad_word_list_is_refused_by_name(mutation, message):
    draft = spec()
    mutation(draft)
    with pytest.raises(ValueError) as error:
        render_dictation_html(draft)
    assert message in str(error.value)


def test_formats_other_than_html_are_refused():
    with pytest.raises(ValueError):
        render_draft('dictation', spec(), formats=['a4'], tts=False)
