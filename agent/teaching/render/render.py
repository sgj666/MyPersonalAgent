"""Validation, stable workspace paths and file metadata for teaching exports."""
import re
from pathlib import Path, PurePosixPath

from common.atomic_write import write_text_atomic
from agent.tools.pptx.validation import validate_card, validate_deck

KINDS = ('deck', 'card', 'plan', 'advice')


def workspace_path(workspace, relative):
    """Reject traversal and existing symlinks that resolve beyond this agent."""
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError('路径请填写 workspace 内的相对路径')
    normalized = relative.replace('\\', '/')
    if PurePosixPath(normalized).is_absolute() or '..' in PurePosixPath(normalized).parts or re.match(r'^[A-Za-z]:', normalized):
        raise ValueError('路径不可含 .. 或绝对路径，请使用 workspace 内的相对路径')
    root = Path(workspace).resolve()
    path = (root / normalized).resolve()
    if root != path and root not in path.parents:
        raise ValueError('路径超出 workspace，请移除外部目录或符号链接')
    return path


def slug_name(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('名称请填写非空文字')
    if '..' in value or '/' in value or '\\' in value:
        raise ValueError('名称不可含 .. 或路径分隔符，请只填写文件名')
    slug = re.sub(r'[^\w\-\u4e00-\u9fff]+', '-', value.strip()).strip('-_')[:100]
    if not slug:
        raise ValueError('名称请至少包含一个汉字、字母或数字')
    return slug


def draft_location(workspace, kind, slug):
    if kind not in KINDS:
        raise ValueError('kind 请改为 deck/card/plan/advice')
    slug = slug_name(slug)
    rel = f'artifacts/教学工具/{kind}/{slug}.json'
    return workspace_path(workspace, rel), rel


def validate_draft(kind, draft):
    if kind == 'deck':
        return validate_deck(draft)
    if kind == 'card':
        return validate_card(draft)
    if kind not in KINDS or not isinstance(draft, dict):
        raise ValueError('草稿请使用 JSON 对象，kind 请改为 deck/card/plan/advice')
    return draft


def render_draft(kind, draft, out_name=None, formats=None, a4=False, workspace=None):
    if kind not in ('deck', 'card'):
        raise ValueError('渲染 kind 请改为 deck 或 card')
    draft = validate_draft(kind, draft)
    if workspace is None:
        from common.state_dir import real_state_root
        workspace = real_state_root()
    root = Path(workspace).resolve()
    slug = slug_name(out_name if out_name is not None else draft['meta']['title'])
    if formats is None:
        formats = ('pptx', 'html') if kind == 'deck' else ('html',)
    allowed = ('pptx', 'html') if kind == 'deck' else ('html', 'a4')
    if not isinstance(formats, (list, tuple)) or not formats or any(f not in allowed for f in formats):
        raise ValueError(f'{kind} formats 请使用：' + ' / '.join(allowed))
    if not isinstance(a4, bool):
        raise ValueError('a4 请使用 true 或 false')
    formats = list(dict.fromkeys(formats))
    if a4 and kind == 'card' and 'a4' not in formats:
        formats.append('a4')
    # Image references are local to this agent, just like output paths.
    if kind == 'deck':
        for slide in draft['slides']:
            image = slide.get('image')
            if image and image.get('path'):
                source = image['path']
                if Path(source).is_absolute():
                    if '..' in Path(source).parts:
                        raise ValueError('图片路径不可含 ..，请使用 workspace 内的图片')
                    try:
                        source = Path(source).resolve().relative_to(root).as_posix()
                    except ValueError:
                        raise ValueError('图片路径超出 workspace，请先将图片保存到当前 workspace')
                image['path'] = str(workspace_path(root, source))
    files, warnings = [], []
    for fmt in formats:
        suffix = '.pptx' if fmt == 'pptx' else ('-a4.html' if fmt == 'a4' else '.html')
        rel = f'artifacts/教学工具/{kind}/{slug}/{slug}{suffix}'
        target = workspace_path(root, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        if fmt == 'pptx':
            from agent.tools.pptx import build_deck
            result = build_deck(draft, target)
        else:
            if kind == 'deck':
                from agent.teaching.render.deck_html import render_deck_html
                result = render_deck_html(draft)
            else:
                from agent.teaching.render.card_html import render_card_html
                result = render_card_html(draft, format='a4' if fmt == 'a4' else 'group')
            write_text_atomic(target, result['html'])
        warnings.extend(result['warnings'])
        files.append({'format': fmt, 'path': str(target), 'rel': rel,
                      'size': target.stat().st_size, 'pages': result['pages']})
    return {'files': files, 'warnings': list(dict.fromkeys(warnings))}
