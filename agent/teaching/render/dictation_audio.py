"""Standard pronunciation for dictation words, embedded into the sheet.

``edge-tts`` speaks with Microsoft's neural voices (no key needed) and can
produce both the English word and its Chinese meaning, which the classroom
player needs. The HTML has to work from a local ``file://`` page, so every clip
is embedded as a data URI rather than streamed; clips are cached by
``(voice, text)`` under the workspace's ``tmp/`` so re-rendering a draft — the
page re-renders on every tick — costs disk reads, not network calls.

The dependency is optional in this repo, so a failure here is not fatal: the
player falls back to the browser's speech synthesis and the render reports a
warning.
"""
import asyncio
import base64
import hashlib
import re
import uuid
from concurrent.futures import ThreadPoolExecutor

VOICES = {'en': 'en-US-AriaNeural', 'zh': 'zh-CN-XiaoxiaoNeural'}
TIMEOUT_SECONDS = 20
WORKERS = 6

# The Chinese dictation reads the part of speech, like a teacher does:
# "n. apple" is read "名词 苹果". A word with several senses is played sense by
# sense, with a pause between them.
POS_ZH = {
    'n': '名词', 'v': '动词', 'vt': '及物动词', 'vi': '不及物动词',
    'adj': '形容词', 'adv': '副词', 'prep': '介词', 'pron': '代词',
    'conj': '连词', 'num': '数词', 'art': '冠词', 'int': '感叹词',
    'aux': '助动词', 'modal': '情态动词', 'abbr': '缩写', 'phr': '短语',
    'pl': '复数',
}


# 地 is a structural particle read "de" (部分地) but a noun component read "dì"
# (土地). edge-tts has no pinyin control, so the particle is swapped to 的 for
# the voice only; nouns that end a gloss must be listed here.
# shortcut: only gloss-final/pre-punctuation 地 can be decided; add nouns here
# when a new word is misread.
DI_NOUNS = (
    '土地', '草地', '高地', '当地', '各地', '阵地', '基地', '场地', '陆地', '天地',
    '田地', '产地', '驻地', '余地', '境地', '目的地', '所在地', '殖民地', '根据地',
    '聚集地', '发源地', '栖息地', '集结地', '露营地', '集散地', '工地', '原地',
    '异地', '实地', '就地', '特地', '遍地', '此地', '本地', '外地', '内地', '属地',
    '领地', '营地', '林地', '山地', '盆地', '谷地', '湿地', '旱地', '沙地', '雪地',
    '低地', '洼地', '坡地', '平地', '空地', '菜地', '麦地', '园地', '墓地', '圣地',
    '福地', '禁地', '重地', '要地', '险地', '绝地', '死地', '生地', '熟地', '荒地',
    '地区', '地点', '地方', '地图', '地球', '地铁', '地面', '地下', '地理', '地震',
    '地毯', '地板', '地产', '地主', '地势', '地标', '地段', '地域', '地基', '地壳',
    '地道', '地雷', '地沟', '地洞', '地牢', '地狱', '地租', '地摊', '地头', '地皮',
    '地质', '地貌', '地热', '地盘', '地缘', '地勤', '地价', '地界', '地契', '地权',
)
_PARTICLE_DE = re.compile(r'地(?=$|[；;，,。、）)])')


def _de_particle(meaning, pos_key):
    if '地' not in meaning:
        return meaning

    def replace(match):
        # `adv.` is an adverb by definition; a noun tail keeps its dì reading.
        if pos_key != 'adv' and any(meaning[:match.end()].endswith(noun) for noun in DI_NOUNS):
            return '地'
        return '的'

    return _PARTICLE_DE.sub(replace, meaning)


def read_text(sense):
    """What the Chinese voice says for one sense: "名词 苹果"."""
    pos = (sense.get('pos') or '').strip()
    meaning = (sense.get('meaning') or '').strip()
    key = pos.lower().rstrip('.').strip()
    spoken = POS_ZH.get(key, pos)
    return ' '.join(part for part in (spoken, _de_particle(meaning, key)) if part)


def _clip(text, voice, cache_dir):
    """One MP3 as bytes, from the cache or synthesized; None when unavailable."""
    key = hashlib.sha1(f'{voice}\0{text}'.encode('utf-8')).hexdigest()
    target = cache_dir / f'{key}.mp3'
    if target.is_file() and target.stat().st_size > 0:
        return target.read_bytes()
    try:
        import edge_tts
    except ImportError:
        return None

    async def save():
        communicate = edge_tts.Communicate(text, voice)
        await asyncio.wait_for(communicate.save(str(temp)), TIMEOUT_SECONDS)

    temp = target.with_name(f'{target.stem}.{uuid.uuid4().hex[:8]}.part')
    try:
        asyncio.run(save())
    except Exception:
        temp.unlink(missing_ok=True)
        return None
    if not temp.is_file() or not temp.stat().st_size:
        temp.unlink(missing_ok=True)
        return None
    temp.replace(target)
    return target.read_bytes()


def build_audio(words, cache_dir, enabled=True, include_zh=True):
    """``{'en:visit': 'data:audio/mpeg;base64,…'}`` plus warnings.

    The key is ``<lang>:<text>``; the renderer looks it up per row.
    """
    if not enabled:
        return {}, []
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        return {}, ['未安装 edge-tts，听写单会用浏览器语音朗读；安装后重新生成即可离线播放标准发音。']

    cache_dir.mkdir(parents=True, exist_ok=True)
    wanted = {}
    for word in words:
        if word.get('on') is False:
            continue
        if word.get('word'):
            wanted[('en', word['word'])] = True
        if include_zh:
            for sense in word.get('senses') or []:
                spoken = read_text(sense)
                if spoken:
                    wanted[('zh', spoken)] = True

    def load(item):
        lang, text = item
        return item, _clip(text, VOICES[lang], cache_dir)

    results = []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for item, data in pool.map(load, wanted):
            if data:
                results.append((item, data))

    audio = {f'{lang}:{text}': 'data:audio/mpeg;base64,' + base64.b64encode(data).decode('ascii')
             for (lang, text), data in results}
    missing = len(wanted) - len(results)
    warnings = []
    if missing:
        warnings.append(f'{missing} 段标准发音没有生成成功，课上会用浏览器语音代替；联网后重新生成即可。')
    return audio, warnings
