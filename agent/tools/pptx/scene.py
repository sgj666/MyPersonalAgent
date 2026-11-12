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
        shape(0, 0, WIDTH, .16, theme.accent)
        if layout == 'cover':
            # A soft panel bleeding off the right edge gives the cover a
            # composition instead of a lone column of text on white.
            shape(8.05, .16, WIDTH - 8.05, HEIGHT - .16, theme.accent + '0E')
            shape(8.05, .16, .055, HEIGHT - .16, theme.accent + '33')
            shape(.8, 2.02, .09, 1.55, theme.accent)
            text(slide['title'], 1.15, 1.95, 6.75, 1.5, 32, True, theme.title)
            text(slide.get('subtitle', spec['meta'].get('subtitle', '')), 1.18, 3.6, 6.7, 1.0, 20)
            text('  ·  '.join(str(spec['meta'].get(k, '')) for k in ('teacher', 'date') if spec['meta'].get(k)),
                 1.18, 5.75, 6.7, .5, 14)
        elif layout == 'end':
            shape(.8, 2.0, .09, 1.55, theme.accent)
            text(slide['title'], 1.15, 2.0, 10.9, 1.4, 32, True, theme.title)
            text(slide.get('subtitle', ''), 1.18, 3.6, 10.6, 1.0, 20)
            if spec['meta'].get('teacher'):
                text('  ·  '.join(str(spec['meta'].get(k, '')) for k in ('teacher', 'date') if spec['meta'].get(k)),
                     1.18, 5.75, 10, .5, 14)
        else:
            text(slide['title'], .75, .48, 11.8, .85, 32, True, theme.title)
            shape(.8, 1.42, 1.05, .05, theme.accent)
            # A hairline footer with the unit on the left and the number on the
            # right: cheap orientation for the teacher while presenting.
            shape(.8, 6.9, 11.72, .012, 'E6E9EF')
            footer = '  ·  '.join(str(spec['meta'].get(k, '')) for k in ('unit', 'subject') if spec['meta'].get(k))
            if footer:
                text(footer, .8, 6.99, 9, .35, 14)
            if layout in ('two-col', 'compare'):
                for i, col in enumerate(slide['columns']):
                    x = .8 + i * 6.05
                    shape(x, 1.85, 5.6, 4.75, theme.accent + '0E', True)
                    shape(x + .32, 2.1, .5, .06, theme.accent)
                    text(col.get('heading', ''), x + .3, 2.24, 5.0, .7, 24, True, theme.title)
                    items(col.get('bullets', []), x + .3, 3.1, 4.95, 3.15, 20)
            elif layout in ('process', 'timeline'):
                steps = slide['steps']
                if layout == 'process':
                    w = 11.7 / len(steps)
                    for i, step in enumerate(steps):
                        x = .8 + i * w
                        shape(x, 2.3, w - .18, 3.75, theme.accent + '0E', True)
                        shape(x + .22, 2.52, .62, .62, theme.accent, True)
                        text(f'{i + 1:02}', x + .26, 2.6, .55, .45, 16, True, 'FFFFFF')
                        text(step.get('label', ''), x + .2, 3.4, w - .58, .8, 24, True, theme.title)
                        text(step.get('text', ''), x + .2, 4.3, w - .58, 1.4, 20)
                else:
                    h = 4.55 / len(steps)
                    shape(3.02, 2.02, .03, 4.55, theme.accent + '33')
                    for i, step in enumerate(steps):
                        y = 1.95 + i * h
                        shape(2.9, y + .28, .27, .27, theme.accent, True)
                        text(step.get('label', ''), .8, y + .2, 1.95, h - .08, 20, True, theme.accent)
                        text(step.get('text', ''), 3.42, y + .2, 8.9, h - .08, 20)
            elif layout == 'table':
                data = slide['table']
                elements.append(dict(kind='table', x=.8, y=1.9, w=11.7, h=4.7, data=data))
            elif layout == 'image':
                image = slide.get('image', {})
                elements.append(dict(kind='image', x=.8, y=1.85, w=11.7, h=4.05, image=image))
                text(image.get('caption', ''), .8, 6.05, 11.7, .55, 16)
            elif layout == 'quote':
                shape(.8, 1.85, 11.7, 4.75, theme.accent + '08', True)
                shape(1.15, 2.2, .09, 3.5, theme.accent)
                text('\u201c', 1.5, 1.95, 1.4, 1.4, 32, True, theme.accent)
                text(slide.get('quote', ''), 1.75, 2.75, 9.9, 2.9, 32, False, theme.title)
            elif layout in ('agenda', 'objectives'):
                values = slide.get('bullets', [])
                row = 4.6 / max(1, len(values))
                for i, value in enumerate(values):
                    y = 1.9 + i * row
                    if layout == 'objectives':
                        shape(.8, y, 11.7, row - .12, theme.accent + '0E', True)
                    shape(1.02, y + .16, .52, .52, theme.accent, True)
                    text(f'{i + 1:02}', 1.05, y + .22, .46, .4, 16, True, 'FFFFFF')
                    text(value, 1.95, y + .14, 10.2, row - .3, 24)
            elif layout == 'summary':
                shape(.8, 1.9, 11.7, 4.7, theme.accent + '0E', True)
                items(slide.get('bullets', []), 1.2, 2.2, 10.8, 4.1)
            else:
                items(slide.get('bullets', []), .9, 1.9, 11.4, 4.6)
        text(str(number), 12.0, 6.99, .55, .3, 14)
        pages.append(dict(layout=layout, title=slide['title'], notes=slide.get('notes', ''), elements=elements))
    return pages, theme, warnings


def table_cells(data, width, height, warnings, label):
    rows = [data['headers']] + data['rows']
    w, h = width / len(rows[0]), height / len(rows)
    return [[fit_text(cell, w - .2, h - .08, 20, warnings, label)[0:2] for cell in row] for row in rows]
