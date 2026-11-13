"""Homework notice cards: what to do tonight, how long it takes, when it is due.

The card is a class notice, not a worksheet: no writing lines, no brackets, no
answers on the student copy. Teacher review notes (``answer``) only appear as a
restrained appendix when ``answer=True``.
"""
from html import escape

from agent.tools.pptx.scene import wrap
from agent.tools.pptx.validation import validate_card
from agent.teaching.render.deck_html import FONT

# basic / advanced / challenge, as students read them.
TIERS = {'basic': '必做', 'advanced': '提高', 'challenge': '挑战'}
WEEKDAYS = '一二三四五六日'

# Geometry per format, in CSS px. ``group`` is the 1080×1440 phone image;
# ``a4`` is the printable area of an A4 page with 12mm margins.
FORMATS = {
    'group': dict(width=1080, height=1440, pad_x=72, pad_top=76, pad_bottom=56, band=14,
                  header=300, bottom=250, stem=34, req=25, section=78, row_pad=22,
                  num=52, chip=150, gap=18),
    'a4': dict(width=703, height=1032, pad_x=8, pad_top=10, pad_bottom=6, band=0,
               header=168, bottom=150, stem=19, req=14.5, section=46, row_pad=11,
               num=30, chip=92, gap=10),
}
# Sparse cards grow their type and row spacing before leaving empty space.
MAX_SCALE = 1.3
SCALE_STEP = .05
MAX_EXTRA_ROW_PAD = 46
LINE = 1.4


def nice_date(value):
    """2026-11-12 → 11月12日 周四; anything else is shown as written."""
    from datetime import date
    try:
        parsed = date.fromisoformat(value)
    except (TypeError, ValueError):
        return value
    return f'{parsed.month}月{parsed.day}日 周{WEEKDAYS[parsed.weekday()]}'


def text_lines(value, width_px, size_px):
    if not value:
        return 0
    # wrap() works in inches and points; 96 px per inch, 72 pt per inch.
    return len(wrap(value, width_px / 96 * 1.08, size_px * 72 / 96))


def row_height(item, geo, scale, extra_pad):
    text_width = geo['width'] - 2 * geo['pad_x'] - geo['num'] - geo['chip'] - 3 * geo['gap']
    stem = text_lines(item['stem'], text_width, geo['stem'] * scale) * geo['stem'] * scale * LINE
    req = text_lines(item.get('requirement', ''), text_width, geo['req'] * scale) * geo['req'] * scale * LINE
    return max(stem + req, geo['num'] * scale) + 2 * (geo['row_pad'] + extra_pad) + 1


def paginate(sections, geo, usable):
    """Split rows into pages at scale 1; a page break repeats the section head."""
    pages, current, used, last = [], [], 0, None
    for section in sections:
        for item in section['items']:
            height = row_height(item, geo, 1, 0) + (geo['section'] if section is not last else 0)
            if current and used + height > usable:
                pages.append(current)
                current, used = [], 0
                height = row_height(item, geo, 1, 0) + geo['section']
            current.append((section, item))
            used += height
            last = section
    if current:
        pages.append(current)
    return pages


def natural_height(rows, geo, scale=1, extra=0):
    heads = len({id(s) for s, _ in rows}) * geo['section'] * scale
    return heads + sum(row_height(item, geo, scale, extra) for _, item in rows)


def fill(rows, geo, usable):
    """Grow type, then row padding, so a short list does not leave a blank half page."""
    if not rows:
        return 1, 0
    scale = 1
    for step in range(round((MAX_SCALE - 1) / SCALE_STEP), 0, -1):
        candidate = 1 + step * SCALE_STEP
        if natural_height(rows, geo, candidate) <= usable:
            scale = candidate
            break
    slack = usable - natural_height(rows, geo, scale)
    extra = max(0, min(MAX_EXTRA_ROW_PAD, slack / (2 * len(rows))))
    return scale, extra


