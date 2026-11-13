"""Single-file 1280×720 HTML using the same geometry as PowerPoint."""
import base64
from html import escape
from pathlib import Path

from agent.tools.pptx.scene import deck_scenes, table_cells

FONT = '"PingFang SC","Microsoft YaHei",sans-serif'


def _geometry(element):
    return ';'.join(f'{prop}:{element[key] * 96:.3f}px' for prop, key in
                    (('left', 'x'), ('top', 'y'), ('width', 'w'), ('height', 'h')))


def render_deck_html(draft):
    """Return HTML, page count and warnings; images are embedded as data URLs."""
    authored = [slide for slide in draft.get('slides') or []
                if slide.get('svg') is not None or slide.get('svg_path') is not None]
    if authored:
        return _render_svg_deck(draft, authored)
    pages, theme, warnings = deck_scenes(draft)
    content = []
    for number, page in enumerate(pages, 1):
        parts = []
        for el in page['elements']:
            geometry = _geometry(el)
            if el['kind'] == 'shape':
                parts.append(f'<div class="shape" style="{geometry};background:#{el["color"]};border-radius:{20 if el["rounded"] else 0}px"></div>')
            elif el['kind'] == 'text':
                parts.append(f'<div class="text" style="{geometry};font-size:{el["size"] * 96 / 72:.3f}px;font-weight:{700 if el["bold"] else 400};color:#{el["color"]}">{escape(el["text"])}</div>')
            elif el['kind'] == 'image':
                image = el['image']
                path = Path(image.get('path', ''))
                mime = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp'}.get(path.suffix.lower())
                if image.get('path') and path.is_file() and mime:
                    data = base64.b64encode(path.read_bytes()).decode('ascii')
                    parts.append(f'<img alt="{escape(image.get("caption", ""), quote=True)}" style="{geometry};object-fit:{image.get("fit", "contain")}" src="data:{mime};base64,{data}">')
                else:
                    warnings.append(f'第 {number} 页图片缺失或格式不支持，已使用占位框，请补充图片')
                    parts.append(f'<div class="placeholder" style="{geometry}">图片占位<br>{escape(image.get("caption", ""))}</div>')
            elif el['kind'] == 'table':
                cells = table_cells(el['data'], el['w'], el['h'], warnings, f'第 {number} 页表格')
                rows = []
                for i, row in enumerate(cells):
                    tag = 'th' if i == 0 else 'td'
                    rows.append('<tr>' + ''.join(f'<{tag} style="font-size:{size * 96 / 72:.3f}px">{escape(value)}</{tag}>' for value, size in row) + '</tr>')
                parts.append(f'<table style="{geometry}">{"".join(rows)}</table>')
        content.append(f'<section class="slide" data-slide="{number}" data-layout="{page["layout"]}" aria-label="{escape(page["title"], quote=True)}">{"".join(parts)}</section>')
    css = f'''*{{box-sizing:border-box}}body{{margin:0;background:#e7eaf0;font-family:{FONT}}}
.slide{{position:relative;width:1280px;height:720px;background:white;overflow:hidden;margin:0 auto 24px;break-after:page}}
.shape,.text,img,.placeholder,table{{position:absolute}}.text{{white-space:pre;line-height:1.2;overflow:hidden}}
.placeholder{{display:flex;flex-direction:column;align-items:center;justify-content:center;background:#f2f5f9;border:2px dashed #{theme.accent};border-radius:20px;font-size:26px;color:#{theme.body};overflow:hidden;overflow-wrap:anywhere;text-align:center;padding:24px}}
table{{border-collapse:collapse;table-layout:fixed}}th,td{{white-space:pre;overflow:hidden;line-height:1.2;padding:4px 8px;border:1px solid #dbe1e8}}th{{background:#{theme.accent};color:white}}td{{color:#{theme.body}}}tr:nth-child(even){{background:#f2f5f9}}
@page{{size:1280px 720px;margin:0}}@media print{{body{{background:white}}.slide{{margin:0}}.slide:last-child{{break-after:auto}}}}'''
    html = f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{escape(draft["meta"]["title"])}</title><style>{css}</style></head><body>{"".join(content)}</body></html>'
    return {'html': html, 'pages': len(pages), 'warnings': warnings}


def _render_svg_deck(draft, slides):
    """Preview for ppt-master pages: the SVG is the page, so it is the preview.

    The same text the exporter turns into DrawingML shapes is what the teacher
    sees here — no second renderer to drift from the delivered deck.
    """
    warnings = []
    content = []
    for number, slide in enumerate(slides, 1):
        svg = slide.get('svg')
        if svg is None:
            path = Path(slide['svg_path'])
            svg = path.read_text(encoding='utf-8') if path.is_file() else ''
            if not svg:
                warnings.append(f'第 {number} 页找不到 SVG：{slide["svg_path"]}')
                svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><text x="60" y="360" font-size="28" fill="#c2673f">第 {number} 页 SVG 缺失</text></svg>'
        title = escape(str(slide.get('title') or ''), quote=True)
        content.append(f'<section class="slide" data-slide="{number}" aria-label="{title}">{svg}</section>')
    css = ('*{box-sizing:border-box}body{margin:0;background:#e7eaf0;font-family:' + FONT + '}'
           '.slide{position:relative;width:1280px;height:720px;background:white;overflow:hidden;'
           'margin:0 auto 24px;break-after:page}.slide>svg{display:block;width:1280px;height:720px}'
           '@page{size:1280px 720px;margin:0}'
           '@media print{body{background:white}.slide{margin:0}.slide:last-child{break-after:auto}}')
    html = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>'
            + escape(draft['meta']['title']) + '</title><style>' + css + '</style></head><body>'
            + ''.join(content) + '</body></html>')
    return {'html': html, 'pages': len(slides), 'warnings': warnings}
