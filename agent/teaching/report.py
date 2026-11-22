"""Per-exam AI analysis report (成绩分析).

The numbers are always computed locally by ``TeachingStore.analysis`` -- the
model only writes the prose around them, and is told to use no figure that is
not in the digest. A report is stored next to its exam
(``teaching/reports/<exam_id>.json``), so it stays bound to that exam and can be
regenerated on demand.

Generation is synchronous from the caller's point of view but runs on a worker
thread with a timeout: ``web.py`` gives every request its own thread, and the
console shows a skeleton until the answer lands.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from common.atomic_write import write_json_atomic
from common.log import logger

#: A report is a long answer (sections + numbers); deepseek-style models need
#: 20-40s for it, so the ceiling is generous but still bounded.
MODEL_TIMEOUT = 120.0

#: Keep the prompt small: the model does not need 47 rows, only the shape.
MAX_TOP_ROWS = 8
MAX_CRITICAL_ROWS = 8

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _safe(exam_id: str) -> str:
    value = str(exam_id or "").strip()
    if not _SAFE_ID.match(value):
        raise ValueError("invalid exam id")
    return value


def _path(store, exam_id: str) -> Path:
    return Path(store.base) / "reports" / f"{_safe(exam_id)}.json"


def load(store, exam_id: str) -> Optional[dict]:
    """The stored report for this exam, or None when none was generated yet."""
    path = _path(store, exam_id)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as e:
        logger.warning(f"[Teaching] cannot read report {path}: {e}")
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        logger.warning(f"[Teaching] report {path} is not valid JSON")
        return None
    if not isinstance(doc, dict) or not doc.get("markdown"):
        return None
    return doc


def _save(store, exam_id: str, payload: dict) -> None:
    path = _path(store, exam_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, payload, indent=2)


def _num(value, digits: int = 2) -> str:
    """Exact as stored: the model may quote these figures, so do not round them
    away (416.93 must not reach the prompt as 416.9)."""
    if value is None:
        return "—"
    return f"{float(value):.{digits}f}".rstrip("0").rstrip(".")


def _digest(analysis: dict) -> dict:
    """Facts the prompt is allowed to use, plus the numbers the card shows."""
    summary = analysis.get("summary") or {}
    students = analysis.get("students") or []
    scored = [row for row in students if row.get("total") is not None]
    ranked = sorted(scored, key=lambda row: row.get("total"), reverse=True)
    critical = analysis.get("critical") or []
    items = analysis.get("items") or []
    by_class = analysis.get("by_class") or []

    # 历次考试均分（只在有历史时出现）
    trend_points: List[dict] = []
    trend_names = {}
    for row in students:
        for entry in row.get("exams") or []:
            key = entry.get("exam_id") or entry.get("date") or ""
            trend_names[key] = entry.get("name") or entry.get("date") or key
    if len(trend_names) > 1:
        ordered = list(trend_names.items())[-4:]
        for key, name in ordered:
            totals = []
            for row in students:
                for entry in row.get("exams") or []:
                    if (entry.get("exam_id") or entry.get("date") or "") == key:
                        if entry.get("total") is not None:
                            totals.append(entry["total"])
            if totals:
                trend_points.append({
                    "name": name,
                    "average": round(sum(totals) / len(totals), 2),
                    "scored": len(totals),
                })

    return {
        "exam": {
            "name": summary.get("name") or "",
            "subject": summary.get("subject") or "",
            "date": summary.get("date") or "",
            "full_score": summary.get("full_score"),
            "pass_line": summary.get("pass_line"),
            "excellent_line": summary.get("excellent_line"),
            "low_line": summary.get("low_line"),
        },
        "overall": {
            "students": summary.get("students"),
            "scored": summary.get("scored"),
            "absent": summary.get("absent"),
            "average": summary.get("average"),
            "pass_rate": summary.get("pass_rate"),
            "excellent_rate": summary.get("excellent_rate"),
            "low_rate": summary.get("low_rate"),
            "stddev": summary.get("stddev"),
            "max": summary.get("max"),
            "min": summary.get("min"),
        },
        "by_class": [
            {
                "name": row.get("class_name") or "",
                "students": row.get("students"),
                "average": row.get("average"),
                "pass_rate": row.get("pass_rate"),
                "excellent_rate": row.get("excellent_rate"),
                "stddev": row.get("stddev"),
            }
            for row in by_class
        ],
        "items": [
            {
                "label": row.get("label"),
                "full": row.get("full"),
                "average": row.get("average"),
                "rate": row.get("rate"),
                "absent": row.get("absent"),
            }
            for row in items
        ],
        "top": [
            {
                "rank": index + 1,
                "name": row.get("name"),
                "class": row.get("class_name"),
                "total": row.get("total"),
            }
            for index, row in enumerate(ranked[:MAX_TOP_ROWS])
        ],
        # Only meaningful when it is not just the top rows again.
        "bottom": [
            {
                "name": row.get("name"),
                "class": row.get("class_name"),
                "total": row.get("total"),
            }
            for row in (ranked[-5:] if len(ranked) > MAX_TOP_ROWS else [])
        ],
        "critical": [
            {
                "name": row.get("name"),
                "total": row.get("total"),
                "gap": row.get("gap"),
                "kind": row.get("kind"),
            }
            for row in critical[:MAX_CRITICAL_ROWS]
        ],
        "trend": trend_points,
    }


def _facts_text(digest: dict) -> str:
    """Plain-text digest; every number the report may quote lives here."""
    exam = digest["exam"]
    overall = digest["overall"]
    lines = [
        f"考试：{exam['name']}（{exam['subject']}，{exam['date']}，满分 {_num(exam['full_score'])}）",
        f"及格线 {_num(exam['pass_line'])}，优秀线 {_num(exam['excellent_line'])}，低分线 {_num(exam['low_line'])}",
        f"参考人数 {overall['scored']}，缺考 {overall['absent']}，班级人数 {overall['students']}",
        f"平均分 {_num(overall['average'])}，最高 {_num(overall['max'])}，最低 {_num(overall['min'])}，标准差 {_num(overall['stddev'])}",
        f"及格率 {_num(overall['pass_rate'])}%，优秀率 {_num(overall['excellent_rate'])}%，低分率 {_num(overall['low_rate'])}%",
    ]
    if digest["by_class"]:
        lines.append("分班：")
        for row in digest["by_class"]:
            lines.append(
                f"  - {row['name']}：{row['students']} 人，均分 {_num(row['average'])}，"
                f"及格率 {_num(row['pass_rate'])}%，优秀率 {_num(row['excellent_rate'])}%"
            )
    if digest["items"]:
        lines.append("分项：")
        for row in digest["items"]:
            lines.append(
                f"  - {row['label']}（满分 {_num(row['full'])}）：均分 {_num(row['average'])}，"
                f"得分率 {_num(row['rate'])}%"
            )
    if digest["top"]:
        lines.append("前几名：" + "、".join(
            f"{row['name']} {_num(row['total'])}" for row in digest["top"]
        ))
    if digest["bottom"]:
        lines.append("后几名：" + "、".join(
            f"{row['name']} {_num(row['total'])}" for row in digest["bottom"]
        ))
    if digest["critical"]:
        lines.append("临界生：" + "、".join(
            f"{row['name']}（{_num(row['total'])}，距{'及格' if row['kind'] == 'pass' else '优秀'}线 {_num(row['gap'])} 分）"
            for row in digest["critical"]
        ))
    if digest["trend"]:
        lines.append("历次考试均分：" + "、".join(
            f"{row['name']} {_num(row['average'])}" for row in digest["trend"]
        ))
    return "\n".join(lines)


def _prompt(digest: dict) -> str:
    return "\n".join([
        "你是一位带过多年毕业班的学科教研员，正在给任课老师写这次考试的成绩分析报告。",
        "下面是程序算好的真实数据。你只能使用这些数字，不要编造学生、分数、班级或名次；",
        "某块数据没有出现，就跳过它，不要猜。",
        "",
        _facts_text(digest),
        "",
        "用中文写一份 Markdown 报告，严格按下面的结构（标题用 ##，不要写一级标题）：",
        "",
        "先写一段 60 字以内的总评（不带小标题，就是一段话，语气克制、具体）。",
        "",
        "## 成绩概览",
        "用 3-5 条要点说明整体水平（均分、及格率、优秀率、最高最低分、标准差说明了什么）。",
        "",
        "## 分项表现",
        "逐个分项点评得分率高低，指出最该补的那一两项，并说清依据。",
        "",
        "## 排名与亮点",
        "点名前几名好在哪里（用分数说话），有并列或分差接近的要点出来。",
        "",
        "## 需要关注的学生",
        "只针对“临界生”和分数较低的同学，写清楚每人差多少分、缺的是哪一块。",
        "",
        "## 下一步教学建议",
        "3-4 条可以直接在下一节课落地的做法，具体到讲什么、练什么、怎么检查，不要空话。",
        "",
        "要求：",
        "1. 数字必须与上面数据一致，写“约”的地方也要与数据吻合；",
        "2. 不要出现“作为 AI”“根据提供的数据”这类元话术；",
        "3. 不要用感叹号堆情绪，不要写套话；",
        "4. 全程不点名批评，不贴标签，只描述分数与知识点。",
    ])


def _call_model(prompt: str) -> str:
    """One chat completion on the configured primary model; '' on failure."""
    def ask() -> str:
        from bridge.bridge import Bridge
        from config import conf
        from models.session_manager import Session

        session = Session("__teaching_report__", system_prompt="")
        session.messages = [{"role": "user", "content": prompt}]
        bot = Bridge().get_bot("chat")
        args = dict(getattr(bot, "args", {}) or {})
        primary_model = conf().get("model")
        if primary_model:
            args["model"] = primary_model
        supports = getattr(bot, "_model_supports_thinking", None)
        try:
            if callable(supports) and supports(str(args.get("model", ""))):
                args["thinking"] = {"type": "disabled"}
                args.pop("reasoning_effort", None)
        except Exception:
            pass
        logger.info(f"[Teaching] analysis report model: {args.get('model') or '<bot default>'}")
        try:
            result = bot.reply_text(session, args=args) or {}
        except TypeError:
            result = bot.reply_text(session) or {}
        if (result.get("completion_tokens", 0) or 0) <= 0:
            return ""
        return str(result.get("content") or "")

    outcome: dict = {}

    def target() -> None:
        try:
            outcome["value"] = ask()
        except BaseException as e:  # a provider failure must not escape
            outcome["error"] = e

    thread = threading.Thread(target=target, name="teaching-report", daemon=True)
    thread.start()
    thread.join(MODEL_TIMEOUT)
    if thread.is_alive():
        logger.warning("[Teaching] analysis report model timed out")
        return ""
    if "error" in outcome:
        logger.warning(f"[Teaching] analysis report model failed: {outcome['error']}")
        return ""
    return str(outcome.get("value") or "").strip()


def _clean_markdown(raw: str) -> str:
    """Drop a stray ```markdown fence and any leading title the model adds."""
    text = str(raw or "").strip()
    text = re.sub(r"^```(?:markdown|md)?\s*\n", "", text)
    text = re.sub(r"\n```\s*$", "", text)
    lines = text.splitlines()
    while lines and (not lines[0].strip() or lines[0].lstrip().startswith("# ")):
        lines.pop(0)
    return "\n".join(lines).strip()


def generate(store, exam_id: str) -> dict:
    """(Re)generate the report for one exam and persist it.

    Raises ValueError when the exam is unknown; a model failure is returned as
    ``ok: False`` with the facts kept, so the page can show the numbers and let
    the teacher retry.
    """
    # Validate before touching the store: the id becomes a file name.
    _safe(exam_id)
    analysis = store.analysis(exam_id)
    digest = _digest(analysis)
    markdown = _clean_markdown(_call_model(_prompt(digest)))
    payload = {
        "exam_id": _safe(exam_id),
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "ok": bool(markdown),
        "markdown": markdown,
        "facts": digest,
    }
    if markdown:
        _save(store, exam_id, payload)
    return payload
