"""Teacher profile mirrors and the home page's daily greeting.

The profile itself lives in ``teaching/profile.json`` (see ``TeachingStore``).
This module owns the two things that turn it into something the Agent and the
console can use:

* ``USER.md`` -- the operator file at the workspace root is what the model reads
  at the start of every turn. The profile is written into one marked block, so
  a hand-written file keeps its own sections and a second save replaces the
  block instead of appending another copy.
* the greeting -- ``早上好，孙老师。`` plus one gentle line about the day. The
  motto is cached per calendar day in ``teaching/daily_motto.json``; a model
  failure degrades to a fixed sentence for the date rather than to an error,
  because the home page must always open.

The model call runs on a worker thread with a hard timeout: the console asks
for the greeting while the page is being drawn, and a provider that hangs must
not hold the page.
"""

from __future__ import annotations

import threading
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

from common.log import logger

#: The marks that delimit the generated block in USER.md.
MARKER_START = "<!-- teacher-profile:start -->"
MARKER_END = "<!-- teacher-profile:end -->"

#: How long a greeting may wait for the model before the fixed pool answers.
MODEL_TIMEOUT = 6.0

#: Sentences used when no model is configured, when it fails, or when its
#: answer is unusable. Each one is 18-30 characters, like the generated ones.
_FALLBACK_MOTTOS = (
    "把今天的一节课上好，剩下的交给时间。",
    "慢一点也没关系，课讲到学生眼里就值了。",
    "先备好第一节课，今天的节奏自然就顺了。",
    "留一点空档喝口水，讲台也需要喘口气。",
    "今天讲清楚一个知识点，就已经是好课了。",
    "学生的一个点头，够撑起一整天的疲惫。",
    "课间别急着改作业，先站起来走两步再回来。",
    "把难题拆小一点，学生跟得上的地方才开始。",
    "今天不追求完美，只把该讲的讲明白就好。",
    "下课前留两分钟，收个尾，也收个心情。",
)


def user_md_path(store) -> Path:
    """``USER.md`` beside the store's ``teaching/`` directory.

    The store's base is ``<workspace>/teaching``, so the parent is exactly the
    workspace root the Agent loads its context files from. Tests point the
    store at a temp directory and get that directory's ``USER.md``.
    """
    return store.base.parent / "USER.md"


def profile_block(profile: dict) -> str:
    """The marked Markdown block; empty fields simply get no line."""
    lines = [MARKER_START, "## 老师信息"]
    name = (profile.get("name") or "").strip()
    if name:
        lines.append(f"- 姓名：{name}")
    subjects = [item for item in profile.get("subjects") or [] if item]
    if subjects:
        lines.append(f"- 学科：{'、'.join(subjects)}")
    classes = [item for item in profile.get("classes") or [] if item]
    if classes:
        lines.append(f"- 班级：{'、'.join(classes)}")
    textbook = (profile.get("textbook") or "").strip()
    if textbook:
        lines.append(f"- 教材：{textbook}")
    school = (profile.get("school") or "").strip()
    if school:
        lines.append(f"- 学校：{school}")
    lines.append(MARKER_END)
    return "\n".join(lines)


def _joined(existing: str, block: str) -> str:
    """Append ``block`` after a blank line, keeping every existing byte."""
    if not existing:
        return block + "\n"
    if existing.endswith("\n\n") or existing.endswith("\r\n\r\n"):
        return existing + block + "\n"
    if existing.endswith("\n") or existing.endswith("\r\n"):
        return existing + "\n" + block + "\n"
    return existing + "\n\n" + block + "\n"


def render_user_md(existing: str, profile: dict) -> str:
    """Replace the marked block in ``existing``, or append one.

    Everything outside the two marks is preserved exactly. A file with only one
    mark is treated as unmarked: appending is safer than guessing which half of
    the file the teacher meant to replace.
    """
    block = profile_block(profile)
    start = existing.find(MARKER_START)
    end = existing.find(MARKER_END, start + len(MARKER_START)) if start >= 0 else -1
    if start >= 0 and end >= 0:
        end += len(MARKER_END)
        return existing[:start] + block + existing[end:]
    return _joined(existing, block)


def sync_user_md(store, profile: Optional[dict] = None) -> dict:
    """Write the profile into the workspace's USER.md.

    A read-only workspace is not an error the console should surface as "save
    failed": the profile is already stored, so the answer says ``synced`` false
    and carries the path that could not be written.
    """
    profile = profile if profile is not None else store.get_profile()
    path = user_md_path(store)
    try:
        try:
            existing = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            existing = ""
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(render_user_md(existing, profile), encoding="utf-8")
        return {"synced": True, "path": str(path)}
    except OSError as e:
        logger.warning(f"[Teaching] cannot sync teacher profile to {path}: {e}")
        return {"synced": False, "path": str(path)}


