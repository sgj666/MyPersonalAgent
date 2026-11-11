"""Starting questions for the page AI drawer, fitted to what the page holds.

Each teaching page opens the same assistant, but the three prompts a teacher
can tap should name that page's real numbers: the classes that exist, this
week's periods, the unit a class is on, the homework still missing, the latest
exam's average. This module reads those documents, asks the configured chat
model for exactly three short questions, and caches the day's answer per page
in ``teaching/suggestions.json``.

Two rules shape the failure path. The drawer opens while the page is drawn, so
the model call runs on a daemon thread with a hard timeout; a provider that
hangs must not hold the drawer. And every page owns a deterministic three-line
fallback built from the same summary, so a missing key, a timeout or an
unusable answer still gives the teacher something concrete to tap.
"""

from __future__ import annotations

import json
import os
import threading
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from common.atomic_write import write_json_atomic
from common.log import logger

#: Pages the drawer knows; anything else is a client mistake.
PAGES = ("classes", "timetable", "progress", "homework", "scores")

#: The prompt contract: three prompts, each short enough for one pill.
MAX_ITEMS = 3
MAX_ITEM_CHARS = 18

#: The whole model call, including the bridge's own retries.
MODEL_TIMEOUT = 6.0
TEMPERATURE = 0.6
MAX_TOKENS = 120

CACHE_FILE = "suggestions.json"

PAGE_LABELS = {
    "classes": "班级名单",
    "timetable": "课表",
    "progress": "教学进度",
    "homework": "作业",
    "scores": "成绩",
}

#: Last-resort pills if a data-aware fallback collapses to fewer than three.
SPARE_ITEMS = ("查看本页数据并给建议", "安排下一步教学动作", "复盘本周教学情况")

WEEKDAY_LABELS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")

_locks_guard = threading.Lock()
_locks: Dict[str, threading.RLock] = {}


def _lock_for(path: Path) -> threading.RLock:
    key = os.path.normcase(os.path.realpath(str(path)))
    with _locks_guard:
        return _locks.setdefault(key, threading.RLock())


def _fit(text, limit: int = MAX_ITEM_CHARS) -> str:
    """One pill: whitespace collapsed, punctuation trimmed, at most ``limit``."""
    value = " ".join(str(text or "").split()).strip()
    value = value.strip('"\'“”‘’「」『』 \t')
    if len(value) > limit:
        value = value[:limit].rstrip("，、；：,;: 《》（）()")
    return value


def _finalize(items) -> List[str]:
    """The usable prompts among ``items``, de-duplicated and capped at three."""
    cleaned: List[str] = []
    if not isinstance(items, (list, tuple)):
        return cleaned
    for item in items:
        if not isinstance(item, str):
            continue
        text = _fit(item)
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned[:MAX_ITEMS]


def _num(value) -> str:
    """``75.0`` -> ``75``; ``75.25`` stays two decimals."""
    if value is None:
        return "-"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "-"
    return f"{number:g}"


# --- Page summaries --------------------------------------------------------


def _class_map(classes: List[dict]) -> Dict[str, dict]:
    return {entry["id"]: entry for entry in classes}


def _classes_summary(store) -> Tuple[str, Tuple[str, str, str]]:
    classes = store.list_classes()
    students = store.list_students()
    counts = {entry["id"]: 0 for entry in classes}
    for student in students:
        counts[student["class_id"]] = counts.get(student["class_id"], 0) + 1
    latest = max(classes, key=lambda entry: entry.get("created_at") or "",
                 default=None)

    if not classes:
        return (
            "还没有班级，学生名单也是空的。",
            ("新建第一个班级并导入名单", "补全班级的年级与学科", "贴入花名册一次建班"),
        )

    latest_name = latest["name"] if latest else classes[0]["name"]
    summary = f"共 {len(classes)} 个班、{len(students)} 名学生；最近新增的是 {latest_name}"
    if latest:
        detail = "、".join(part for part in (latest.get("grade"), latest.get("subject"))
                          if part)
        if detail:
            summary += f"（{detail}）"
        summary += f"，该班 {counts.get(latest['id'], 0)} 人"
    summary += "。"
    return (
        summary,
        (
            f"给{latest_name}补全学生名单",
            f"核对{len(classes)}个班的{len(students)}人",
            f"看看{latest_name}还缺什么",
        ),
    )


