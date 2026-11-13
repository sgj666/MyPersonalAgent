"""Native .pptx export through the vendored ppt-master skill.

The deck's pages are authored as SVG (one file per slide, 1280×720). ppt-master
converts each SVG into native DrawingML shapes with `svg_to_pptx.py`, so the
teacher opens an editable deck — real text boxes and shapes, not a picture of a
slide.

This module owns the two rules ppt-master's Quick route enforces: the quality
report must pass and its fingerprint must match the pages being exported, so we
always run the checker first. Everything runs offline with the interpreter that
runs the backend (python-pptx is already a requirement); the skill itself lives
under `skills/ppt-master/` and is never modified at runtime.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SKILL_DIR = REPO_ROOT / 'skills' / 'ppt-master'
CHECKER = SKILL_DIR / 'scripts' / 'svg_quality_checker.py'
EXPORTER = SKILL_DIR / 'scripts' / 'svg_to_pptx.py'

# The exporter is fast (seconds for a dozen pages); a minute means something is
# wrong and the caller should get the log, not a stuck request.
TIMEOUT = 180


class DeckExportError(ValueError):
    """A failed export, with the reason a teacher can act on."""


def available() -> bool:
    return CHECKER.is_file() and EXPORTER.is_file()


def _run(args, project: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    # The exporter and checker import python-pptx from this interpreter.
    env['PYTHONPATH'] = str(SKILL_DIR / 'scripts')
    env['PPT_MASTER_PROJECT_PATH'] = str(project)
    return subprocess.run(
        [sys.executable, *args],
        cwd=str(project),
        env=env,
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )


def _tail(result: subprocess.CompletedProcess) -> str:
    text = (result.stdout or '') + (result.stderr or '')
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return ' / '.join(lines[-4:])[:600]


def build_pptx(pages, out_path):
    """Render `pages` (ordered (filename, svg_text, notes_text)) to a .pptx.

    Returns ``{'path', 'pages', 'warnings'}``; raises DeckExportError with a
    readable reason when the skill refuses the input.
    """
    if not available():
        raise DeckExportError('课件渲染器未安装：缺少 skills/ppt-master/scripts/svg_to_pptx.py')
    if not pages:
        raise DeckExportError('课件没有页面：请先生成至少一页 SVG')

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    warnings: list[str] = []

    with tempfile.TemporaryDirectory(prefix='cow-deck-') as tmp:
        project = Path(tmp)
        svg_dir = project / 'svg_output'
        svg_dir.mkdir()
        notes_dir = project / 'notes'
        has_notes = False
        for name, svg, note in pages:
            (svg_dir / name).write_text(svg, encoding='utf-8')
            if note and note.strip():
                # The exporter matches a note by its SVG's filename stem.
                notes_dir.mkdir(exist_ok=True)
                (notes_dir / (Path(name).stem + '.md')).write_text(note.strip(), encoding='utf-8')
                has_notes = True

        check = _run([str(CHECKER), str(project), '--quick-generate',
                      '--canonical-authoring', '--stage', 'final', '--json'], project)
        if check.returncode != 0:
            raise DeckExportError('SVG 质检未通过（第 ' + '、'.join(
                _blocking_pages(project)) + ' 页）：' + _tail(check))
        warnings.extend(_report_warnings(project))

        export = _run([str(EXPORTER), str(project), '--quick-generate',
                       '--with-notes' if has_notes else '--no-notes',
                       '-o', str(out_path)], project)
        if export.returncode != 0:
            raise DeckExportError('PPTX 导出失败：' + _tail(export))
        if not out_path.is_file() or out_path.stat().st_size == 0:
            raise DeckExportError('PPTX 导出没有产出文件：' + _tail(export))
        warnings.extend(_postflight_warnings(export.stdout or ''))

    return {'path': str(out_path), 'pages': len(pages),
            'warnings': list(dict.fromkeys(warnings))}


def _blocking_pages(project: Path) -> list:
    """The pages the checker flagged, so the message can name them."""
    report = project / 'validation' / 'svg_quality_report.json'
    try:
        data = json.loads(report.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return ['未知']
    names = []
    for page in data.get('pages') or []:
        if page.get('blocking') or page.get('errors'):
            name = str(page.get('file') or page.get('name') or '').split('/')[-1]
            if name:
                names.append(name)
    return names or ['未知']


def _report_warnings(project: Path) -> list:
    report = project / 'validation' / 'svg_quality_report.json'
    try:
        data = json.loads(report.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    out = []
    for page in data.get('pages') or []:
        for issue in page.get('warnings') or []:
            text = issue.get('message') if isinstance(issue, dict) else str(issue)
            if text:
                out.append(text[:160])
    return out[:10]


def _postflight_warnings(stdout: str) -> list:
    return [line.strip()[:160] for line in stdout.splitlines()
            if 'POSTFLIGHT' in line and 'WARNING' in line and 'quality_introduced' not in line]