def review_height(points, geo):
    width = geo['width'] - 2 * geo['pad_x'] - 60
    lines = sum(text_lines(text, width, geo['req']) for _, text in points)
    return 40 + geo['req'] * 1.6 + lines * geo['req'] * LINE + len(points) * 4


def render_card_html(draft, format='group', answer=False):
    draft = validate_card(draft)
    if format not in FORMATS:
        raise ValueError('卡片 format 请改为 group 或 a4')
    geo, meta, warnings = FORMATS[format], draft['meta'], []
    content_height = geo['height'] - geo['band'] - geo['pad_top'] - geo['pad_bottom']
    usable = content_height - geo['header'] - geo['bottom']
    sections = [s for s in draft['sections'] if s['items']]
    all_items = [item for s in sections for item in s['items']]
    numbers = {id(item): item.get('no', n) for n, item in enumerate(all_items, 1)}
    total_minutes = sum(item.get('duration', 0) for item in all_items)
    required = sum(len(s['items']) for s in sections if s.get('tier', 'basic') == 'basic')

    pages = [[rows, usable, ''] for rows in paginate(sections, geo, usable)] or [[[], usable, '']]
    points = [(numbers[id(i)], i['answer']) for i in all_items if i.get('answer')] if answer else []
    if points:
        review = ('<div class="review"><b>讲评要点 · 教师用，请勿发群</b><ol>'
                  + ''.join(f'<li><span>{n}</span>{escape(a)}</li>' for n, a in points) + '</ol></div>')
        needed = review_height(points, geo)
        last = pages[-1]
        if natural_height(last[0], geo) + needed <= usable:
            last[1], last[2] = usable - needed, review
        else:
            pages.append([[], usable, review])

    eyebrow = ' · '.join(escape(meta[k]) for k in ('class_name', 'subject', 'unit') if meta.get(k))
    facts = []
    if meta.get('date'):
        facts.append(f'<span>{escape(nice_date(meta["date"]))} 布置</span>')
    if meta.get('due'):
        facts.append(f'<span class="due">截止 {escape(nice_date(meta["due"]))}</span>')
    facts.append(f'<span>共 {len(all_items)} 项 · 必做 {required} 项</span>')
    total = (f'<div class="total"><b>{total_minutes}</b><small>分钟</small><em>预计用时</em></div>'
             if total_minutes else '')
    header = (f'<header><div class="head-text"><div class="eyebrow">{eyebrow}</div>'
              f'<h1>{escape(meta["title"])}</h1><div class="facts">{"".join(facts)}</div></div>{total}</header>')

    notes = []
    if draft.get('summary'):
        notes.append(f'<p><b>提醒</b><span>{escape(draft["summary"])}</span></p>')
    if meta.get('submit'):
        notes.append(f'<p><b>提交方式</b><span>{escape(meta["submit"])}</span></p>')
    note_box = f'<aside>{"".join(notes)}</aside>' if notes else ''
    # Middle schoolers hand homework in themselves: no parent line, no
    # parent signature block on the notice.
    sign = '<span class="check"><i></i>已完成</span>'

    output = []
    for page_number, (rows, room, review) in enumerate(pages, 1):
        scale, extra = fill(rows, geo, room)
        body, last_section = [], None
        for section, item in rows:
            tier = section.get('tier', 'basic')
            if section is not last_section:
                hint = f'<small>{escape(section["hint"])}</small>' if section.get('hint') else ''
                minutes = sum(i.get('duration', 0) for i in section['items'])
                spent = f'<em>{minutes} 分钟</em>' if minutes else ''
                heading = section['heading']
                title = '' if heading.strip() == TIERS[tier] else f'<strong>{escape(heading)}</strong>'
                body.append(f'<div class="section"><span class="tag {tier}">{TIERS[tier]}</span>'
                            f'{title}{hint}{spent}</div>')
                last_section = section
            requirement = f'<p>{escape(item["requirement"])}</p>' if item.get('requirement') else ''
            chip = f'<span class="chip">{item["duration"]} 分钟</span>' if item.get('duration') else '<span></span>'
            body.append(f'<article class="task {tier}"><span class="no">{numbers[id(item)]}</span>'
                        f'<div class="what"><h2>{escape(item["stem"])}</h2>{requirement}</div>{chip}</article>')
        is_last = page_number == len(pages)
        style = f'--s:{scale:.2f};--pad:{geo["row_pad"] + extra:.1f}px'
        output.append(
            f'<section class="card {format}" data-page="{page_number}">{header}'
            f'<main style="{style}">{"".join(body)}</main>{review}'
            f'<div class="bottom">{note_box if is_last else ""}'
            f'<footer>{sign}<span class="sign">{escape(meta.get("teacher", ""))}<small>{page_number} / {len(pages)}</small></span></footer>'
            f'</div></section>')

    css = card_css(format, geo)
    html = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{escape(meta["title"])}</title>'
            f'<style>{css}</style></head><body>{"".join(output)}</body></html>')
    return {'html': html, 'pages': len(pages), 'warnings': warnings}