def _clock(period: dict, key: str) -> str:
    return str(period.get(key) or "").strip()


def _timetable_summary(store) -> Tuple[str, Tuple[str, str, str]]:
    table = store.get_timetable()
    slots = table.get("slots") or []
    periods = {entry["index"]: entry for entry in table.get("periods") or []}
    classes = _class_map(store.list_classes())
    mine = sum(1 for slot in slots if slot.get("mine"))

    if not slots:
        return (
            "课表还没有排任何一节课。",
            ("先排出本周第一节课", "给每周固定教研留位置", "检查每班课时是否均衡"),
        )

    timed = [
        (slot, periods.get(slot["period"], {}))
        for slot in slots
        if _clock(periods.get(slot["period"], {}), "start")
    ]
    earliest = min(timed, key=lambda pair: _clock(pair[1], "start"), default=None)
    latest = max(
        timed,
        key=lambda pair: (_clock(pair[1], "end") or _clock(pair[1], "start")),
        default=None,
    )
    parts = [f"共 {len(slots)} 节课", f"我的课 {mine} 节"]

    def label(pair) -> str:
        slot, period = pair
        klass = classes.get(slot["class_id"], {})
        name = klass.get("name") or ""
        subject = slot.get("subject") or klass.get("subject") or ""
        text = f"{WEEKDAY_LABELS[slot['weekday'] - 1]}{_clock(period, 'start')}"
        if name:
            text += f" {name}"
        if subject:
            text += f" {subject}"
        return text

    if earliest is not None:
        parts.append(f"最早 {label(earliest)}")
    if latest is not None:
        parts.append(f"最晚 {label(latest)}")
    summary = "；".join(parts) + "。"

    latest_start = _clock(latest[1], "start") if latest else ""
    latest_day = WEEKDAY_LABELS[latest[0]["weekday"] - 1] if latest else ""
    return (
        summary,
        (
            f"检查我的{mine}节课是否冲突",
            f"{latest_day}{latest_start}的课提前备好" if latest else "给课表补上作息时间",
            f"核对{len(slots)}节课的班级分布",
        ),
    )


def _progress_summary(store) -> Tuple[str, Tuple[str, str, str]]:
    items = store.list_progress()
    classes = store.list_classes()
    names = {entry["id"]: entry["name"] for entry in classes}

    if not items:
        return (
            "还没有录入任何教学进度。",
            ("先录入第一个单元进度", "把本周要讲的单元排进去", "设置每单元的计划课时"),
        )

    grouped: Dict[str, List[dict]] = {}
    for item in items:
        grouped.setdefault(item["class_id"], []).append(item)

    current_by_class: Dict[str, dict] = {}
    remaining_by_class: Dict[str, int] = {}
    for class_id, rows in grouped.items():
        rows.sort(key=lambda item: (item["order"], item.get("updated_at") or ""))
        current = next(
            (row for row in rows
             if row["taught_periods"] < max(row["planned_periods"], 1)),
            None,
        )
        if current is not None:
            current_by_class[class_id] = current
        remaining_by_class[class_id] = sum(
            max(row["planned_periods"] - row["taught_periods"], 0) for row in rows
        )

    current = next((current_by_class[entry["id"]] for entry in classes
                    if entry["id"] in current_by_class), None)
    if current is None and current_by_class:
        current = next(iter(current_by_class.values()))
    behind_id = max(remaining_by_class, key=remaining_by_class.get, default="")
    behind_name = names.get(behind_id, behind_id)
    remaining = remaining_by_class.get(behind_id, 0)

    if current is None:
        return (
            f"共 {len(items)} 条进度，所有单元的课时都已讲完。",
            ("所有单元已讲完，安排复习", "挑最薄弱单元重新巩固", "核对下一阶段的单元计划"),
        )

    summary = (
        f"共 {len(items)} 条进度；当前单元「{current['topic']}」；"
        f"落后最多的是 {behind_name}，还差 {remaining} 课时。"
    )
    return (
        summary,
        (
            f"给{behind_name}补{remaining}课时",
            f"下一课讲「{current['topic']}」",
            f"核对{len(items)}条进度是否更新",
        ),
    )


