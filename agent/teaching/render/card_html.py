"""Offline homework sheets, with answer-free student copies and printable pages."""
from html import escape

from agent.tools.pptx.scene import fit_text
from agent.tools.pptx.validation import validate_card
from agent.teaching.render.deck_html import FONT

TIERS = {'basic': '基础', 'advanced': '提升', 'challenge': '挑战'}


def render_card_html(draft, format='group', answer=False):
    draft = validate_card(draft)
    if format not in ('group', 'a4'):
        raise ValueError('卡片 format 请改为 group 或 a4')
    meta, warnings = draft['meta'], []
    # Both forms paginate whole questions. Extremely long questions get a warning
    # and are fitted to a single page rather than escaping the capture viewport.
    width, height = (1080, 1440) if format == 'group' else (704, 1032)
    font = 26 if format == 'group' else 17
    content_width = width - 96
    usable = height - 470 if format == 'group' else height - 385
    pages, blocks, used = [], [], 0

    def add(block, block_height):
        nonlocal blocks, used
        if blocks and used + block_height > usable:
            pages.append(blocks)
            blocks, used = [], 0
        blocks.append(block)
        used += block_height

    for section in draft['sections']:
        heading = (f'<div class="section-heading"><span class="tier {section.get("tier", "basic")}">{TIERS[section.get("tier", "basic")]}</span>'
                   f'<strong>{escape(section["heading"])}</strong><small>{escape(section.get("hint", ""))}</small></div>')
        if not section['items']:
            add(heading, 60)
        for index, item in enumerate(section['items']):
            prefix = heading if index == 0 else ''
            label = f'第 {item.get("no", index + 1)} 题'
            stem = f'{item.get("no", index + 1)}. {item["stem"]}'
            kind = item['type']
            if kind == 'choice':
                stem += ' （    ）'
            if kind == 'fill' and '_' not in stem:
                stem += ' ____________'
            options = '\n'.join(item.get('options', []))
            raw = stem + ('\n' + options if options else '')
            if answer:
                raw += '\n答案：' + (item.get('answer') or '（略）')
            line_count = item.get('lines', 3 if kind in ('short', 'read', 'match') else 0)
            if kind in ('fill', 'choice'):
                line_count = 0
            # Writing lines share the same finite page capacity as question text.
            max_lines = max(0, int((usable - 140) / (font * 1.65)) - 3)
            if line_count > max_lines:
                line_count = max_lines
                warnings.append(label + '作答留白过多，已减少行数，请拆题')
            blanks_height = line_count * font * 1.65
            available = usable - 100 - blanks_height
            fitted, size = fit_text(raw, content_width / 96, available / 96,
                                     font * 72 / 96, warnings, label)
            px = size * 96 / 72
            # Card uses a smaller A4 type scale; fit_text never enlarges it.
            text_height = max(px * 1.35, len(fitted.split('\n')) * px * 1.35)
            block_height = text_height + blanks_height + 30 + (60 if prefix else 0)
            blank = ''.join('<div class="answer-line"></div>' for _ in range(line_count))
            block = (f'{prefix}<article class="question" style="font-size:{px}px"><div class="stem">{escape(fitted)}</div>{blank}</article>')
            if used + block_height > usable and blocks:
                pages.append(blocks)
                blocks, used = [], 0
                if not prefix:
                    block = heading + block
                    block_height += 60
            add(block, block_height)
    if blocks:
        pages.append(blocks)
    summary, summary_size = fit_text(draft.get('summary', ''), content_width / 96, .35,
                                     20 if format == 'group' else 14, warnings, '给家长的话')
    title, title_size = fit_text(meta['title'], content_width / 96, .85,
                                32 if format == 'group' else 24, warnings, '卡片标题')
    footer = draft.get('footer', {})
    foot = ('得分：________' if footer.get('score') else '') + ('　家长签字：____________' if footer.get('parent_sign') else '')
    output = []
    for page_number, page in enumerate(pages, 1):
        header = (f'<header><div class="eyebrow">{escape(meta.get("class_name", ""))} · {escape(meta.get("subject", ""))} · {escape(meta.get("unit", ""))}</div>'
                  f'<h1 style="font-size:{title_size * 96 / 72}px">{escape(title)}</h1>'
                  f'<div class="details">日期：{escape(meta.get("date", ""))}　截止：{escape(meta.get("due", ""))}　姓名：________</div></header>')
        parent = f'<aside><b>给家长的话</b><p style="font-size:{summary_size * 96 / 72}px">{escape(summary)}</p></aside>'
        badge = '<div class="watermark">答案版</div>' if answer else ''
        output.append(f'<section class="card {format}" data-page="{page_number}">{badge}{header}<main>{"".join(page)}</main>{parent}<footer>{foot}<span>{escape(meta.get("teacher", ""))}　{page_number} / {len(pages)}</span></footer></section>')
    css = f'''*{{box-sizing:border-box}}body{{margin:0;background:#e8eeeb;color:#203d34;font-family:{FONT}}}
.card{{position:relative;width:{width}px;height:{height}px;margin:0 auto 24px;padding:40px 48px;background:#fffdf7;border-top:12px solid #428271;overflow:hidden;break-after:page}}
header{{height:{220 if format == 'group' else 155}px;border-bottom:2px solid #dce8df}}.eyebrow{{font-size:{font}px;color:#4a7665}}h1{{margin:20px 0;white-space:pre;line-height:1.2}}.details{{font-size:{font * .75}px;color:#62756c}}
main{{height:{usable}px;overflow:hidden;padding-top:14px}}.section-heading{{height:60px;display:flex;align-items:center;gap:12px;font-size:{font}px}}small{{margin-left:auto;font-size:.65em;color:#68776f}}
.tier{{font-size:.65em;border-radius:20px;padding:6px 14px;background:#e1eee4}}.advanced{{background:#fff0d2}}.challenge{{background:#f4dfe8}}
.question{{margin:0 0 22px;break-inside:avoid}}.stem{{white-space:pre;line-height:1.35;overflow:hidden}}.answer-line{{height:{font * 1.65}px;border-bottom:1px solid #b4c4bb}}
aside{{background:#edf3e9;border-radius:16px;padding:14px 20px;height:{110 if format == 'group' else 90}px;font-size:{font * .7}px;overflow:hidden}}aside p{{margin:8px 0 0;white-space:pre;line-height:1.2}}footer{{display:flex;justify-content:space-between;font-size:{font * .65}px;margin-top:18px;color:#64756b}}.watermark{{position:absolute;right:30px;top:22px;transform:rotate(12deg);border:3px solid #a24c55;color:#a24c55;opacity:.55;padding:8px 20px;font-size:28px}}
@page{{size:{'A4' if format == 'a4' else '1080px 1440px'};margin:{'12mm' if format == 'a4' else '0'}}}@media print{{body{{background:white}}.card{{margin:0}}.card:last-child{{break-after:auto}}}}'''
    html = f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{escape(meta["title"])}</title><style>{css}</style></head><body>{"".join(output)}</body></html>'
    return {'html': html, 'pages': len(pages), 'warnings': warnings}
