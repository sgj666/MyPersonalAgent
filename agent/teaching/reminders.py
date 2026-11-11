"""Teaching reminders: digest/lesson text and the scheduler sync.

The text builders are pure functions over plain dicts, so the console can show
exactly what the scheduler will send and a test can pin the wording without a
scheduler. :func:`sync` is the only writer: it owns the ``[teaching]`` task
namespace, deleting every task with that prefix for the current Agent before
creating today's set, which is what makes a second run a no-op in effect.

Delivery reuses the one global scheduler store/service. A scheduled message
needs an explicit receiver, so the choice is:

* the receiver passed in by the caller (the console's session id) wins;
* a non-web ``channel`` setting resolves the first trusted recipient of that
  channel type from the shared recipient directory;
* otherwise delivery is the Web console, addressed to the most recently active
  web conversation for this Agent, or the stable ``teaching-reminders`` id when
  no conversation exists yet. Either id keeps the scheduler task executable
  in-process; a real session id additionally lands in that conversation's
  transcript and poll queue.

Automatic sync after a timetable/settings change only runs while the global
scheduler service is running; an explicit ``/reminders/sync`` always writes, so
a task set can be prepared before the service starts.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import List, Optional

from common.log import logger

#: Every task this module owns starts with this, so sync can find its own work.
PREFIX = "[teaching]"

#: Stable web receiver used when no conversation id is available.
DEFAULT_RECEIVER = "teaching-reminders"

WEEKDAY_LABELS = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")


def weekday_label(weekday: int) -> str:
    """``1`` (Monday) through ``7`` (Sunday) as the Chinese label."""
    if 1 <= weekday <= 7:
        return WEEKDAY_LABELS[weekday - 1]
    return ""


def build_digest(name: str, weekday: int, lessons: List[dict],
                 tasks: List[dict], missing_names: List[str]) -> str:
    """The morning digest, exactly as the console renders it.

    Empty sections are omitted. With no lessons the first line becomes
    ``今天没有课。`` and the due-work lines still follow, so a day off still
    reports what needs doing.

    The first task carries ``（今天截止）``: the template names the due date once
    rather than repeating it on every title in the list.
    """
    if lessons:
        lines = [f"早上好，{name}。今天{weekday_label(weekday)}，{len(lessons)} 节课："]
        for lesson in lessons:
            text = (f"· {lesson['start']}–{lesson['end']} "
                    f"{lesson['class_name']} {lesson['subject']}")
            if lesson.get("topic"):
                text += f"（{lesson['topic']}）"
            lines.append(text)
    else:
        lines = [f"早上好，{name}。今天没有课。"]

    if tasks:
        titles = [task["title"] for task in tasks]
        first = titles[0] + "（今天截止）"
        lines.append(f"今日待办 {len(tasks)} 项：" + "、".join([first, *titles[1:]]))

    if missing_names:
        lines.append(f"作业未交 {len(missing_names)} 人：" + "、".join(missing_names))

    return "\n".join(lines)


def build_lesson(minutes: int, period: int, start: str, class_name: str,
                 subject: str, topic: str = "", homework: str = "") -> str:
    """The reminder fired ``minutes`` before one lesson starts.

    The second line is omitted entirely when neither a topic nor homework is
    known; with only one of them, only that clause is written.
    """
    lines = [
        f"⏰ {minutes} 分钟后上课：第 {period} 节 {start} {class_name} · {subject}"
    ]
    detail = ""
    if topic:
        detail = f"今天讲「{topic}」"
    if homework:
        detail += ("；" if detail else "") + f"作业：{homework}"
    if detail:
        lines.append(detail)
    return "\n".join(lines)


def digest_for_today(agent_id: Optional[str] = None) -> str:
    """Today's digest computed at delivery time, so no model is involved.

    The morning task stores no text: the schedule is fixed but the day is not,
    and a digest frozen at sync time would name yesterday's lessons.
    """
    from agent.teaching.store import TeachingStore
    from common.runtime_identity import RuntimeIdentity
    from common.state_dir import state_root

    store = TeachingStore(str(state_root(RuntimeIdentity(agent_id=agent_id)) / "teaching"))
    return store.today(agent_id=agent_id)["digest_text"]


def teacher_name(agent_id: Optional[str] = None) -> str:
    """The greeting name: the Agent's configured display name, else 老师."""
    try:
        from agent.registry import get_agent_registry

        name = get_agent_registry().get_or_default(agent_id).name
        if isinstance(name, str) and name.strip():
            return name.strip()
    except Exception as e:
        logger.debug(f"[Teaching] teacher name unavailable: {e}")
    return "老师"


# --- Cron ------------------------------------------------------------------