def _homework_summary(store) -> Tuple[str, Tuple[str, str, str]]:
    items = store.list_homework()
    if not items:
        return (
            "还没有布置过作业。",
            ("布置本周第一次作业", "设好作业截止日期", "导入名单后记录交作业"),
        )

    latest = items[-1]
    students = store.list_students()
    targets = [student for student in students
               if student["class_id"] in latest["class_ids"]]
    book = store.all_homework_records().get(latest["id"], {})
    missing = sum(
        1 for student in targets
        if book.get(student["id"]) not in ("submitted", "excellent")
    )
    title = latest["title"]
    summary = (
        f"最近作业「{title}」，{latest['due']} 截止，"
        f"涉及 {len(targets)} 人，未交 {missing} 人。"
    )

    if missing:
        first = f"提醒{missing}人交《{title}》"
    else:
        first = f"《{title}》已交齐，做讲评"
    return (
        summary,
        (
            first,
            f"讲评《{title}》的典型错误",
            f"核对{len(targets)}人的订正情况",
        ),
    )


def _scores_summary(store) -> Tuple[str, Tuple[str, str, str]]:
    exams = store.list_exams()
    if not exams:
        return (
            "还没有录入过考试。",
            ("录入最近一次考试成绩", "先建考试并拆分题组", "补全成绩后看班级均分"),
        )

    latest = exams[0]
    summary_stats = store.analysis(latest["id"])["summary"]
    scored = summary_stats.get("scored") or 0
    name = latest["name"]
    if not scored:
        return (
            f"最近考试「{name}」还没有任何成绩。",
            ("录入最近一次考试成绩", "先按题组拆分失分", "补全成绩后看班级均分"),
        )

    average = _num(summary_stats.get("average"))
    pass_rate = _num(summary_stats.get("pass_rate"))
    high = _num(summary_stats.get("max"))
    low = _num(summary_stats.get("min"))
    summary = (
        f"最近考试「{name}」（{latest['date']}）均分 {average}，"
        f"及格率 {pass_rate}%，最高 {high}，最低 {low}。"
    )
    return (
        summary,
        (
            f"分析{name}的低分题",
            f"盯{pass_rate}%及格线的临界生",
            f"给均分{average}的学生加练",
        ),
    )


_SUMMARIES = {
    "classes": _classes_summary,
    "timetable": _timetable_summary,
    "progress": _progress_summary,
    "homework": _homework_summary,
    "scores": _scores_summary,
}


# --- Model -----------------------------------------------------------------


def _prompt(page: str, summary: str) -> str:
    return (
        "你是教学助手的提问推荐器。根据下面这一页的真实数据，"
        "给老师写 3 条可以直接点开的提问。\n"
        f"页面：{PAGE_LABELS.get(page, page)}\n"
        f"数据：{summary}\n"
        "要求：\n"
        "1. 只输出一个 JSON 数组，例如 [\"...\",\"...\",\"...\"]；"
        "不要代码块、不要解释。\n"
        f"2. 正好 {MAX_ITEMS} 条，每条不超过 {MAX_ITEM_CHARS} 个汉字，"
        "动词开头，中文，必须引用上面的班级、单元、人数或分数。\n"
        "3. 三条不重复，分别覆盖分析现状、安排下一步、复盘改进。"
    )


def _call_with_timeout(fn, seconds: float):
    """Run ``fn`` on a daemon thread and give up after ``seconds``."""
    outcome: dict = {}

    def target():
        try:
            outcome["value"] = fn()
        except BaseException as e:  # a provider failure must not escape
            outcome["error"] = e

    thread = threading.Thread(target=target, name="teaching-suggestions",
                              daemon=True)
    thread.start()
    thread.join(seconds)
    if thread.is_alive():
        logger.warning("[Teaching] suggestion model timed out")
        return None
    if "error" in outcome:
        logger.warning(f"[Teaching] suggestion model failed: {outcome['error']}")
        return None
    return outcome.get("value")