def _period_greeting(hour: int) -> str:
    if hour < 12:
        return "早上好"
    if hour < 18:
        return "下午好"
    return "晚上好"


def _address(name: str) -> str:
    """``孙`` -> ``孙老师``; ``孙老师`` stays as written; empty -> ``老师``."""
    name = (name or "").strip()
    if not name:
        return "老师"
    if "老师" in name:
        return name
    return f"{name}老师"


def _fallback_motto(day: date) -> str:
    return _FALLBACK_MOTTOS[day.toordinal() % len(_FALLBACK_MOTTOS)]


def _motto_prompt(profile: dict, day: date, lessons: List[dict]) -> str:
    who = []
    if profile.get("name"):
        who.append(f"姓名：{profile['name']}")
    if profile.get("subjects"):
        who.append(f"学科：{'、'.join(profile['subjects'])}")
    if profile.get("classes"):
        who.append(f"班级：{'、'.join(profile['classes'])}")
    if profile.get("textbook"):
        who.append(f"教材：{profile['textbook']}")
    if profile.get("school"):
        who.append(f"学校：{profile['school']}")

    if lessons:
        first = lessons[0]
        today = (f"今天有 {len(lessons)} 节课；第一节课是 "
                 f"{first.get('start') or '待定时间'} {first.get('class_name') or ''}"
                 f" {first.get('subject') or ''}".strip())
    else:
        today = "今天没有课。"

    return (
        "你是贴在教师办公桌上的一张便签。给这位老师写一句今天的教学工作寄语。\n"
        + "\n".join(who)
        + f"\n{today}\n"
        + "要求：18-30 个汉字；语气温和轻松，具体一点，不说教、不喊口号、"
        "不写鸡汤；最多一个 emoji；只输出这一句话，不要引号、不要解释。"
    )


def _clean_motto(raw: str) -> str:
    """One usable line, 18-30 characters, or empty when the answer is unusable."""
    text = " ".join(str(raw or "").split()).strip()
    text = text.strip('"\'“”‘’「」『』 \t')
    if len(text) > 30:
        text = text[:30].rstrip("，、；：,;: ")
    if len(text) < 18:
        return ""
    return text


def _call_with_timeout(fn, seconds: float):
    """Run ``fn`` on a daemon thread and give up after ``seconds``."""
    outcome: dict = {}

    def target():
        try:
            outcome["value"] = fn()
        except BaseException as e:  # a provider failure must not escape
            outcome["error"] = e

    thread = threading.Thread(target=target, name="teaching-motto", daemon=True)
    thread.start()
    thread.join(seconds)
    if thread.is_alive():
        logger.warning("[Teaching] daily motto model timed out")
        return None
    if "error" in outcome:
        logger.warning(f"[Teaching] daily motto model failed: {outcome['error']}")
        return None
    return outcome.get("value")


def motto_from_model(profile: dict, day: date, lessons: List[dict]) -> str:
    """Ask the configured chat model for one line; empty string on any failure.

    Kept module-level and small so a test (or a deployment with no model) can
    replace it without touching the greeting plumbing.
    """
    def ask() -> str:
        from bridge.bridge import Bridge
        from models.session_manager import Session

        session = Session("__teaching_motto__", system_prompt="")
        session.messages = [{
            "role": "user",
            "content": _motto_prompt(profile, day, lessons),
        }]
        result = Bridge().get_bot("chat").reply_text(session) or {}
        if (result.get("completion_tokens", 0) or 0) <= 0:
            return ""
        return str(result.get("content") or "")

    raw = _call_with_timeout(ask, MODEL_TIMEOUT)
    return _clean_motto(raw or "")


def greeting(store, *, day: Optional[str] = None, now: Optional[datetime] = None,
             refresh: bool = False) -> dict:
    """The hero's greeting and one-line motto for a calendar day.

    ``cached`` says whether the motto came from the day's stored line. A
    ``refresh`` skips that cache but still writes the new answer, so pressing
    "换一句" once is enough to change the line again next load.
    """
    when = now or datetime.now()
    target = date.fromisoformat(day) if day else when.date()
    day_iso = target.isoformat()
    profile = store.get_profile()

    cached = store.get_daily_motto()
    text = ""
    from_cache = False
    if not refresh and cached["date"] == day_iso and cached["text"]:
        text = cached["text"]
        from_cache = True
    else:
        lessons = store.today(day_iso).get("slots", [])
        text = motto_from_model(profile, target, lessons) or _fallback_motto(target)
        store.save_daily_motto(day_iso, text)

    return {
        "greeting": f"{_period_greeting(when.hour)}，{_address(profile['name'])}。",
        "motto": text,
        "date": day_iso,
        "cached": from_cache,
    }