def _minutes_of_day(value) -> Optional[int]:
    if not isinstance(value, str):
        return None
    match = value.strip().split(":")
    if len(match) != 2:
        return None
    try:
        hours, minutes = int(match[0]), int(match[1])
    except ValueError:
        return None
    if not 0 <= hours <= 23 or not 0 <= minutes <= 59:
        return None
    return hours * 60 + minutes


def digest_cron(time_text: str) -> Optional[str]:
    """``"07:30"`` as ``30 7 * * *``."""
    minutes = _minutes_of_day(time_text)
    if minutes is None:
        return None
    hours, minute = divmod(minutes, 60)
    return f"{minute} {hours} * * *"


def lesson_cron(weekday: int, start: str, minutes_before: int) -> Optional[str]:
    """The weekly reminder cron for one slot, ``minutes_before`` its start.

    A start close to midnight moves the reminder into the previous evening, so
    the cron's day-of-week shifts with it (Monday 00:05 with 10 minutes becomes
    Sunday 23:55). Cron day 0 is Sunday; stored weekdays are 1..7 from Monday.
    """
    minutes = _minutes_of_day(start)
    if minutes is None:
        return None
    shifted = minutes - max(int(minutes_before), 0)
    day_shift = 0
    while shifted < 0:
        shifted += 24 * 60
        day_shift -= 1
    hours, minute = divmod(shifted, 60)
    cron_weekday = (weekday + day_shift) % 7
    return f"{minute} {hours} * * {cron_weekday}"


# --- Scheduler sync --------------------------------------------------------


def _owner_agent_id(agent_id: Optional[str]) -> str:
    if agent_id:
        return agent_id
    try:
        from agent.registry import get_agent_registry

        return get_agent_registry().default_agent_id
    except Exception:
        return ""


def _default_task_store():
    from agent.tools.scheduler.integration import get_task_store

    return get_task_store()


def _web_receiver(store, agent_id: Optional[str]) -> str:
    """The most recently active web conversation for this Agent, else a stable id."""
    try:
        from agent.memory.conversation_store import get_conversation_store

        page = get_conversation_store(str(store.base.parent)).list_sessions(
            channel_type="web", page=1, page_size=1,
        )
        sessions = page.get("sessions") or []
        if sessions and sessions[0].get("session_id"):
            return sessions[0]["session_id"]
    except Exception as e:
        logger.debug(f"[Teaching] latest web session unavailable: {e}")
    return DEFAULT_RECEIVER


def _target(settings: dict, store, agent_id: Optional[str],
            receiver: Optional[str]) -> dict:
    """Where a reminder is delivered, as the scheduler action's addressing."""
    channel = settings.get("channel") or "web"
    if receiver:
        return {
            "channel_type": channel if channel != "web" else "web",
            "instance_id": channel if channel != "web" else "web",
            "receiver": receiver,
            "receiver_name": "Web 控制台" if channel == "web" else receiver,
            "is_group": False,
            "notify_session_id": receiver,
        }
    if channel != "web":
        try:
            from agent.tools.scheduler.integration import get_recipient_store

            recipients = get_recipient_store().list()
            match = next(
                (entry for entry in recipients
                 if entry.get("channel_type") == channel),
                None,
            )
            if match:
                return {
                    "channel_type": match["channel_type"],
                    "instance_id": match.get("instance_id") or match["channel_type"],
                    "receiver": match["receiver"],
                    "receiver_name": match.get("name") or match["receiver"],
                    "is_group": bool(match.get("is_group")),
                    "notify_session_id": match.get("session_id") or match["receiver"],
                }
        except Exception as e:
            logger.debug(f"[Teaching] recipient lookup for {channel} failed: {e}")
    session_id = _web_receiver(store, agent_id)
    return {
        "channel_type": "web",
        "instance_id": "web",
        "receiver": session_id,
        "receiver_name": "Web 控制台",
        "is_group": False,
        "notify_session_id": session_id,
    }


def _next_run(expression: str, now: datetime) -> str:
    from agent.tools.scheduler.time_utils import (
        format_scheduled_time,
        next_cron_occurrence,
    )

    return format_scheduled_time(next_cron_occurrence(expression, now))


def _task(owner: str, name: str, schedule: str, action: dict, now: datetime,
          taken: set) -> dict:
    task_id = uuid.uuid4().hex[:8]
    while task_id in taken:
        task_id = uuid.uuid4().hex[:8]
    taken.add(task_id)
    stamp = now.isoformat()
    task = {
        "id": task_id,
        "name": name,
        "agent_id": owner,
        "enabled": True,
        "created_at": stamp,
        "updated_at": stamp,
        "schedule": {"type": "cron", "expression": schedule},
        "action": action,
    }
    task["next_run_at"] = _next_run(schedule, now)
    return task