def suggest_from_model(page: str, summary: str) -> str:
    """The model's raw answer; empty string on any failure.

    Module-level and small so a test, or a deployment without a provider, can
    replace it without touching the cache and fallback plumbing. Sampling
    parameters are merged over the bot's own args; bots whose ``reply_text``
    takes no ``args`` keep their configured defaults.
    """
    def ask() -> str:
        import inspect

        from bridge.bridge import Bridge
        from models.session_manager import Session

        session = Session("__teaching_suggestions__", system_prompt="")
        session.messages = [{"role": "user", "content": _prompt(page, summary)}]
        bot = Bridge().get_bot("chat")
        kwargs = {}
        try:
            parameters = inspect.signature(bot.reply_text).parameters
        except (TypeError, ValueError):
            parameters = {}
        if "args" in parameters:
            args = dict(getattr(bot, "args", {}) or {})
            args.update({"temperature": TEMPERATURE, "max_tokens": MAX_TOKENS})
            kwargs["args"] = args
        result = bot.reply_text(session, **kwargs) or {}
        if (result.get("completion_tokens", 0) or 0) <= 0:
            return ""
        return str(result.get("content") or "")

    raw = _call_with_timeout(ask, MODEL_TIMEOUT)
    return raw or ""


def _parse(raw: str) -> List[str]:
    """The JSON array in ``raw``, already fitted to pills; empty when unusable."""
    text = str(raw or "").strip()
    if not text:
        return []
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        return []
    try:
        payload = json.loads(text[start:end + 1])
    except ValueError:
        return []
    if not isinstance(payload, list):
        return []
    return _finalize(payload)


# --- Cache -----------------------------------------------------------------


def _cache_path(store) -> Path:
    return Path(store.base) / CACHE_FILE


def _read_cache(path: Path) -> dict:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except OSError as e:
        logger.warning(f"[Teaching] cannot read {path}: {e}")
        return {}
    try:
        doc = json.loads(raw)
    except ValueError:
        return {}
    return doc if isinstance(doc, dict) else {}


def _cached(path: Path, day: str, page: str) -> Optional[List[str]]:
    doc = _read_cache(path)
    if doc.get("date") != day:
        return None
    items = _finalize(doc.get(page))
    return items if len(items) == MAX_ITEMS else None


def _store_cache(path: Path, day: str, page: str, items: List[str]) -> None:
    with _lock_for(path):
        doc = _read_cache(path)
        # A new day replaces the document: yesterday's prompts would name
        # lessons and homework the teacher has already finished.
        pages = {} if doc.get("date") != day else {
            key: value for key, value in doc.items()
            if key not in ("version", "date") and isinstance(value, list)
        }
        pages[page] = list(items)
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(path, {"version": 1, "date": day, **pages}, indent=2)


# --- Entry point -----------------------------------------------------------


def suggest(store, page: str, agent_id: Optional[str] = None) -> dict:
    """Three starting questions for ``page``, from today's cache or the model.

    ``agent_id`` is accepted for the endpoint's addressing contract; the store
    is already scoped to the caller's workspace, so the data read here is the
    right teacher's. An unknown page raises ``ValueError`` for the API's
    ``bad_request`` shape.
    """
    key = str(page or "").strip()
    if key not in PAGES:
        raise ValueError(f"invalid page: {page!r}")

    day = date.today().isoformat()
    path = _cache_path(store)
    cached = _cached(path, day, key)
    if cached is not None:
        return {"page": key, "items": cached, "cached": True}

    summary, fallback = _SUMMARIES[key](store)
    items = _parse(suggest_from_model(key, summary))
    if len(items) != MAX_ITEMS:
        items = _finalize(fallback)
        for spare in SPARE_ITEMS:
            if len(items) >= MAX_ITEMS:
                break
            text = _fit(spare)
            if text and text not in items:
                items.append(text)
    _store_cache(path, day, key, items)
    return {"page": key, "items": items, "cached": False}


__all__ = ["PAGES", "suggest", "suggest_from_model"]
