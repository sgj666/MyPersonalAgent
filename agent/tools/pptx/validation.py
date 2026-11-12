"""Shared v1 teaching draft validation; no renderer silently repairs hard limits."""
from copy import deepcopy

from agent.tools.pptx.themes import THEMES

LAYOUTS = ('cover', 'agenda', 'objectives', 'bullets', 'two-col', 'compare',
           'process', 'timeline', 'table', 'image', 'quote', 'summary', 'end')
MAX_SLIDES = 40
MAX_BULLET_CHARS = 60


def text(value, label, required=False):
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f'{label}请填写{"非空" if required else ""}文字')
    return value


def bullets(value, label):
    if not isinstance(value, list):
        raise ValueError(f'{label}请改为文字列表')
    if len(value) > 6:
        raise ValueError(f'{label} 有 {len(value)} 条，单页最多 6 条，请拆页')
    for item in value:
        text(item, label, True)
        if len(item) > MAX_BULLET_CHARS:
            raise ValueError(f'{label} 每条最多 60 字，当前 {len(item)} 字，请精简或拆条')


def validate_deck(spec):
    if not isinstance(spec, dict):
        raise ValueError('课件请改为 JSON 对象')
    if spec.get('version') != 1:
        raise ValueError('课件 version 请设为 1')
    if not isinstance(spec.get('meta'), dict):
        raise ValueError('课件请补充 meta 对象及 title')
    text(spec['meta'].get('title'), 'meta.title', True)
    for key, value in spec['meta'].items():
        if key != 'class_ids':
            text(value, 'meta.' + key)
    if not isinstance(spec.get('theme', 'lecture'), str) or spec.get('theme', 'lecture') not in THEMES:
        raise ValueError('theme 请改为 lecture/activity/review/warm/mint 之一')
    slides = spec.get('slides')
    if not isinstance(slides, list) or not 1 <= len(slides) <= MAX_SLIDES:
        raise ValueError('slides 请保留 1–40 页')
    for number, slide in enumerate(slides, 1):
        label = f'第 {number} 页'
        if not isinstance(slide, dict) or slide.get('layout') not in LAYOUTS:
            raise ValueError(f'{label} layout 请改为：' + ' / '.join(LAYOUTS))
        text(slide.get('title'), label + ' title', True)
        for key in ('subtitle', 'quote', 'notes'):
            if key in slide:
                text(slide[key], label + ' ' + key)
        bullets(slide.get('bullets', []), label + ' bullets')
        layout = slide['layout']
        if layout in ('two-col', 'compare'):
            columns = slide.get('columns')
            if not isinstance(columns, list) or len(columns) != 2:
                raise ValueError(f'{label} columns 请提供恰好 2 栏')
            total = 0
            for col in columns:
                if not isinstance(col, dict):
                    raise ValueError(f'{label} 每栏请改为 heading/bullets 对象')
                text(col.get('heading', ''), label + ' heading')
                bullets(col.get('bullets', []), label + ' columns bullets')
                total += len(col.get('bullets', []))
            if total + len(slide.get('bullets', [])) > 6:
                raise ValueError(f'{label} bullets 有 {total} 条，单页最多 6 条，请拆页')
        if layout in ('process', 'timeline'):
            steps = slide.get('steps')
            if not isinstance(steps, list) or not 1 <= len(steps) <= 6:
                raise ValueError(f'{label} steps 请保留 1–6 步')
            for step in steps:
                if not isinstance(step, dict):
                    raise ValueError(f'{label} 每步请改为 label/text 对象')
                text(step.get('label', ''), label + ' label')
                text(step.get('text', ''), label + ' text')
        if layout == 'table':
            table = slide.get('table')
            if not isinstance(table, dict):
                raise ValueError(f'{label} 请补充 table.headers 和 table.rows')
            headers, rows = table.get('headers'), table.get('rows')
            if not isinstance(headers, list) or not 1 <= len(headers) <= 6:
                raise ValueError(f'{label} 表格请保留 1–6 列')
            if not isinstance(rows, list) or len(rows) > 8:
                raise ValueError(f'{label} 表格数据请保留最多 8 行')
            for row in [headers] + rows:
                if not isinstance(row, list) or len(row) != len(headers):
                    raise ValueError(f'{label} 每行单元格数请与表头一致')
                for cell in row:
                    text(cell, label + ' 单元格')
        if layout == 'image':
            image = slide.get('image', {})
            if not isinstance(image, dict):
                raise ValueError(f'{label} image 请改为 path/caption/fit 对象')
            text(image.get('path', ''), label + ' image.path')
            text(image.get('caption', ''), label + ' image.caption')
            if image.get('fit', 'contain') not in ('contain', 'cover'):
                raise ValueError(f'{label} image.fit 请改为 contain 或 cover')
    return deepcopy(spec)


def validate_card(spec):
    if not isinstance(spec, dict) or spec.get('version') != 1:
        raise ValueError('卡片请使用 JSON 对象，并将 version 设为 1')
    if not isinstance(spec.get('meta'), dict):
        raise ValueError('卡片请补充 meta 对象')
    text(spec['meta'].get('title'), 'meta.title', True)
    for key, value in spec['meta'].items():
        if key != 'class_ids':
            text(value, 'meta.' + key)
    ids = spec['meta'].get('class_ids', [])
    if not isinstance(ids, list) or any(not isinstance(i, str) for i in ids):
        raise ValueError('meta.class_ids 请改为班级 ID 列表')
    text(spec.get('summary', ''), 'summary')
    sections = spec.get('sections')
    if not isinstance(sections, list) or not 1 <= len(sections) <= 4:
        raise ValueError('sections 请保留 1–4 个分区')
    for number, section in enumerate(sections, 1):
        label = f'第 {number} 个分区'
        if not isinstance(section, dict):
            raise ValueError(label + '请改为对象')
        text(section.get('heading'), label + ' heading', True)
        text(section.get('hint', ''), label + ' hint')
        if section.get('tier', 'basic') not in ('basic', 'advanced', 'challenge'):
            raise ValueError(label + ' tier 请改为 basic/advanced/challenge')
        items = section.get('items')
        if not isinstance(items, list) or len(items) > 8:
            raise ValueError(label + ' items 请改为列表，每个分区最多 8 题')
        for item in items:
            if not isinstance(item, dict) or item.get('type') not in ('fill', 'choice', 'short', 'read', 'match'):
                raise ValueError(label + ' 题型请改为 fill/choice/short/read/match')
            text(item.get('stem'), label + ' stem', True)
            text(item.get('answer', ''), label + ' answer')
            lines = item.get('lines', 1)
            if not isinstance(lines, int) or isinstance(lines, bool) or not 0 <= lines <= 20:
                raise ValueError(label + ' lines 请设为 0–20 的整数')
            options = item.get('options', [])
            if not isinstance(options, list) or any(not isinstance(o, str) for o in options):
                raise ValueError(label + ' options 请改为文字列表')
    footer = spec.get('footer', {})
    if not isinstance(footer, dict) or any(not isinstance(v, bool) for v in footer.values()):
        raise ValueError('footer 请改为 score/parent_sign 布尔值对象')
    return deepcopy(spec)