def _action(target: dict, **fields) -> dict:
    return {
        "receiver": target["receiver"],
        "receiver_name": target["receiver_name"],
        "is_group": target["is_group"],
        "channel_type": target["channel_type"],
        "instance_id": target["instance_id"],
        "notify_session_id": target["notify_session_id"],
        **fields,
    }


def sync(store, *, agent_id: Optional[str] = None, task_store=None,
         receiver: Optional[str] = None, now: Optional[datetime] = None) -> dict:
    """Replace this Agent's ``[teaching]`` tasks with the current timetable.

    Deleting the namespace and rebuilding it means stale slots, disabled
    reminders and changed settings all converge on one pass. Running it twice
    against the same data leaves the same task count.
    """
    settings = store.get_settings()
    owner = _owner_agent_id(agent_id)
    tasks = task_store if task_store is not None else _default_task_store()
    moment = now or datetime.now()
    default_owner = _owner_agent_id(None)

    existing = tasks.load_tasks()
    for task_id, task in existing.items():
        if not isinstance(task, dict):
            continue
        if not str(task.get("name") or "").startswith(PREFIX):
            continue
        stored = str(task.get("agent_id") or "").strip() or default_owner
        if stored != owner:
            continue
        tasks.delete_task(task_id)

    target = _target(settings, store, agent_id, receiver)
    taken = set(tasks.load_tasks())
    created = 0
    created_lessons = 0

    morning = settings["morning"]
    if morning["enabled"]:
        expression = digest_cron(morning["time"])
        if expression:
            tasks.add_task(_task(
                owner,
                f"{PREFIX} 早晨简报",
                expression,
                _action(target, type="teaching_digest"),
                moment,
                taken,
            ))
            created += 1
        else:
            logger.warning(f"[Teaching] invalid morning time: {morning['time']!r}")

    lesson = settings["lesson"]
    if lesson["enabled"]:
        for slot in store.get_timetable()["slots"]:
            if not slot.get("mine", True):
                continue
            info = store.lesson_info(slot)
            expression = lesson_cron(slot["weekday"], info["start"],
                                     lesson["minutes"])
            if not expression:
                logger.warning(
                    f"[Teaching] cannot schedule reminder for slot {slot.get('id')}: "
                    f"start={info['start']!r}"
                )
                continue
            text = build_lesson(
                lesson["minutes"], info["period"], info["start"],
                info["class_name"], info["subject"],
                topic=info["topic"], homework=info["homework"],
            )
            tasks.add_task(_task(
                owner,
                f"{PREFIX} 课前提醒 {weekday_label(slot['weekday'])} "
                f"{info['start']} {info['class_name']}",
                expression,
                _action(target, type="send_message", content=text),
                moment,
                taken,
            ))
            created += 1
            created_lessons += 1

    return {
        "scheduled": created,
        "digest": {"enabled": bool(morning["enabled"])},
        "lesson": {"count": created_lessons},
    }


def preview(store, *, agent_id: Optional[str] = None,
            now: Optional[datetime] = None) -> dict:
    """The two texts the UI shows: today's digest and the next lesson reminder."""
    moment = now or datetime.now()
    today_view = store.today(moment.date().isoformat(), agent_id=agent_id)
    settings = store.get_settings()
    upcoming = store.upcoming_lesson(moment)
    next_lesson = ""
    if upcoming:
        next_lesson = build_lesson(
            settings["lesson"]["minutes"], upcoming["period"], upcoming["start"],
            upcoming["class_name"], upcoming["subject"],
            topic=upcoming["topic"], homework=upcoming["homework"],
        )
    return {"digest": today_view["digest_text"], "next_lesson": next_lesson}


def auto_sync(store, *, agent_id: Optional[str] = None,
              receiver: Optional[str] = None) -> Optional[dict]:
    """Best-effort sync after a save; a scheduler that is not running is fine."""
    try:
        from agent.tools.scheduler.integration import get_scheduler_service

        service = get_scheduler_service()
        if service is None or not getattr(service, "running", False):
            logger.debug("[Teaching] scheduler not running; reminder sync deferred")
            return None
        return sync(store, agent_id=agent_id, receiver=receiver)
    except Exception as e:
        logger.warning(f"[Teaching] automatic reminder sync failed: {e}")
        return None


__all__ = [
    "DEFAULT_RECEIVER",
    "PREFIX",
    "WEEKDAY_LABELS",
    "auto_sync",
    "build_digest",
    "build_lesson",
    "digest_cron",
    "lesson_cron",
    "preview",
    "sync",
    "teacher_name",
    "weekday_label",
]
