"""Offline v1 deck renderer. Every slide is explicit; output is editable OOXML."""
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Emu, Inches, Pt

from agent.tools.pptx.scene import deck_scenes, table_cells
from agent.tools.pptx.validation import MAX_BULLET_CHARS, MAX_SLIDES

__all__ = ["build_deck", "MAX_BULLET_CHARS", "MAX_SLIDES"]

SLIDE_WIDTH, SLIDE_HEIGHT = Emu(12192000), Emu(6858000)


def _color(value):
    if len(value) == 8:
        alpha = int(value[-2:], 16) / 255
        value = ''.join(f'{round(int(value[i:i+2], 16) * alpha + 255 * (1-alpha)):02X}' for i in (0, 2, 4))
    return RGBColor.from_string(value)


def _fill(shape, color):
    shape.fill.solid()
    shape.fill.fore_color.rgb = _color(color)
    shape.line.fill.background()


def _text(frame, value, size, color, bold=False):
    frame.clear()
    frame.word_wrap = False  # The shared layout engine has already wrapped to capacity.
    frame.margin_left = frame.margin_right = 0
    frame.margin_top = frame.margin_bottom = 0
    for i, line in enumerate(value.split('\n')):
        paragraph = frame.paragraphs[0] if i == 0 else frame.add_paragraph()
        paragraph.line_spacing = 1.2
        paragraph.space_after = Pt(0)
        run = paragraph.add_run()
        run.text = line
        run.font.name, run.font.size, run.font.bold = 'Calibri', Pt(size), bold
        run.font.color.rgb = _color(color)
        ea = OxmlElement('a:ea')
        ea.set('typeface', '等线')
        run._r.get_or_add_rPr().append(ea)


def _image(slide, element, theme, warnings, number):
    x, y, w, h = [Inches(element[k]) for k in ('x', 'y', 'w', 'h')]
    image = element['image']
    path = Path(image.get('path', ''))
    if image.get('path') and path.is_file():
        try:
            if image.get('fit', 'contain') == 'cover':
                picture = slide.shapes.add_picture(str(path), x, y)
                picture_ratio = picture.width / picture.height
                target_ratio = w / h
                picture.width, picture.height = w, h
                if picture_ratio > target_ratio:
                    crop = (1 - target_ratio / picture_ratio) / 2
                    picture.crop_left = picture.crop_right = crop
                else:
                    crop = (1 - picture_ratio / target_ratio) / 2
                    picture.crop_top = picture.crop_bottom = crop
            else:
                picture = slide.shapes.add_picture(str(path), x, y)
                ratio = min(w / picture.width, h / picture.height)
                picture.width, picture.height = round(picture.width * ratio), round(picture.height * ratio)
                picture.left, picture.top = x + (w - picture.width) // 2, y + (h - picture.height) // 2
            return
        except (OSError, ValueError):
            warnings.append(f'第 {number} 页图片无法读取，已使用占位框，请替换图片')
    else:
        warnings.append(f'第 {number} 页图片缺失，已使用占位框，请补充 image.path')
    box = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, x, y, w, h)
    _fill(box, 'F2F5F9')
    from agent.tools.pptx.scene import fit_text
    caption, size = fit_text('图片占位\n' + image.get('caption', ''), element['w'] - .5,
                             element['h'] - .5, 24, warnings, f'第 {number} 页图片说明')
    _text(box.text_frame, caption, size, theme.body)


def build_deck(spec, out_path):
    """Validate, render, and return absolute path, page count and layout warnings."""
    pages, theme, warnings = deck_scenes(spec)
    if not isinstance(out_path, (str, Path)) or not str(out_path).strip():
        raise ValueError('输出路径请填写非空文件路径')
    prs = Presentation()
    prs.slide_width, prs.slide_height = SLIDE_WIDTH, SLIDE_HEIGHT
    for number, page in enumerate(pages, 1):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        slide.name = page['layout']
        for element in page['elements']:
            x, y, w, h = [Inches(element[k]) for k in ('x', 'y', 'w', 'h')]
            kind = element['kind']
            if kind == 'shape':
                box = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if element['rounded'] else MSO_SHAPE.RECTANGLE, x, y, w, h)
                _fill(box, element['color'])
            elif kind == 'text':
                box = slide.shapes.add_textbox(x, y, w, h)
                box.name = 'title' if element['text'] == page['title'] else 'text'
                _text(box.text_frame, element['text'], element['size'], element['color'], element['bold'])
            elif kind == 'image':
                _image(slide, element, theme, warnings, number)
            elif kind == 'table':
                cells = table_cells(element['data'], element['w'], element['h'], warnings, f'第 {number} 页表格')
                table = slide.shapes.add_table(len(cells), len(cells[0]), x, y, w, h).table
                for row_index, row in enumerate(cells):
                    table.rows[row_index].height = h // len(cells)
                    for col_index, (value, size) in enumerate(row):
                        cell = table.cell(row_index, col_index)
                        cell.margin_left = cell.margin_right = Inches(.08)
                        cell.margin_top = cell.margin_bottom = Inches(.03)
                        cell.fill.solid()
                        cell.fill.fore_color.rgb = _color(theme.accent if row_index == 0 else ('F2F5F9' if row_index % 2 else 'FFFFFF'))
                        _text(cell.text_frame, value, size, 'FFFFFF' if row_index == 0 else theme.body, row_index == 0)
            if kind in ('shape', 'text'):
                box.shadow.inherit = False
        if page['notes']:
            slide.notes_slide.notes_text_frame.text = page['notes']
    path = Path(out_path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(path))
    return {'path': str(path), 'pages': len(pages), 'warnings': warnings}
