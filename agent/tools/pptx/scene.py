"""One layout geometry for editable PowerPoint and the offline HTML preview."""
import math
import re
import unicodedata

from agent.tools.pptx.themes import THEMES
from agent.tools.pptx.validation import validate_deck

WIDTH, HEIGHT = 13.3333333333, 7.5
SIZES = (32, 24, 20, 16, 14)


def wrap(text, width, size):
    capacity = max(1, width * 72 / size)
    lines, current, used = [], '', 0
    tokens = re.findall(r"[A-Za-z0-9_]+(?:['’][A-Za-z]+)?[.,!?;:]?|[^\S\n]+|\n|.", text)
    for token in tokens:
        units = sum(1 if unicodedata.east_asian_width(c) in ('W', 'F') else .62 for c in token)
        if token == '\n' or (current and used + units > capacity):
            lines.append(current.rstrip())
            current, used = '', 0
        if token == '\n' or (not current and token.isspace()):
            continue
        if units <= capacity:
            current += token
            used += units
        else:
            for char in token:
                unit = 1 if unicodedata.east_asian_width(char) in ('W', 'F') else .62
                if current and used + unit > capacity:
                    lines.append(current)
                    current, used = '', 0
                current += char
                used += unit
    lines.append(current)
    return lines


def fit_text(text, width, height, size, warnings, label):
    # Reserve space for bold glyphs and font substitution on another machine.
    for candidate in ([size] if size < 14 else [s for s in SIZES if s <= size]):
        lines = wrap(text, width * .92, candidate)
        capacity = max(1, math.floor(height * 72 / (candidate * 1.35)))
        if len(lines) <= capacity:
            return '\n'.join(lines), candidate
    lines = lines[:capacity]
    lines[-1] = lines[-1][:-1] + '…'
    warnings.append(f'{label}内容超出容量，已缩小到 14 号后截断，请精简文字')
    return '\n'.join(lines), candidate


def deck_scenes(spec):
    spec = validate_deck(spec)
    theme = THEMES[spec.get('theme', 'lecture')]
    warnings, pages = [], []
    for number, slide in enumerate(spec['slides'], 1):
        elements = []
        label = f'第 {number} 页'

        def shape(x, y, w, h, color='F2F5F9', rounded=False):
            elements.append(dict(kind='shape', x=x, y=y, w=w, h=h, color=color, rounded=rounded))

        def text(value, x, y, w, h, size=24, bold=False, color=None):
            value, size = fit_text(value, w, h, size, warnings, label)
            elements.append(dict(kind='text', text=value, x=x, y=y, w=w, h=h,
                                 size=size, bold=bold, color=color or theme.body))

        def items(values, x, y, w, h, size=24):
            if not values:
                return
            row = h / len(values)
            for i, value in enumerate(values):
                shape(x, y + i * row + .14, .055, .22, theme.accent)
                text(value, x + .26, y + i * row, w - .32, row - .12, size)

        layout = slide['layout']
        shape(0, 0, WIDTH, .13, theme.accent)
        if layout in ('cover', 'end'):
            shape(.8, 2, .09, 2.1, theme.accent)
            text(slide['title'], 1.15, 2, 10.9, 1.4, 32, True, theme.title)
            text(slide.get('subtitle', spec['meta'].get('subtitle', '') if layout == 'cover' else ''),
                 1.18, 3.65, 10.6, 1.1, 20)
            if layout == 'cover':
                text('  '.join(str(spec['meta'].get(k, '')) for k in ('teacher', 'date')).strip(),
                     1.18, 5.7, 10, .5, 14)
        else:
            text(slide['title'], .75, .48, 11.8, .85, 32, True, theme.title)
            shape(.8, 1.5, 1.25, .045, theme.accent)
            if layout in ('two-col', 'compare'):
                for i, col in enumerate(slide['columns']):
                    x = .8 + i * 6
                    shape(x, 1.9, 5.7, 4.7, theme.accent + '12', True)
                    text(col.get('heading', ''), x + .3, 2.15, 5.1, .7, 24, True, theme.title)
                    items(col.get('bullets', []), x + .3, 3.1, 5.05, 3.15, 20)
            elif layout in ('process', 'timeline'):
                steps = slide['steps']
                if layout == 'process':
                    w = 11.7 / len(steps)
                    for i, step in enumerate(steps):
                        x = .8 + i * w
                        shape(x, 2.35, w - .18, 3.7, theme.accent + '12', True)
                        text(f'{i + 1:02}', x + .2, 2.6, w - .58, .55, 20, True, theme.accent)
                        text(step.get('label', ''), x + .2, 3.35, w - .58, .8, 24, True, theme.title)
                        text(step.get('text', ''), x + .2, 4.25, w - .58, 1.4, 20)
                else:
                    h = 4.65 / len(steps)
                    shape(2.9, 1.95, .035, 4.65, theme.accent)
                    for i, step in enumerate(steps):
                        y = 1.95 + i * h
                        text(step.get('label', ''), .8, y, 1.9, h - .08, 20, True, theme.accent)
                        text(step.get('text', ''), 3.3, y, 9, h - .08, 20)
            elif layout == 'table':
                data = slide['table']
                elements.append(dict(kind='table', x=.8, y=1.95, w=11.7, h=4.65, data=data))
            elif layout == 'image':
                image = slide.get('image', {})
                elements.append(dict(kind='image', x=.8, y=1.95, w=11.7, h=3.95, image=image))
                text(image.get('caption', ''), .8, 6.05, 11.7, .55, 16)
            elif layout == 'quote':
                shape(1.1, 2.15, .07, 3.65, theme.accent)
                text(slide.get('quote', ''), 1.55, 2.35, 10.25, 3.4, 32, False, theme.title)
            elif layout in ('agenda', 'objectives'):
                values = slide.get('bullets', [])
                row = 4.65 / max(1, len(values))
                for i, value in enumerate(values):
                    y = 1.95 + i * row
                    if layout == 'objectives':
                        shape(.8, y, 11.7, row - .12, theme.accent + '12', True)
                    text(f'{i + 1:02}', 1.05, y + .12, .65, row - .3, 20, True, theme.accent)
                    text(value, 2, y + .12, 10.1, row - .3, 24)
            elif layout == 'summary':
                shape(.8, 1.95, 11.7, 4.65, theme.accent + '12', True)
                items(slide.get('bullets', []), 1.15, 2.2, 10.9, 4.15)
            else:
                items(slide.get('bullets', []), .9, 1.95, 11.4, 4.65)
        text(str(number), 12, 6.95, .65, .3, 14)
        pages.append(dict(layout=layout, title=slide['title'], notes=slide.get('notes', ''), elements=elements))
    return pages, theme, warnings


def table_cells(data, width, height, warnings, label):
    rows = [data['headers']] + data['rows']
    w, h = width / len(rows[0]), height / len(rows)
    return [[fit_text(cell, w - .2, h - .08, 20, warnings, label)[0:2] for cell in row] for row in rows]
