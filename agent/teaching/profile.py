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

import re
import threading
from datetime import date, datetime
from pathlib import Path
from typing import List, Optional

from common.log import logger

#: The marks that delimit the generated block in USER.md.
MARKER_START = "<!-- teacher-profile:start -->"
MARKER_END = "<!-- teacher-profile:end -->"

#: How long a greeting may wait for the model before the fixed pool answers.
MODEL_TIMEOUT = 4.0

#: Sentences used when no model is configured, when it fails, or when its
#: answer is unusable. Each one is 18-30 characters, like the generated ones.
_FALLBACK_MOTTOS = (
    "你今天多讲的耐心，会在某个学生身上悄悄发芽。",
    "散步十分钟，大脑整理记忆的效率比再刷一遍题更高。",
    "睡前复习一次，第二天的留存率大约能翻一倍。",
    "英语里 nice 原本是“无知”的意思，几百年才变成“好”。",
    "把目标写下来，完成率通常会明显提高。",
    "课间看向远处二十秒，眼睛的调节肌肉会松一口气。",
    "章鱼有三颗心脏，其中两颗专门给鳃供血。",
    "先做最难的那件事，一天的阻力会小很多。",
    "雨的气味大多来自土壤里的放线菌，不是雨本身。",
    "学生记住的常是你的一个眼神，而不是那句板书。",
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


def _fallback_motives(day: date) -> List[str]:
    start = day.toordinal() % len(_FALLBACK_MOTTOS)
    return [_FALLBACK_MOTTOS[(start + i) % len(_FALLBACK_MOTTOS)] for i in range(3)]


def _split_motives(raw: str) -> List[str]:
    """Up to three lines, with list numbering and stray quotes removed."""
    lines = []
    for line in (raw or "").splitlines():
        text = re.sub(r"^\s*(?:\d+[.、)]|[-*•])\s*", "", line).strip().strip('"“”')
        # A model that numbers inline leaves a trailing "2" behind.
        text = re.sub(r"\s+\d{1,2}[.、)]?\s*$", "", text).strip()
        if len(text) >= 8:
            lines.append(text)
    return lines[:3]


def _motto_prompt(profile: dict, day: date, lessons: List[dict]) -> str:
    """Three short lines for the hero: a lift, a fact, a small wonder.

    The hero is not a task panel — the digest already reports the day. These
    lines are meant to be read while the kettle boils, so they carry no work
    items at all.
    """
    return (
        "给一位老师写今天首页上的三条短句，放进轮播里。\n"
        "三条各写一种：一条温和的鼓励；一条教育/脑科学/学习方法的小知识；"
        "一条自然、历史或语言的小趣闻。\n"
        "每条 18-32 个汉字，具体、有信息量，不喊口号、不写鸡汤、不提今天的工作和课程；"
        "每条最多一个 emoji；用 1. 2. 3. 编号，每行一条，不要引号，不要解释。"
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
        bot = Bridge().get_bot("chat")
        # This is a one-line flourish, not a reasoning task: thinking mode adds
        # seconds of latency and burns the token budget before the answer starts.
        args = dict(getattr(bot, "args", {}) or {})
        supports = getattr(bot, "_model_supports_thinking", None)
        try:
            if callable(supports) and supports(str(args.get("model", ""))):
                args["thinking"] = {"type": "disabled"}
                args.pop("reasoning_effort", None)
        except Exception:
            pass
        try:
            result = bot.reply_text(session, args=args) or {}
        except TypeError:
            # Providers whose reply_text has no args parameter.
            result = bot.reply_text(session) or {}
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
        lines = _split_motives(motto_from_model(profile, target, lessons))
        # The model sometimes answers one line despite the list; top up from
        # the local pool so the hero always has three to rotate.
        for candidate in _fallback_motives(target):
            if len(lines) >= 3:
                break
            if candidate not in lines:
                lines.append(candidate)
        if not lines:
            lines = _fallback_motives(target)
        store.save_daily_motto(day_iso, lines[0], motives=lines)
        text = lines[0]

    motives = cached.get("motives") or []
    if not motives:
        motives = [text]
    return {
        "greeting": f"{_period_greeting(when.hour)}，{_address(profile['name'])}。",
        "motto": text,
        "motives": motives,
        "date": day_iso,
        "cached": from_cache,
    }