def card_css(format, g):
    """One stylesheet for both forms; ``a4`` swaps the cream page for white paper."""
    a4 = format == 'a4'
    k = 1 if not a4 else g['stem'] / 34
    page = '#ffffff' if a4 else '#fffaf4'
    return f'''*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:{'#ffffff' if a4 else '#efe9e2'};color:#3d3846;font-family:{FONT};-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.card{{position:relative;width:{g['width']}px;height:{g['height']}px;margin:0 auto {0 if a4 else 24}px;
padding:{g['pad_top']}px {g['pad_x']}px {g['pad_bottom']}px;background:{page};border-top:{g['band']}px solid #52a277;
display:flex;flex-direction:column;overflow:hidden;break-after:page}}
header{{height:{g['header']}px;flex:none;display:flex;align-items:flex-start;gap:{24 * k}px;border-bottom:{2 * k:.1f}px solid #e6dfd6}}
.head-text{{flex:1;min-width:0}}
.eyebrow{{display:inline-block;font-size:{24 * k:.1f}px;font-weight:600;color:#458c66;background:#e3f6ec;border-radius:999px;padding:{6 * k:.1f}px {18 * k:.1f}px;letter-spacing:.02em}}
h1{{font-size:{66 * k:.1f}px;line-height:1.18;font-weight:800;color:#2f2b36;margin:{20 * k:.1f}px 0 {18 * k:.1f}px;letter-spacing:-.01em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}}
.facts{{display:flex;flex-wrap:wrap;gap:{8 * k:.1f}px {26 * k:.1f}px;font-size:{25 * k:.1f}px;color:#6f6878}}
.facts span+span::before{{content:"";display:inline-block;width:{6 * k:.1f}px;height:{6 * k:.1f}px;border-radius:50%;background:#cfc6bb;margin-right:{26 * k:.1f}px;vertical-align:middle;position:relative;top:-2px}}
.facts .due{{color:#c2673f;font-weight:700}}
.total{{flex:none;width:{178 * k:.1f}px;height:{178 * k:.1f}px;border-radius:{32 * k:.1f}px;background:#52a277;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:{4 * k:.1f}px}}
.total b{{font-size:{72 * k:.1f}px;line-height:1;font-weight:800}}.total small{{font-size:{22 * k:.1f}px;margin-top:{2 * k:.1f}px}}
.total em{{font-style:normal;font-size:{19 * k:.1f}px;opacity:.85;margin-top:{8 * k:.1f}px}}
main{{flex:1;min-height:0;overflow:hidden;padding-top:{8 * k:.1f}px;display:flex;flex-direction:column;justify-content:center}}
.section{{height:calc({g['section']}px * var(--s));display:flex;align-items:flex-end;gap:{14 * k:.1f}px;padding-bottom:calc({12 * k:.1f}px * var(--s));font-size:calc({26 * k:.1f}px * var(--s))}}
.section strong{{font-weight:700;color:#4a4453}}.section small{{font-size:.82em;color:#8a8291}}
.section em{{margin-left:auto;font-style:normal;font-size:.82em;color:#8a8291}}
.tag{{font-size:.8em;font-weight:700;border-radius:{10 * k:.1f}px;padding:.18em .7em;line-height:1.3}}
.tag.basic{{background:#52a277;color:#fff}}.tag.advanced{{background:#fff2cc;color:#94650f}}.tag.challenge{{background:#ede6fe;color:#6a52b3}}
.task{{display:flex;align-items:center;gap:{g['gap']}px;padding:var(--pad) 0;border-top:1px solid #ece5dc}}
.section+.task{{border-top:none}}
.no{{flex:none;width:calc({g['num']}px * var(--s));height:calc({g['num']}px * var(--s));border-radius:50%;display:flex;align-items:center;justify-content:center;
font-size:calc({g['stem'] * .8:.1f}px * var(--s));font-weight:800;background:#e3f6ec;color:#458c66;align-self:flex-start}}
.task.advanced .no{{background:#fff2cc;color:#94650f}}.task.challenge .no{{background:#ede6fe;color:#6a52b3}}
.what{{flex:1;min-width:0}}
.what h2{{font-size:calc({g['stem']}px * var(--s));line-height:{LINE};font-weight:700;color:#2f2b36;word-break:break-word}}
.what p{{font-size:calc({g['req']}px * var(--s));line-height:{LINE};color:#7a7382;word-break:break-word}}
.chip{{flex:none;width:{g['chip']}px;text-align:center;font-size:calc({g['req']}px * var(--s));font-weight:600;color:#458c66;border:1px solid #bfe3cd;background:#f3fbf6;border-radius:999px;padding:.3em 0}}
.review{{flex:none;margin-top:{12 * k:.1f}px;padding:{16 * k:.1f}px {20 * k:.1f}px;border:1px dashed #cfc6bb;border-radius:{18 * k:.1f}px;font-size:{g['req']}px;color:#6f6878}}
.review b{{display:block;font-size:.9em;color:#a24c55;margin-bottom:{6 * k:.1f}px;letter-spacing:.04em}}
.review ol{{list-style:none}}.review li{{line-height:{LINE};margin-top:4px}}.review li span{{display:inline-block;min-width:2em;color:#a39ba8;font-weight:700}}
.bottom{{flex:none;min-height:{g['bottom']}px;display:flex;flex-direction:column;justify-content:flex-end;gap:{18 * k:.1f}px;padding-top:{16 * k:.1f}px}}
aside{{background:#e3f6ec;border:1px solid #c9ead6;border-radius:{26 * k:.1f}px;padding:{22 * k:.1f}px {28 * k:.1f}px;display:flex;flex-direction:column;gap:{12 * k:.1f}px}}
aside p{{display:flex;gap:{18 * k:.1f}px;font-size:{25 * k:.1f}px;line-height:1.45;color:#3d3846}}
aside b{{flex:none;color:#458c66;font-weight:700;min-width:{110 * k:.1f}px}}
footer{{display:flex;justify-content:space-between;align-items:center;font-size:{22 * k:.1f}px;color:#8a8291}}
.check{{display:flex;align-items:center;gap:{10 * k:.1f}px}}.check i{{display:inline-block;width:{24 * k:.1f}px;height:{24 * k:.1f}px;border:{2 * k:.1f}px solid #b9b0a5;border-radius:{6 * k:.1f}px}}
.sign{{font-size:{28 * k:.1f}px;font-weight:700;color:#4a4453;display:flex;align-items:baseline;gap:{18 * k:.1f}px}}.sign small{{font-size:{20 * k:.1f}px;font-weight:400;color:#a39ba8}}
@page{{size:{'A4' if a4 else '1080px 1440px'};margin:{'12mm' if a4 else '0'}}}
@media print{{body{{background:#fff}}.card{{margin:0}}.card:last-child{{break-after:auto}}}}'''
