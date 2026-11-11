"""Structured teaching data: classes, rosters, timetable, progress, homework,
exams and scores.

One JSON document per domain under ``<state_root>/teaching/``:

    classes.json   {version, classes:[{id,name,grade,subject,room,created_at}]}
    students.json  {version, students:[{id,class_id,no,name,gender,tags,note}]}
    timetable.json {version, periods, slots, overrides}
    progress.json  {version, items:[{id,class_id,topic,planned_periods,taught_periods,order,updated_at}]}
    homework.json  {version, items:[...], records:{hw_id:{student_id:state}}}
    exams.json     {version, exams:[...]}
    scores.json    {version, by_exam:{exam_id:{student_id:{total,items}}}}
    settings.json  {version, morning, lesson, channel}
    profile.json   {version, name, subjects, classes, textbook, school, onboarded}
    daily_motto.json {date, text}    -- the home page's cached line for one day

The same rules as the board and scheduler stores apply: one module-level lock
per resolved file, atomic replacement, and a file that fails to parse reads as
empty with a warning instead of taking the page down. All validation happens
before anything is written, so a rejected call leaves every file byte-identical
and the caller gets a ``ValueError`` naming the field it refused. An unknown id
raises ``KeyError`` -- the API turns that into ``not_found``.

The store never takes an agent or tenant id: its root is either the ``base``
passed in (tests, callers that already resolved a workspace) or
``<state_root()>/teaching`` resolved on each call, so a long-lived store follows
the request's tenant.
"""

from __future__ import annotations

import contextlib
import json
import math
import os
import re
import threading
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional

from common.atomic_write import write_json_atomic
from common.log import logger

STORE_VERSION = 1

FILES = {
    "classes": "classes.json",
    "students": "students.json",
    "timetable": "timetable.json",
    "progress": "progress.json",
    "homework": "homework.json",
    "exams": "exams.json",
    "scores": "scores.json",
    "settings": "settings.json",
    "profile": "profile.json",
    "motto": "daily_motto.json",
}

#: The teacher's own identity. ``onboarded`` is set by the store on the first
#: successful save, so the console can tell "never asked" from "left blank".
PROFILE_FIELDS = ("name", "subjects", "classes", "textbook", "school")
MAX_PROFILE_NAME = 20
MAX_PROFILE_SUBJECTS = 6
MAX_PROFILE_CLASSES = 12
MAX_PROFILE_ITEM = 40
MAX_PROFILE_TEXT = 40
PROFILE_TEXT_FIELDS = ("textbook", "school")

#: Reminder settings, written only when a teacher changes them. ``time`` is the
#: local wall clock of the morning digest; ``minutes`` is how long before a
#: lesson starts its reminder fires.
DEFAULT_SETTINGS = {
    "morning": {"enabled": True, "time": "07:30"},
    "lesson": {"enabled": True, "minutes": 10},
    "channel": "web",
}
SETTINGS_KEYS = ("morning", "lesson", "channel")
MAX_CHANNEL = 20

#: Slot types the timetable grid offers (正课/早读/辅导/晚自习/课后服务/教研/值班).
TIMETABLE_KINDS = (
    "regular",
    "morning",
    "tutor",
    "evening",
    "after_school",
    "research",
    "duty",
)
OVERRIDE_STATES = ("changed", "cancelled")

#: Homework types (练习/试卷/预习/项目/订正).
HOMEWORK_KINDS = ("practice", "paper", "preview", "project", "correction")

#: Per-student homework states.
SUBMISSION_STATES = ("submitted", "excellent", "fix", "missing")

MAX_CLASS_NAME = 40
MAX_GRADE = 20
MAX_SUBJECT = 40
MAX_ROOM = 40
MAX_NAME = 40
MAX_NO = 40
MAX_GENDER = 10
MAX_TAG = 20
MAX_TAGS = 10
MAX_NOTE = 500
MAX_TOPIC = 120
MAX_HOMEWORK_TITLE = 120
MAX_EXAM_NAME = 120
MAX_ITEM_KEY = 20
MAX_ITEM_LABEL = 40
MAX_ITEMS = 30
MAX_TEACHER = 40

_CLASS_FIELDS = ("name", "grade", "subject", "room")
_STUDENT_FIELDS = ("class_id", "no", "name", "gender", "tags", "note")
_PROGRESS_FIELDS = ("class_id", "topic", "planned_periods", "taught_periods", "order")
_HOMEWORK_FIELDS = ("class_ids", "title", "kind", "due")
_EXAM_FIELDS = ("class_ids", "name", "subject", "full_score", "date", "items")

#: What ``/api/teaching/today`` exposes for one lesson. ``teacher`` and
#: ``homework`` are internal (the reminder needs them) and stay out of the shape.
_LESSON_PUBLIC_FIELDS = (
    "period", "start", "end", "class_id", "class_name", "subject", "kind",
    "mine", "topic",
)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CLOCK_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

_locks_guard = threading.Lock()
_locks: Dict[str, threading.RLock] = {}


def teaching_dir() -> Path:
    """The current Agent's teaching data root, resolved at call time."""
    from common.state_dir import state_root

    return state_root() / "teaching"


def _lock_for_path(path: str) -> threading.RLock:
    key = os.path.normcase(os.path.realpath(path))
    with _locks_guard:
        return _locks.setdefault(key, threading.RLock())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value, default: str = "") -> str:
    return value.strip() if isinstance(value, str) else default


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _new_id(taken: Iterable[str]) -> str:
    taken = set(taken)
    while True:
        candidate = uuid.uuid4().hex[:12]
        if candidate not in taken:
            return candidate


# --- Validation: every rejected field raises ValueError before any write ----


def _text_field(value, field: str, *, required: bool = False,
                limit: Optional[int] = None) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    text = value.strip()
    if required and not text:
        raise ValueError(f"{field} is required")
    if limit is not None and len(text) > limit:
        raise ValueError(f"{field} must be at most {limit} characters")
    return text


def _key(value, field: str = "id") -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} is required")
    return value.strip()


def _number_field(value, field: str, *, minimum: Optional[float] = None,
                  exclusive_minimum: bool = False,
                  maximum: Optional[float] = None) -> float:
    if not _is_number(value):
        raise ValueError(f"{field} must be a number")
    number = float(value)
    if math.isnan(number) or math.isinf(number):
        raise ValueError(f"{field} must be a finite number")
    if minimum is not None:
        if exclusive_minimum and number <= minimum:
            raise ValueError(f"{field} must be greater than {minimum:g}")
        if not exclusive_minimum and number < minimum:
            raise ValueError(f"{field} must be at least {minimum:g}")
    if maximum is not None and number > maximum:
        raise ValueError(f"{field} must be at most {maximum:g}")
    return round(number, 2)


def _int_field(value, field: str, *, minimum: Optional[int] = None) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer")
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if not isinstance(value, int):
        raise ValueError(f"{field} must be an integer")
    if minimum is not None and value < minimum:
        raise ValueError(f"{field} must be at least {minimum}")
    return value


def _date_field(value, field: str, *, required: bool = True) -> str:
    text = _text_field(value, field, required=required)
    if not text:
        return ""
    if not _DATE_RE.match(text):
        raise ValueError(f"{field} must be YYYY-MM-DD")
    try:
        date.fromisoformat(text)
    except ValueError:
        raise ValueError(f"{field} is not a valid date: {text}") from None
    return text


def _clock_field(value, field: str) -> str:
    text = _text_field(value, field, required=True)
    if not _CLOCK_RE.match(text):
        raise ValueError(f"{field} must be HH:MM")
    return text


def _bool_field(value, field: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def _id_list(value, field: str = "class_ids") -> List[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list of ids")
    ids: List[str] = []
    for raw in value:
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f"{field} must contain non-empty ids")
        candidate = raw.strip()
        if candidate not in ids:
            ids.append(candidate)
    if not ids:
        raise ValueError(f"{field} is required")
    return ids


def _tags(value) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts: List = re.split(r"[,，、;；\s]+", value.strip())
    elif isinstance(value, list):
        parts = value
    else:
        raise ValueError("tags must be a list or a comma-separated string")
    tags: List[str] = []
    for part in parts:
        if not isinstance(part, str):
            raise ValueError("tags must be strings")
        tag = part.strip()
        if tag and tag not in tags:
            tags.append(tag[:MAX_TAG])
    return tags[:MAX_TAGS]


def _enum(value, field: str, allowed) -> str:
    if value not in allowed:
        raise ValueError(f"invalid {field}: {value!r}")
    return value


def _clean_class(fields: dict) -> dict:
    unknown = set(fields) - set(_CLASS_FIELDS)
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {}
    if "name" in fields:
        clean["name"] = _text_field(fields["name"], "name", required=True,
                                    limit=MAX_CLASS_NAME)
    if "grade" in fields:
        clean["grade"] = _text_field(fields["grade"], "grade", limit=MAX_GRADE)
    if "subject" in fields:
        clean["subject"] = _text_field(fields["subject"], "subject", limit=MAX_SUBJECT)
    if "room" in fields:
        clean["room"] = _text_field(fields["room"], "room", limit=MAX_ROOM)
    return clean


def _clean_student(fields: dict) -> dict:
    unknown = set(fields) - set(_STUDENT_FIELDS)
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {}
    if "class_id" in fields:
        clean["class_id"] = _key(fields["class_id"], "class_id")
    if "no" in fields:
        clean["no"] = _text_field(fields["no"], "no", required=True, limit=MAX_NO)
    if "name" in fields:
        clean["name"] = _text_field(fields["name"], "name", required=True,
                                    limit=MAX_NAME)
    if "gender" in fields:
        clean["gender"] = _text_field(fields["gender"], "gender", limit=MAX_GENDER)
    if "tags" in fields:
        clean["tags"] = _tags(fields["tags"])
    if "note" in fields:
        clean["note"] = _text_field(fields["note"], "note", limit=MAX_NOTE)
    return clean


def _clean_progress(fields: dict) -> dict:
    unknown = set(fields) - set(_PROGRESS_FIELDS)
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {}
    if "class_id" in fields:
        clean["class_id"] = _key(fields["class_id"], "class_id")
    if "topic" in fields:
        clean["topic"] = _text_field(fields["topic"], "topic", required=True,
                                     limit=MAX_TOPIC)
    if "planned_periods" in fields:
        clean["planned_periods"] = _int_field(fields["planned_periods"],
                                             "planned_periods", minimum=0)
    if "taught_periods" in fields:
        clean["taught_periods"] = _int_field(fields["taught_periods"],
                                            "taught_periods", minimum=0)
    if "order" in fields:
        clean["order"] = _int_field(fields["order"], "order", minimum=0)
    return clean


def _clean_homework(fields: dict) -> dict:
    unknown = set(fields) - set(_HOMEWORK_FIELDS) - {"class_id"}
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {}
    if "class_ids" in fields or "class_id" in fields:
        raw = fields.get("class_ids", fields.get("class_id"))
        clean["class_ids"] = _id_list(raw, "class_ids")
    if "title" in fields:
        clean["title"] = _text_field(fields["title"], "title", required=True,
                                     limit=MAX_HOMEWORK_TITLE)
    if "kind" in fields:
        clean["kind"] = _enum(fields["kind"], "kind", HOMEWORK_KINDS)
    if "due" in fields:
        clean["due"] = _date_field(fields["due"], "due")
    return clean


def _clean_exam_items(value) -> List[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("items must be a list")
    if len(value) > MAX_ITEMS:
        raise ValueError(f"items must be at most {MAX_ITEMS} entries")
    items: List[dict] = []
    keys = set()
    for index, raw in enumerate(value, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"items[{index}] must be an object")
        key = _text_field(raw.get("key"), "item key", required=True, limit=MAX_ITEM_KEY)
        if key in keys:
            raise ValueError(f"duplicate item key: {key}")
        keys.add(key)
        full = _number_field(raw.get("full"), f"item {key} full", minimum=0,
                             exclusive_minimum=True)
        label = _text_field(raw.get("label") if raw.get("label") is not None else key,
                            f"item {key} label", limit=MAX_ITEM_LABEL)
        items.append({"key": key, "label": label or key, "full": full})
    return items


def _clean_exam(fields: dict) -> dict:
    unknown = set(fields) - set(_EXAM_FIELDS) - {"class_id"}
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {}
    if "class_ids" in fields or "class_id" in fields:
        raw = fields.get("class_ids", fields.get("class_id"))
        clean["class_ids"] = _id_list(raw, "class_ids")
    if "name" in fields:
        clean["name"] = _text_field(fields["name"], "name", required=True,
                                    limit=MAX_EXAM_NAME)
    if "subject" in fields:
        clean["subject"] = _text_field(fields["subject"], "subject", limit=MAX_SUBJECT)
    if "full_score" in fields:
        clean["full_score"] = _number_field(fields["full_score"], "full_score",
                                            minimum=0, exclusive_minimum=True)
    if "date" in fields:
        clean["date"] = _date_field(fields["date"], "date")
    if "items" in fields:
        clean["items"] = _clean_exam_items(fields["items"])
    return clean


def _clean_periods(value) -> List[dict]:
    if not isinstance(value, list):
        raise ValueError("periods must be a list")
    periods: List[dict] = []
    seen = set()
    for index, raw in enumerate(value, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"periods[{index}] must be an object")
        number = _int_field(raw.get("index"), f"periods[{index}].index", minimum=1)
        if number in seen:
            raise ValueError(f"duplicate period index: {number}")
        seen.add(number)
        periods.append({
            "index": number,
            "start": _text_field(raw.get("start"), f"periods[{index}].start"),
            "end": _text_field(raw.get("end"), f"periods[{index}].end"),
        })
    return periods


def _clean_slots(value, class_ids: set, taken_ids: set) -> List[dict]:
    if not isinstance(value, list):
        raise ValueError("slots must be a list")
    slots: List[dict] = []
    taken = set(taken_ids)
    for index, raw in enumerate(value, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"slots[{index}] must be an object")
        class_id = _key(raw.get("class_id"), f"slots[{index}].class_id")
        if class_id not in class_ids:
            raise KeyError(class_id)
        slot_id = _text(raw.get("id"))
        if not slot_id or slot_id in taken:
            slot_id = _new_id(taken)
        taken.add(slot_id)
        mine = raw.get("mine", True)
        if not isinstance(mine, bool):
            raise ValueError(f"slots[{index}].mine must be a boolean")
        slots.append({
            "id": slot_id,
            "class_id": class_id,
            "weekday": _int_field(raw.get("weekday"), f"slots[{index}].weekday",
                                  minimum=1),
            "period": _int_field(raw.get("period"), f"slots[{index}].period",
                                 minimum=1),
            "subject": _text_field(raw.get("subject"), f"slots[{index}].subject",
                                   limit=MAX_SUBJECT),
            "kind": _enum(raw.get("kind") or "regular", f"slots[{index}].kind",
                          TIMETABLE_KINDS),
            "mine": mine,
            "teacher": _text_field(raw.get("teacher"),
                                   f"slots[{index}].teacher", limit=MAX_TEACHER),
        })
        if slots[-1]["weekday"] > 7:
            raise ValueError(f"slots[{index}].weekday must be between 1 and 7")
    return slots


def _clean_overrides(value, class_ids: set) -> List[dict]:
    if not isinstance(value, list):
        raise ValueError("overrides must be a list")
    overrides: List[dict] = []
    for index, raw in enumerate(value, 1):
        if not isinstance(raw, dict):
            raise ValueError(f"overrides[{index}] must be an object")
        class_id = _key(raw.get("class_id"), f"overrides[{index}].class_id")
        if class_id not in class_ids:
            raise KeyError(class_id)
        kind = raw.get("kind") or "regular"
        if kind not in TIMETABLE_KINDS:
            raise ValueError(f"invalid overrides[{index}].kind: {kind!r}")
        overrides.append({
            "date": _date_field(raw.get("date"), f"overrides[{index}].date"),
            "period": _int_field(raw.get("period"), f"overrides[{index}].period",
                                 minimum=1),
            "class_id": class_id,
            "subject": _text_field(raw.get("subject"), f"overrides[{index}].subject",
                                   limit=MAX_SUBJECT),
            "kind": kind,
            "state": _enum(raw.get("state") or "changed",
                           f"overrides[{index}].state", OVERRIDE_STATES),
        })
    return overrides


def default_settings() -> dict:
    """A fresh copy of the reminder defaults, safe for a caller to mutate."""
    return {
        "morning": dict(DEFAULT_SETTINGS["morning"]),
        "lesson": dict(DEFAULT_SETTINGS["lesson"]),
        "channel": DEFAULT_SETTINGS["channel"],
    }


def _normalize_settings(raw) -> dict:
    """Read the settings file leniently: process defaults beat hand damage."""
    settings = default_settings()
    if not isinstance(raw, dict):
        return settings
    morning = raw.get("morning")
    if isinstance(morning, dict):
        if isinstance(morning.get("enabled"), bool):
            settings["morning"]["enabled"] = morning["enabled"]
        time_text = _text(morning.get("time"))
        if _CLOCK_RE.match(time_text):
            settings["morning"]["time"] = time_text
    lesson = raw.get("lesson")
    if isinstance(lesson, dict):
        if isinstance(lesson.get("enabled"), bool):
            settings["lesson"]["enabled"] = lesson["enabled"]
        minutes = lesson.get("minutes")
        if isinstance(minutes, int) and not isinstance(minutes, bool) and 1 <= minutes <= 60:
            settings["lesson"]["minutes"] = minutes
    channel = _text(raw.get("channel"))
    if channel and len(channel) <= MAX_CHANNEL:
        settings["channel"] = channel
    return settings


def _clean_settings(fields: dict, current: dict) -> dict:
    """Validate a partial settings update against the values already stored."""
    unknown = set(fields) - set(SETTINGS_KEYS)
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {
        "morning": dict(current["morning"]),
        "lesson": dict(current["lesson"]),
        "channel": current["channel"],
    }
    if "morning" in fields:
        raw = fields["morning"]
        if not isinstance(raw, dict):
            raise ValueError("morning must be an object")
        extra = set(raw) - {"enabled", "time"}
        if extra:
            raise ValueError(f"unknown morning field(s): {', '.join(sorted(extra))}")
        if "enabled" in raw:
            clean["morning"]["enabled"] = _bool_field(raw["enabled"], "morning.enabled")
        if "time" in raw:
            clean["morning"]["time"] = _clock_field(raw["time"], "morning.time")
    if "lesson" in fields:
        raw = fields["lesson"]
        if not isinstance(raw, dict):
            raise ValueError("lesson must be an object")
        extra = set(raw) - {"enabled", "minutes"}
        if extra:
            raise ValueError(f"unknown lesson field(s): {', '.join(sorted(extra))}")
        if "enabled" in raw:
            clean["lesson"]["enabled"] = _bool_field(raw["enabled"], "lesson.enabled")
        if "minutes" in raw:
            minutes = _int_field(raw["minutes"], "lesson.minutes", minimum=1)
            if minutes > 60:
                raise ValueError("lesson.minutes must be at most 60")
            clean["lesson"]["minutes"] = minutes
    if "channel" in fields:
        clean["channel"] = _text_field(fields["channel"], "channel", required=True,
                                       limit=MAX_CHANNEL)
    return clean


def default_profile() -> dict:
    """A fresh profile with the onboarding flag clear and every field empty."""
    return {
        "name": "",
        "subjects": [],
        "classes": [],
        "textbook": "",
        "school": "",
        "onboarded": False,
    }


def _profile_list(value, field: str, limit: int) -> List[str]:
    """A list of short labels; a comma-separated string is accepted as a list.

    The dialog lets the teacher type ``七（1）班、七（2）班``, so the same
    separators the roster paste uses are honoured here. Empty parts are dropped
    and duplicates collapse, which is what makes the pill display truthful.
    """
    if value is None:
        return []
    if isinstance(value, str):
        parts: List = re.split(r"[,，、;；]+", value.strip())
    elif isinstance(value, list):
        parts = value
    else:
        raise ValueError(f"{field} must be a list of strings")
    labels: List[str] = []
    for raw in parts:
        if not isinstance(raw, str):
            raise ValueError(f"{field} must be strings")
        label = raw.strip()
        if not label:
            continue
        if "\n" in label or "\r" in label:
            raise ValueError(f"{field} must not contain line breaks")
        if len(label) > MAX_PROFILE_ITEM:
            raise ValueError(f"{field} items must be at most {MAX_PROFILE_ITEM} characters")
        if label not in labels:
            labels.append(label)
    if len(labels) > limit:
        raise ValueError(f"{field} must contain at most {limit} items")
    return labels


def _normalize_profile(raw) -> dict:
    """Read the profile leniently; a damaged file means "not onboarded yet"."""
    profile = default_profile()
    if not isinstance(raw, dict):
        return profile
    name = " ".join(_text(raw.get("name")).split())[:MAX_PROFILE_NAME]
    profile["name"] = name
    for field, limit in (("subjects", MAX_PROFILE_SUBJECTS),
                         ("classes", MAX_PROFILE_CLASSES)):
        values = raw.get(field)
        if isinstance(values, list):
            labels: List[str] = []
            for entry in values:
                if isinstance(entry, str) and entry.strip():
                    label = " ".join(entry.split())[:MAX_PROFILE_ITEM]
                    if label not in labels:
                        labels.append(label)
            profile[field] = labels[:limit]
    for field in PROFILE_TEXT_FIELDS:
        profile[field] = " ".join(_text(raw.get(field)).split())[:MAX_PROFILE_TEXT]
    profile["onboarded"] = bool(raw.get("onboarded")) and bool(name)
    return profile


def _clean_profile(fields: dict, current: dict) -> dict:
    """Validate a whole profile update against what is already stored.

    Name is required in the merged result rather than in the call, so a partial
    save can add a school to an existing profile without restating the name.
    """
    unknown = set(fields) - set(PROFILE_FIELDS)
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    clean = {
        "name": current["name"],
        "subjects": list(current["subjects"]),
        "classes": list(current["classes"]),
        "textbook": current["textbook"],
        "school": current["school"],
    }
    if "name" in fields:
        clean["name"] = _text_field(fields["name"], "name", required=True,
                                    limit=MAX_PROFILE_NAME)
        if "\n" in clean["name"] or "\r" in clean["name"]:
            raise ValueError("name must not contain line breaks")
    if "subjects" in fields:
        clean["subjects"] = _profile_list(
            fields["subjects"], "subjects", MAX_PROFILE_SUBJECTS)
    if "classes" in fields:
        clean["classes"] = _profile_list(
            fields["classes"], "classes", MAX_PROFILE_CLASSES)
    for field in PROFILE_TEXT_FIELDS:
        if field in fields:
            text = _text_field(fields[field], field, limit=MAX_PROFILE_TEXT)
            if "\n" in text or "\r" in text:
                raise ValueError(f"{field} must not contain line breaks")
            clean[field] = text
    if not clean["name"]:
        raise ValueError("name is required")
    return clean


# --- Lenient readers: hand edits and older files get repaired, not raised ---


def _normalize_class(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    class_id = _text(raw.get("id"))
    name = _text(raw.get("name"))[:MAX_CLASS_NAME]
    if not class_id or not name:
        return None
    return {
        "id": class_id,
        "name": name,
        "grade": _text(raw.get("grade"))[:MAX_GRADE],
        "subject": _text(raw.get("subject"))[:MAX_SUBJECT],
        "room": _text(raw.get("room"))[:MAX_ROOM],
        "created_at": _text(raw.get("created_at")),
    }


def _normalize_student(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    student_id = _text(raw.get("id"))
    class_id = _text(raw.get("class_id"))
    name = _text(raw.get("name"))[:MAX_NAME]
    no = _text(raw.get("no"))[:MAX_NO]
    if not student_id or not class_id or not name or not no:
        return None
    raw_tags = raw.get("tags")
    tags = []
    if isinstance(raw_tags, list):
        for part in raw_tags:
            tag = _text(part)[:MAX_TAG]
            if tag and tag not in tags:
                tags.append(tag)
    return {
        "id": student_id,
        "class_id": class_id,
        "no": no,
        "name": name,
        "gender": _text(raw.get("gender"))[:MAX_GENDER],
        "tags": tags[:MAX_TAGS],
        "note": _text(raw.get("note"))[:MAX_NOTE],
    }


def _normalize_period(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    try:
        index = _int_field(raw.get("index"), "index", minimum=1)
    except ValueError:
        return None
    return {
        "index": index,
        "start": _text(raw.get("start")),
        "end": _text(raw.get("end")),
    }


def _normalize_slot(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    slot_id = _text(raw.get("id"))
    class_id = _text(raw.get("class_id"))
    try:
        weekday = _int_field(raw.get("weekday"), "weekday", minimum=1)
        period = _int_field(raw.get("period"), "period", minimum=1)
    except ValueError:
        return None
    if not slot_id or not class_id or weekday > 7:
        return None
    kind = raw.get("kind") if raw.get("kind") in TIMETABLE_KINDS else "regular"
    mine = raw.get("mine")
    if not isinstance(mine, bool):
        # Rows written before ownership existed are the teacher's own lessons.
        mine = True
    return {
        "id": slot_id,
        "class_id": class_id,
        "weekday": weekday,
        "period": period,
        "subject": _text(raw.get("subject"))[:MAX_SUBJECT],
        "kind": kind,
        "mine": mine,
        "teacher": _text(raw.get("teacher"))[:MAX_TEACHER],
    }


def _normalize_override(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    class_id = _text(raw.get("class_id"))
    try:
        period = _int_field(raw.get("period"), "period", minimum=1)
    except ValueError:
        return None
    if not class_id:
        return None
    state = raw.get("state") if raw.get("state") in OVERRIDE_STATES else "changed"
    kind = raw.get("kind") if raw.get("kind") in TIMETABLE_KINDS else "regular"
    return {
        "date": _text(raw.get("date")),
        "period": period,
        "class_id": class_id,
        "subject": _text(raw.get("subject"))[:MAX_SUBJECT],
        "kind": kind,
        "state": state,
    }


def _lenient_int(value, minimum: int = 0, default: int = 0) -> int:
    if isinstance(value, bool) or not _is_number(value):
        return default
    number = int(value)
    return number if number >= minimum else default


def _normalize_progress(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    item_id = _text(raw.get("id"))
    class_id = _text(raw.get("class_id"))
    topic = _text(raw.get("topic"))[:MAX_TOPIC]
    if not item_id or not class_id or not topic:
        return None
    return {
        "id": item_id,
        "class_id": class_id,
        "topic": topic,
        "planned_periods": _lenient_int(raw.get("planned_periods")),
        "taught_periods": _lenient_int(raw.get("taught_periods")),
        "order": _lenient_int(raw.get("order")),
        "updated_at": _text(raw.get("updated_at")),
    }


def _normalize_homework(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    item_id = _text(raw.get("id"))
    title = _text(raw.get("title"))[:MAX_HOMEWORK_TITLE]
    if not item_id or not title:
        return None
    raw_ids = raw.get("class_ids")
    class_ids = []
    if isinstance(raw_ids, list):
        for value in raw_ids:
            class_id = _text(value)
            if class_id and class_id not in class_ids:
                class_ids.append(class_id)
    if not class_ids:
        return None
    return {
        "id": item_id,
        "class_ids": class_ids,
        "title": title,
        "kind": raw.get("kind") if raw.get("kind") in HOMEWORK_KINDS else "practice",
        "due": _text(raw.get("due"))[:10],
        "created_at": _text(raw.get("created_at")),
    }


def _normalize_exam(raw) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    exam_id = _text(raw.get("id"))
    name = _text(raw.get("name"))[:MAX_EXAM_NAME]
    if not exam_id or not name:
        return None
    raw_ids = raw.get("class_ids")
    class_ids = []
    if isinstance(raw_ids, list):
        for value in raw_ids:
            class_id = _text(value)
            if class_id and class_id not in class_ids:
                class_ids.append(class_id)
    if not class_ids:
        return None
    full_score = raw.get("full_score")
    if not _is_number(full_score) or float(full_score) <= 0:
        return None
    items = []
    keys = set()
    raw_items = raw.get("items")
    if isinstance(raw_items, list):
        for entry in raw_items:
            if not isinstance(entry, dict):
                continue
            key = _text(entry.get("key"))[:MAX_ITEM_KEY]
            if not key or key in keys:
                continue
            full = entry.get("full")
            if not _is_number(full) or float(full) <= 0:
                continue
            keys.add(key)
            items.append({
                "key": key,
                "label": (_text(entry.get("label")) or key)[:MAX_ITEM_LABEL],
                "full": round(float(full), 2),
            })
    return {
        "id": exam_id,
        "name": name,
        "date": _text(raw.get("date"))[:10],
        "class_ids": class_ids,
        "subject": _text(raw.get("subject"))[:MAX_SUBJECT],
        "full_score": round(float(full_score), 2),
        "items": items,
    }


def _normalize_score_rows(raw) -> Dict[str, dict]:
    """One exam's score block, dropping records that cannot mean anything."""
    if not isinstance(raw, dict):
        return {}
    rows: Dict[str, dict] = {}
    for student_id, record in raw.items():
        if not isinstance(student_id, str) or not student_id.strip():
            continue
        if not isinstance(record, dict):
            continue
        raw_items = record.get("items")
        items: Dict[str, Optional[float]] = {}
        if isinstance(raw_items, dict):
            for key, value in raw_items.items():
                if not isinstance(key, str) or not key:
                    continue
                items[key] = round(float(value), 2) if _is_number(value) else None
        total = record.get("total")
        if _is_number(total):
            total = round(float(total), 2)
        elif items:
            present = [value for value in items.values() if value is not None]
            total = round(float(sum(present)), 2) if present else None
        else:
            total = None
        rows[student_id.strip()] = {"total": total, "items": items}
    return rows


class TeachingStore:
    """CRUD over one tenant's ``teaching/`` documents.

    ``base=None`` resolves ``<state_root>/teaching`` on every call, which is
    what a long-lived tool needs: the ambient identity decides the tenant, not
    the object's construction time. An explicit ``base`` is the teaching
    directory itself (tests point it at a tmp path).
    """

    def __init__(self, base=None):
        self._explicit_base = os.fspath(base) if base is not None else None

    @property
    def base(self) -> Path:
        if self._explicit_base is not None:
            return Path(self._explicit_base)
        return teaching_dir()

    # --- File plumbing -----------------------------------------------------

    def _path(self, name: str) -> Path:
        return self.base / FILES[name]

    @contextlib.contextmanager
    def _locked(self, *names: str):
        """Hold every named file's lock, always in the same (sorted) order."""
        locks = [_lock_for_path(str(self._path(name))) for name in sorted(set(names))]
        for lock in locks:
            lock.acquire()
        try:
            yield
        finally:
            for lock in reversed(locks):
                lock.release()

    def _read_doc(self, name: str) -> dict:
        path = self._path(name)
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as e:
            logger.warning(f"[Teaching] cannot read {path}, treating as empty: {e}")
            return {}
        try:
            doc = json.loads(raw)
        except ValueError as e:
            # The page must open; the next write repairs the file.
            logger.warning(f"[Teaching] {path} is not valid JSON, treating as empty: {e}")
            return {}
        if not isinstance(doc, dict):
            logger.warning(f"[Teaching] {path} is not a JSON object, treating as empty")
            return {}
        return doc

    def _write_doc(self, name: str, payload: dict) -> None:
        path = self._path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(path, {"version": STORE_VERSION, **payload}, indent=2)

    def _records(self, name: str, key: str, normalize) -> List[dict]:
        doc = self._read_doc(name)
        raw = doc.get(key)
        if raw is None:
            return []
        if not isinstance(raw, list):
            logger.warning(f"[Teaching] {self._path(name)} {key} is not a list")
            return []
        records = []
        for entry in raw:
            record = normalize(entry)
            if record is not None:
                records.append(record)
        return records

    # --- Domain readers ----------------------------------------------------

    def _classes(self) -> List[dict]:
        return self._records("classes", "classes", _normalize_class)

    def _students(self) -> List[dict]:
        return self._records("students", "students", _normalize_student)

    def _progress(self) -> List[dict]:
        return self._records("progress", "items", _normalize_progress)

    def _homework_items(self) -> List[dict]:
        return self._records("homework", "items", _normalize_homework)

    def _exams(self) -> List[dict]:
        return self._records("exams", "exams", _normalize_exam)

    def _homework_doc(self):
        doc = self._read_doc("homework")
        items = self._records("homework", "items", _normalize_homework)
        raw_records = doc.get("records")
        records: Dict[str, Dict[str, str]] = {}
        if isinstance(raw_records, dict):
            for hw_id, row in raw_records.items():
                if not isinstance(hw_id, str) or not hw_id:
                    continue
                if not isinstance(row, dict):
                    continue
                clean = {
                    student_id.strip(): state
                    for student_id, state in row.items()
                    if isinstance(student_id, str) and student_id.strip()
                    and state in SUBMISSION_STATES
                }
                records[hw_id] = clean
        return items, records

    def _timetable_doc(self) -> dict:
        doc = self._read_doc("timetable")
        periods = doc.get("periods")
        slots = doc.get("slots")
        overrides = doc.get("overrides")
        return {
            "periods": [p for p in (map(_normalize_period, periods)
                                    if isinstance(periods, list) else []) if p],
            "slots": [s for s in (map(_normalize_slot, slots)
                                  if isinstance(slots, list) else []) if s],
            "overrides": [o for o in (map(_normalize_override, overrides)
                                      if isinstance(overrides, list) else []) if o],
        }

    def _scores_map(self) -> Dict[str, dict]:
        doc = self._read_doc("scores")
        raw = doc.get("by_exam")
        if not isinstance(raw, dict):
            return {}
        return {
            exam_id: _normalize_score_rows(block)
            for exam_id, block in raw.items()
            if isinstance(exam_id, str) and exam_id
        }

    # --- Lookups -----------------------------------------------------------

    @staticmethod
    def _find(records: List[dict], record_id: str) -> dict:
        for record in records:
            if record.get("id") == record_id:
                return record
        raise KeyError(record_id)

    def _require_classes(self, classes: List[dict], class_ids: Iterable[str]) -> None:
        known = {entry["id"] for entry in classes}
        for class_id in class_ids:
            if class_id not in known:
                raise KeyError(class_id)

    # --- Classes -----------------------------------------------------------

    def list_classes(self) -> List[dict]:
        with self._locked("classes"):
            return self._classes()

    def get_class(self, class_id: str) -> dict:
        with self._locked("classes"):
            return self._find(self._classes(), _key(class_id, "class_id"))

    def create_class(self, name, grade="", subject="", room="") -> dict:
        clean = _clean_class({
            "name": name, "grade": grade, "subject": subject, "room": room,
        })
        with self._locked("classes"):
            classes = self._classes()
            record = {
                "id": _new_id(entry["id"] for entry in classes),
                **clean,
                "created_at": _now(),
            }
            classes.append(record)
            self._write_doc("classes", {"classes": classes})
            return record

    def update_class(self, class_id: str, **fields) -> dict:
        class_id = _key(class_id, "class_id")
        clean = _clean_class(fields)
        if not clean:
            raise ValueError("no fields to update")
        with self._locked("classes"):
            classes = self._classes()
            record = self._find(classes, class_id)
            record.update(clean)
            self._write_doc("classes", {"classes": classes})
            return record

    def delete_class(self, class_id: str) -> dict:
        """Delete a class and everything that belongs to it.

        Cascading is the choice that matches the classroom: deleting a class
        means the roster, its timetable slots, its progress list and its
        participation in homework/exams go with it. Homework and exams shared
        with other classes keep those classes (and their records); only the
        ones left with no class at all are removed, together with their scores.
        """
        class_id = _key(class_id, "class_id")
        removed = {
            "students": 0,
            "slots": 0,
            "overrides": 0,
            "progress": 0,
            "homework": 0,
            "exams": 0,
        }
        with self._locked("classes", "students", "timetable", "progress",
                          "homework", "exams", "scores"):
            classes = self._classes()
            self._find(classes, class_id)
            self._write_doc("classes", {"classes": [
                entry for entry in classes if entry["id"] != class_id
            ]})

            students = self._students()
            dropped_students = {s["id"] for s in students if s["class_id"] == class_id}
            kept = [s for s in students if s["class_id"] != class_id]
            removed["students"] = len(dropped_students)
            if dropped_students:
                self._write_doc("students", {"students": kept})

            timetable = self._timetable_doc()
            slots = [s for s in timetable["slots"] if s["class_id"] != class_id]
            overrides = [o for o in timetable["overrides"] if o["class_id"] != class_id]
            removed["slots"] = len(timetable["slots"]) - len(slots)
            removed["overrides"] = len(timetable["overrides"]) - len(overrides)
            if removed["slots"] or removed["overrides"]:
                self._write_doc("timetable", {
                    **timetable, "slots": slots, "overrides": overrides,
                })

            progress = self._progress()
            kept_progress = [p for p in progress if p["class_id"] != class_id]
            removed["progress"] = len(progress) - len(kept_progress)
            if removed["progress"]:
                self._write_doc("progress", {"items": kept_progress})

            items, records = self._homework_doc()
            kept_items = []
            homework_changed = False
            for row in records.values():
                for student_id in dropped_students:
                    if row.pop(student_id, None) is not None:
                        homework_changed = True
            for item in items:
                if class_id in item["class_ids"]:
                    homework_changed = True
                    class_ids = [c for c in item["class_ids"] if c != class_id]
                    if not class_ids:
                        records.pop(item["id"], None)
                        removed["homework"] += 1
                        continue
                    item = {**item, "class_ids": class_ids}
                kept_items.append(item)
            if homework_changed:
                self._write_doc("homework", {"items": kept_items, "records": records})

            exams = self._exams()
            kept_exams = []
            dropped_exams = []
            exams_changed = False
            for exam in exams:
                if class_id in exam["class_ids"]:
                    exams_changed = True
                    class_ids = [c for c in exam["class_ids"] if c != class_id]
                    if not class_ids:
                        dropped_exams.append(exam["id"])
                        removed["exams"] += 1
                        continue
                    exam = {**exam, "class_ids": class_ids}
                kept_exams.append(exam)
            if exams_changed:
                self._write_doc("exams", {"exams": kept_exams})
            if dropped_exams or dropped_students:
                scores = self._scores_map()
                scores_changed = False
                for exam_id in dropped_exams:
                    if scores.pop(exam_id, None) is not None:
                        scores_changed = True
                for block in scores.values():
                    for student_id in dropped_students:
                        if block.pop(student_id, None) is not None:
                            scores_changed = True
                if scores_changed:
                    self._write_doc("scores", {"by_exam": scores})

        return {"class_id": class_id, "removed": removed}

    # --- Students ----------------------------------------------------------

    def list_students(self, class_id: Optional[str] = None) -> List[dict]:
        with self._locked("students", "classes"):
            students = self._students()
            if class_id is not None:
                class_id = _key(class_id, "class_id")
                self._find(self._classes(), class_id)
                students = [s for s in students if s["class_id"] == class_id]
            order = {entry["id"]: index for index, entry in enumerate(self._classes())}
            return sorted(
                students,
                key=lambda s: (order.get(s["class_id"], len(order)), s["no"], s["name"]),
            )

    def get_student(self, student_id: str) -> dict:
        with self._locked("students"):
            return self._find(self._students(), _key(student_id))

    @staticmethod
    def _require_free_no(students: List[dict], class_id: str, no: str,
                         exclude_id: Optional[str] = None) -> None:
        for student in students:
            if student["id"] == exclude_id:
                continue
            if student["class_id"] == class_id and student["no"] == no:
                raise ValueError(f"学号 already used in this class: {no}")

    def create_student(self, class_id, no, name, gender="", tags=None, note="") -> dict:
        class_id = _key(class_id, "class_id")
        clean = _clean_student({
            "no": no, "name": name, "gender": gender, "tags": tags, "note": note,
        })
        with self._locked("classes", "students"):
            self._require_classes(self._classes(), [class_id])
            students = self._students()
            self._require_free_no(students, class_id, clean["no"])
            record = {
                "id": _new_id(student["id"] for student in students),
                "class_id": class_id,
                **clean,
            }
            students.append(record)
            self._write_doc("students", {"students": students})
            return record

    def update_student(self, student_id: str, **fields) -> dict:
        student_id = _key(student_id)
        clean = _clean_student(fields)
        if not clean:
            raise ValueError("no fields to update")
        with self._locked("classes", "students"):
            classes = self._classes()
            students = self._students()
            student = self._find(students, student_id)
            if "class_id" in clean:
                self._require_classes(classes, [clean["class_id"]])
            class_id = clean.get("class_id", student["class_id"])
            no = clean.get("no", student["no"])
            self._require_free_no(students, class_id, no, exclude_id=student_id)
            student.update(clean)
            self._write_doc("students", {"students": students})
            return student

    def delete_student(self, student_id: str) -> bool:
        student_id = _key(student_id)
        with self._locked("students", "homework", "scores"):
            students = self._students()
            self._find(students, student_id)
            remaining = [s for s in students if s["id"] != student_id]
            self._write_doc("students", {"students": remaining})
            items, records = self._homework_doc()
            changed = False
            for row in records.values():
                if student_id in row:
                    del row[student_id]
                    changed = True
            if changed:
                self._write_doc("homework", {"items": items, "records": records})
            scores = self._scores_map()
            scored = False
            for block in scores.values():
                if block.pop(student_id, None) is not None:
                    scored = True
            if scored:
                self._write_doc("scores", {"by_exam": scores})
            return True

    # --- Batch import ------------------------------------------------------

    _ROW_ALIASES = {
        "no": ("no", "学号", "student_no"),
        "name": ("name", "姓名"),
        "gender": ("gender", "性别"),
        "tags": ("tags", "标签"),
        "note": ("note", "备注"),
    }

    @classmethod
    def _row_fields(cls, row) -> dict:
        if not isinstance(row, dict):
            raise ValueError("row must be an object")
        fields = {}
        for field, aliases in cls._ROW_ALIASES.items():
            for alias in aliases:
                if alias in row:
                    fields[field] = row[alias]
                    break
        return fields

    def import_students(self, class_id, rows) -> dict:
        """Upsert pasted roster rows by 学号, reporting what happened per row.

        One bad row does not abort the batch: it lands in ``failed`` with its
        1-based row number, and the rows around it are still imported. Rows
        without a 学号 cannot be matched, so they fail rather than creating a
        second copy of the same child on the next import.
        """
        class_id = _key(class_id, "class_id")
        if not isinstance(rows, list):
            raise ValueError("students must be a list")
        report = {"imported": 0, "updated": 0, "failed": []}
        with self._locked("classes", "students"):
            classes = self._classes()
            self._require_classes(classes, [class_id])
            students = self._students()
            by_no = {
                student["no"]: student
                for student in students
                if student["class_id"] == class_id
            }
            for index, row in enumerate(rows, 1):
                try:
                    fields = self._row_fields(row)
                    clean = _clean_student(fields)
                    for required in ("no", "name"):
                        if required not in clean:
                            raise ValueError(f"{required} is required")
                    existing = by_no.get(clean["no"])
                    if existing is None:
                        record = {
                            "id": _new_id(student["id"] for student in students),
                            "class_id": class_id,
                            "gender": "",
                            "tags": [],
                            "note": "",
                            **clean,
                        }
                        students.append(record)
                        by_no[record["no"]] = record
                        report["imported"] += 1
                    else:
                        existing.update(clean)
                        report["updated"] += 1
                except (KeyError, ValueError, TypeError) as e:
                    report["failed"].append({"row": index, "reason": str(e)})
            if report["imported"] or report["updated"]:
                self._write_doc("students", {"students": students})
        return report

    # --- Timetable ---------------------------------------------------------

    def get_timetable(self) -> dict:
        with self._locked("timetable"):
            return self._timetable_doc()

    def save_timetable(self, periods=None, slots=None, overrides=None) -> dict:
        """Replace the table; a group left out of the call is left as it was.

        PUT is not a licence to wipe a table because a client forgot a key, so
        only the groups actually supplied are replaced. A slot without an id
        gets one, and a duplicate id is reissued rather than silently aliasing
        another slot.
        """
        with self._locked("timetable", "classes"):
            doc = self._timetable_doc()
            class_ids = {entry["id"] for entry in self._classes()}
            if periods is not None:
                doc["periods"] = _clean_periods(periods)
            if slots is not None:
                doc["slots"] = _clean_slots(
                    slots, class_ids, {slot["id"] for slot in doc["slots"]})
            if overrides is not None:
                doc["overrides"] = _clean_overrides(overrides, class_ids)
            self._write_doc("timetable", doc)
            return doc

    # --- Reminder settings -------------------------------------------------

    def get_settings(self) -> dict:
        """The stored reminder settings, repaired against the process defaults."""
        with self._locked("settings"):
            return _normalize_settings(self._read_doc("settings"))

    def save_settings(self, **fields) -> dict:
        """Apply a partial settings update; unrelated groups keep their values."""
        with self._locked("settings"):
            current = _normalize_settings(self._read_doc("settings"))
            clean = _clean_settings(fields, current)
            self._write_doc("settings", clean)
            return clean

    # --- Teacher profile ---------------------------------------------------

    def get_profile(self) -> dict:
        """The stored teacher profile; every field empty until the first save."""
        with self._locked("profile"):
            return _normalize_profile(self._read_doc("profile"))

    def save_profile(self, **fields) -> dict:
        """Validate and store the profile, marking onboarding complete.

        ``onboarded`` is not a client field: reaching this method at all means
        the teacher has answered the dialog or edited the settings card, so the
        flag is derived from the save rather than trusted from the request.
        """
        with self._locked("profile"):
            current = _normalize_profile(self._read_doc("profile"))
            clean = _clean_profile(fields, current)
            profile = {**clean, "onboarded": True}
            self._write_doc("profile", profile)
            return {**profile}

    def get_daily_motto(self) -> dict:
        """Today's cached motto, if one was written: ``{date, text}``."""
        with self._locked("motto"):
            doc = self._read_doc("motto")
        raw = doc.get("motives")
        motives = [str(item) for item in raw if isinstance(item, str)] if isinstance(raw, list) else []
        return {
            "date": _text(doc.get("date")),
            "text": _text(doc.get("text")),
            "motives": motives,
        }

    def save_daily_motto(self, day: str, text: str,
                         motives: Optional[List[str]] = None) -> None:
        """Overwrite the motto cache; the first line plus its rotation."""
        payload = {"date": _text(day), "text": _text(text)}
        if motives:
            payload["motives"] = [_text(item) for item in motives][:3]
        with self._locked("motto"):
            path = self._path("motto")
            path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(path, payload, indent=2)

    # --- Today -------------------------------------------------------------

    @staticmethod
    def _minutes_of_day(value) -> Optional[int]:
        """``"08:05"`` as minutes since midnight, or None for an unusable time."""
        match = re.match(r"^(\d{1,2}):(\d{2})$", _text(value))
        if not match:
            return None
        hours, minutes = int(match.group(1)), int(match.group(2))
        if hours > 23 or minutes > 59:
            return None
        return hours * 60 + minutes

    def _day_data(self) -> dict:
        """Every document today's answer needs, read under one lock."""
        items, records = self._homework_doc()
        return {
            "classes": self._classes(),
            "students": self._students(),
            "progress": self._progress(),
            "homework": items,
            "records": records,
            "timetable": self._timetable_doc(),
        }

    @staticmethod
    def _topics_by_class(progress: List[dict]) -> Dict[str, str]:
        """The topic each class is on: its first untaught progress item.

        A plan with ``planned_periods == 0`` counts as still current rather than
        finished, so a freshly pasted syllabus item shows up in the digest
        before anyone fills in the planned hours.
        """
        grouped: Dict[str, List[dict]] = {}
        for item in progress:
            grouped.setdefault(item["class_id"], []).append(item)
        topics: Dict[str, str] = {}
        for class_id, items in grouped.items():
            items.sort(key=lambda item: (item["order"], item["updated_at"]))
            current = next(
                (item for item in items
                 if item["taught_periods"] < max(item["planned_periods"], 1)),
                None,
            )
            topics[class_id] = current["topic"] if current else ""
        return topics

    @staticmethod
    def _students_in_order(classes: List[dict], students: List[dict]) -> List[dict]:
        order = {entry["id"]: index for index, entry in enumerate(classes)}
        return sorted(
            students,
            key=lambda s: (order.get(s["class_id"], len(order)), s["no"], s["name"]),
        )

    @staticmethod
    def _homework_for_class(items: List[dict], class_id: str, day_iso: str) -> str:
        """The homework a reminder should name: today's, else the latest set."""
        candidates = [item for item in items if class_id in item["class_ids"]]
        if not candidates:
            return ""
        due_today = [item for item in candidates if item["due"] == day_iso]
        pool = sorted(
            due_today or candidates,
            key=lambda item: (item["due"] or "9999-12-31", item["created_at"]),
        )
        return pool[-1]["title"]

    def _render_lesson(self, *, period: int, class_id: str, subject: str, kind: str,
                       mine: bool, teacher: str, data: dict, periods: Dict[int, dict],
                       topics: Dict[str, str], day_iso: str) -> dict:
        klass = next((entry for entry in data["classes"]
                      if entry["id"] == class_id), {})
        hours = periods.get(period, {})
        return {
            "period": period,
            "start": hours.get("start", ""),
            "end": hours.get("end", ""),
            "class_id": class_id,
            "class_name": klass.get("name", ""),
            "subject": subject,
            "kind": kind,
            "mine": mine,
            "teacher": teacher,
            "topic": topics.get(class_id, "") if kind == "regular" else "",
            "homework": self._homework_for_class(data["homework"], class_id, day_iso),
        }

    def _lessons_for_day(self, data: dict, target: date) -> List[dict]:
        """That date's lessons with overrides applied, before the ``mine`` filter.

        An override addresses one date and one period, like the grid cell it was
        drawn in: ``cancelled`` removes whatever sat there, ``changed`` replaces
        it with the override's class/subject. Ownership comes from the replaced
        slot when the class matches; a lesson moved into another teacher's cell
        is the caller's own and therefore reminded.
        """
        timetable = data["timetable"]
        classes = {entry["id"]: entry for entry in data["classes"]}
        periods = {entry["index"]: entry for entry in timetable["periods"]}
        topics = self._topics_by_class(data["progress"])
        day_iso = target.isoformat()
        overrides: Dict[int, dict] = {}
        for override in timetable["overrides"]:
            if override["date"] == day_iso:
                overrides[override["period"]] = override
        by_period: Dict[int, List[dict]] = {}
        for slot in timetable["slots"]:
            if slot["weekday"] == target.isoweekday():
                by_period.setdefault(slot["period"], []).append(slot)

        lessons: List[dict] = []
        for period in sorted(set(by_period) | set(overrides)):
            base = by_period.get(period, [])
            override = overrides.get(period)
            if override is not None:
                if override["state"] == "cancelled":
                    continue
                match = next((slot for slot in base
                              if slot["class_id"] == override["class_id"]), None)
                class_id = override["class_id"]
                lessons.append(self._render_lesson(
                    period=period,
                    class_id=class_id,
                    subject=override["subject"] or classes.get(class_id, {}).get("subject", ""),
                    kind=override["kind"],
                    mine=match["mine"] if match else True,
                    teacher=match["teacher"] if match else "",
                    data=data, periods=periods, topics=topics, day_iso=day_iso,
                ))
                continue
            for slot in base:
                lessons.append(self._render_lesson(
                    period=slot["period"],
                    class_id=slot["class_id"],
                    subject=slot["subject"] or classes.get(slot["class_id"], {}).get("subject", ""),
                    kind=slot["kind"],
                    mine=slot["mine"],
                    teacher=slot["teacher"],
                    data=data, periods=periods, topics=topics, day_iso=day_iso,
                ))
        lessons.sort(key=lambda lesson: (lesson["period"], lesson["class_name"]))
        return lessons

    def _tasks_due(self, day_iso: str) -> List[dict]:
        """Open board tasks due that day, in the board's own display order."""
        try:
            from agent.board import BoardStore

            tasks = BoardStore(str(self.base.parent / "board.json")).load_tasks()
        except Exception as e:
            logger.warning(f"[Teaching] cannot read the task board: {e}")
            return []
        return [
            {"title": task["title"], "due": task["due"], "status": task["status"]}
            for task in tasks
            if task.get("due") == day_iso and task.get("status") != "done"
        ]

    def _homework_due(self, data: dict, day_iso: str) -> List[dict]:
        """Homework due that day with the names still marked missing."""
        students = self._students_in_order(data["classes"], data["students"])
        result = []
        items = sorted(
            data["homework"],
            key=lambda item: (item["due"] or "9999-12-31", item["created_at"]),
        )
        for item in items:
            if item["due"] != day_iso:
                continue
            row = data["records"].get(item["id"], {})
            missing: List[str] = []
            for student in students:
                if student["class_id"] not in item["class_ids"]:
                    continue
                if row.get(student["id"]) == "missing" and student["name"] not in missing:
                    missing.append(student["name"])
            result.append({"title": item["title"], "due": item["due"], "missing": missing})
        return result

    def today(self, day=None, name=None, agent_id=None) -> dict:
        """My lessons, due work and the digest text for one calendar date."""
        day_iso = _date_field(day, "date", required=False) if day else ""
        target = date.fromisoformat(day_iso) if day_iso else date.today()
        with self._locked("timetable", "classes", "students", "progress", "homework"):
            data = self._day_data()
            lessons = [lesson for lesson in self._lessons_for_day(data, target)
                       if lesson["mine"]]
            tasks_due = self._tasks_due(target.isoformat())
            homework_due = self._homework_due(data, target.isoformat())
        slots = [
            {field: lesson[field] for field in _LESSON_PUBLIC_FIELDS}
            for lesson in lessons
        ]
        missing: List[str] = []
        for entry in homework_due:
            for student in entry["missing"]:
                if student not in missing:
                    missing.append(student)
        if name is None:
            from agent.teaching.reminders import teacher_name

            name = teacher_name(agent_id)
        from agent.teaching.reminders import build_digest

        return {
            "date": target.isoformat(),
            "weekday": target.isoweekday(),
            "slots": slots,
            "tasks_due": tasks_due,
            "homework_due": homework_due,
            "digest_text": build_digest(
                name, target.isoweekday(), slots, tasks_due, missing,
            ),
        }

    def lesson_info(self, slot: dict, day=None) -> dict:
        """One timetable slot with the class name, current topic and homework."""
        day_iso = _date_field(day, "date", required=False) if day else ""
        target = date.fromisoformat(day_iso) if day_iso else date.today()
        with self._locked("timetable", "classes", "students", "progress", "homework"):
            data = self._day_data()
            periods = {entry["index"]: entry for entry in data["timetable"]["periods"]}
            topics = self._topics_by_class(data["progress"])
            class_id = slot["class_id"]
            klass = next((entry for entry in data["classes"]
                          if entry["id"] == class_id), {})
            return self._render_lesson(
                period=slot["period"],
                class_id=class_id,
                subject=slot.get("subject") or klass.get("subject", ""),
                kind=slot.get("kind", "regular"),
                mine=slot.get("mine", True),
                teacher=slot.get("teacher", ""),
                data=data, periods=periods, topics=topics,
                day_iso=target.isoformat(),
            )

    def upcoming_lesson(self, now=None) -> Optional[dict]:
        """The next ``mine`` lesson from now, looking up to a week ahead."""
        now = now or datetime.now()
        current_minute = now.hour * 60 + now.minute
        with self._locked("timetable", "classes", "students", "progress", "homework"):
            data = self._day_data()
            # 8 days: when today's remaining lessons are over, the next one may
            # be the same weekday next week.
            for offset in range(8):
                target = now.date() + timedelta(days=offset)
                lessons = [lesson for lesson in self._lessons_for_day(data, target)
                           if lesson["mine"]]
                if offset == 0:
                    # A lesson with no usable start time cannot be timed; keep
                    # it rather than silently hiding a likely-upcoming lesson.
                    lessons = [
                        lesson for lesson in lessons
                        if self._minutes_of_day(lesson["start"]) is None
                        or self._minutes_of_day(lesson["start"]) > current_minute
                    ]
                if lessons:
                    return min(
                        lessons,
                        key=lambda lesson: (
                            self._minutes_of_day(lesson["start"])
                            if self._minutes_of_day(lesson["start"]) is not None
                            else 24 * 60,
                            lesson["period"],
                        ),
                    )
        return None

    # --- Progress ----------------------------------------------------------

    def list_progress(self, class_id: Optional[str] = None) -> List[dict]:
        with self._locked("progress", "classes"):
            items = self._progress()
            if class_id is not None:
                class_id = _key(class_id, "class_id")
                self._find(self._classes(), class_id)
                items = [item for item in items if item["class_id"] == class_id]
            order = {entry["id"]: index for index, entry in enumerate(self._classes())}
            return sorted(
                items,
                key=lambda item: (order.get(item["class_id"], len(order)),
                                  item["order"], item["updated_at"]),
            )

    def create_progress(self, class_id, topic, planned_periods=0,
                        taught_periods=0, order=None) -> dict:
        class_id = _key(class_id, "class_id")
        clean = _clean_progress({
            "class_id": class_id,
            "topic": topic,
            "planned_periods": planned_periods,
            "taught_periods": taught_periods,
        })
        if order is not None:
            clean["order"] = _int_field(order, "order", minimum=0)
        with self._locked("classes", "progress"):
            self._require_classes(self._classes(), [class_id])
            items = self._progress()
            if "order" not in clean:
                clean["order"] = max(
                    (item["order"] for item in items if item["class_id"] == class_id),
                    default=0,
                ) + 1
            record = {
                "id": _new_id(item["id"] for item in items),
                **clean,
                "updated_at": _now(),
            }
            items.append(record)
            self._write_doc("progress", {"items": items})
            return record

    def update_progress(self, item_id: str, **fields) -> dict:
        item_id = _key(item_id)
        clean = _clean_progress(fields)
        if not clean:
            raise ValueError("no fields to update")
        with self._locked("classes", "progress"):
            classes = self._classes()
            items = self._progress()
            record = self._find(items, item_id)
            if "class_id" in clean:
                self._require_classes(classes, [clean["class_id"]])
            record.update(clean)
            record["updated_at"] = _now()
            self._write_doc("progress", {"items": items})
            return record

    def delete_progress(self, item_id: str) -> bool:
        item_id = _key(item_id)
        with self._locked("progress"):
            items = self._progress()
            self._find(items, item_id)
            self._write_doc("progress", {
                "items": [item for item in items if item["id"] != item_id],
            })
            return True

    # --- Homework ----------------------------------------------------------

    def list_homework(self, class_id: Optional[str] = None) -> List[dict]:
        with self._locked("homework", "classes"):
            items = self._homework_items()
            if class_id is not None:
                class_id = _key(class_id, "class_id")
                self._find(self._classes(), class_id)
                items = [item for item in items if class_id in item["class_ids"]]
            return sorted(
                items,
                key=lambda item: (item["due"] or "9999-12-31", item["created_at"]),
            )

    def all_homework_records(self) -> Dict[str, Dict[str, str]]:
        with self._locked("homework"):
            return self._homework_doc()[1]

    def get_homework_records(self, homework_id: str) -> Dict[str, str]:
        homework_id = _key(homework_id)
        with self._locked("homework"):
            items, records = self._homework_doc()
            self._find(items, homework_id)
            return records.get(homework_id, {})

    def create_homework(self, class_ids, title, kind, due) -> dict:
        clean = _clean_homework({
            "class_ids": class_ids, "title": title, "kind": kind, "due": due,
        })
        with self._locked("classes", "homework"):
            self._require_classes(self._classes(), clean["class_ids"])
            items, records = self._homework_doc()
            record = {
                "id": _new_id(item["id"] for item in items),
                **clean,
                "created_at": _now(),
            }
            items.append(record)
            self._write_doc("homework", {"items": items, "records": records})
            return record

    def update_homework(self, homework_id: str, **fields) -> dict:
        homework_id = _key(homework_id)
        clean = _clean_homework(fields)
        if not clean:
            raise ValueError("no fields to update")
        with self._locked("classes", "homework"):
            classes = self._classes()
            items, records = self._homework_doc()
            record = self._find(items, homework_id)
            if "class_ids" in clean:
                self._require_classes(classes, clean["class_ids"])
            record.update(clean)
            self._write_doc("homework", {"items": items, "records": records})
            return record

    def delete_homework(self, homework_id: str) -> bool:
        homework_id = _key(homework_id)
        with self._locked("homework"):
            items, records = self._homework_doc()
            self._find(items, homework_id)
            remaining = [item for item in items if item["id"] != homework_id]
            records.pop(homework_id, None)
            self._write_doc("homework", {"items": remaining, "records": records})
            return True

    def save_homework_records(self, homework_id: str, records) -> Dict[str, str]:
        """Replace one homework's whole state block."""
        homework_id = _key(homework_id)
        if not isinstance(records, dict):
            raise ValueError("records must be an object")
        clean: Dict[str, str] = {}
        for student_id, state in records.items():
            if not isinstance(student_id, str) or not student_id.strip():
                raise ValueError("record keys must be student ids")
            clean[student_id.strip()] = _enum(state, "state", SUBMISSION_STATES)
        with self._locked("homework", "students"):
            items, stored = self._homework_doc()
            self._find(items, homework_id)
            known = {student["id"] for student in self._students()}
            unknown = sorted(set(clean) - known)
            if unknown:
                raise KeyError(unknown[0])
            stored[homework_id] = clean
            self._write_doc("homework", {"items": items, "records": stored})
            return clean

    # --- Exams -------------------------------------------------------------

    def list_exams(self, class_id: Optional[str] = None) -> List[dict]:
        with self._locked("exams", "classes"):
            exams = self._exams()
            if class_id is not None:
                class_id = _key(class_id, "class_id")
                self._find(self._classes(), class_id)
                exams = [exam for exam in exams if class_id in exam["class_ids"]]
            return sorted(exams, key=lambda exam: (exam["date"], exam["name"]),
                          reverse=True)

    def get_exam(self, exam_id: str) -> dict:
        with self._locked("exams"):
            return self._find(self._exams(), _key(exam_id))

    def create_exam(self, name, class_ids, full_score, date, subject="",
                    items=None) -> dict:
        clean = _clean_exam({
            "name": name,
            "class_ids": class_ids,
            "full_score": full_score,
            "date": date,
            "subject": subject,
            "items": items,
        })
        with self._locked("classes", "exams"):
            self._require_classes(self._classes(), clean["class_ids"])
            exams = self._exams()
            record = {
                "id": _new_id(exam["id"] for exam in exams),
                **clean,
            }
            record.setdefault("items", [])
            exams.append(record)
            self._write_doc("exams", {"exams": exams})
            return record

    @staticmethod
    def _reconcile_scores(exam: dict, block: Dict[str, dict]) -> Dict[str, dict]:
        """Re-check an existing score block against a changed paper.

        Editing an exam after scores are in is normal (a wrong full score, a
        renamed group). Values for groups that no longer exist are dropped;
        anything that would now exceed its group or the paper raises instead of
        silently rewriting a mark.
        """
        fulls = {item["key"]: item["full"] for item in exam["items"]}
        reconciled = {}
        for student_id, record in block.items():
            if fulls:
                items = {}
                for key, full in fulls.items():
                    value = (record.get("items") or {}).get(key)
                    if value is not None and value > full:
                        raise ValueError(
                            f"existing score for {key} exceeds its new full {full:g}")
                    items[key] = value
                present = [value for value in items.values() if value is not None]
                total = round(sum(present), 2) if present else None
            else:
                items = {}
                total = record.get("total")
                if total is not None and total > exam["full_score"]:
                    raise ValueError(
                        f"existing total exceeds the new full score {exam['full_score']:g}")
            if total is not None and total > exam["full_score"]:
                raise ValueError(
                    f"existing total exceeds the new full score {exam['full_score']:g}")
            reconciled[student_id] = {"total": total, "items": items}
        return reconciled

    def update_exam(self, exam_id: str, **fields) -> dict:
        exam_id = _key(exam_id)
        clean = _clean_exam(fields)
        if not clean:
            raise ValueError("no fields to update")
        needs_scores = "items" in clean or "full_score" in clean
        with self._locked("classes", "exams", "scores"):
            classes = self._classes()
            exams = self._exams()
            exam = self._find(exams, exam_id)
            if "class_ids" in clean:
                self._require_classes(classes, clean["class_ids"])
            updated = {**exam, **clean}
            scores = self._scores_map()
            existing = scores.get(exam_id) if needs_scores else None
            if existing:
                scores[exam_id] = self._reconcile_scores(updated, existing)
            exam.update(clean)
            self._write_doc("exams", {"exams": exams})
            if existing:
                self._write_doc("scores", {"by_exam": scores})
            return exam

    def delete_exam(self, exam_id: str) -> bool:
        exam_id = _key(exam_id)
        with self._locked("exams", "scores"):
            exams = self._exams()
            self._find(exams, exam_id)
            remaining = [exam for exam in exams if exam["id"] != exam_id]
            self._write_doc("exams", {"exams": remaining})
            scores = self._scores_map()
            if exam_id in scores:
                scores.pop(exam_id)
                self._write_doc("scores", {"by_exam": scores})
            return True

    # --- Scores ------------------------------------------------------------

    def get_scores(self, exam_id: str) -> Dict[str, dict]:
        exam_id = _key(exam_id, "exam_id")
        with self._locked("exams", "scores"):
            self._find(self._exams(), exam_id)
            return self._scores_map().get(exam_id, {})

    def save_scores(self, exam_id: str, scores) -> Dict[str, dict]:
        """Replace one exam's score block, validating every mark first.

        ``scores`` maps student id to ``{"items": {key: value}}`` (or directly
        the item map). A ``null`` value means 缺考 for that group; a student
        whose values are all null, or who is left out entirely, is absent for
        the exam and excluded from the statistics. An exam without groups takes
        ``{"total": number | null}``.
        """
        exam_id = _key(exam_id, "exam_id")
        if not isinstance(scores, dict):
            raise ValueError("scores must be an object keyed by student id")
        with self._locked("classes", "exams", "students", "scores"):
            exam = self._find(self._exams(), exam_id)
            students = {student["id"]: student for student in self._students()}
            keys = [item["key"] for item in exam["items"]]
            fulls = {item["key"]: item["full"] for item in exam["items"]}
            block: Dict[str, dict] = {}
            for raw_id, payload in scores.items():
                student_id = _key(raw_id, "student_id")
                student = students.get(student_id)
                if student is None:
                    raise KeyError(student_id)
                if student["class_id"] not in exam["class_ids"]:
                    raise ValueError(
                        f"student {student_id} is not in this exam's classes")
                if keys:
                    if not isinstance(payload, dict):
                        raise ValueError(
                            f"scores for {student_id} must be an object")
                    raw_items = payload.get("items")
                    if not isinstance(raw_items, dict):
                        raw_items = payload
                    unknown = sorted(set(raw_items) - set(keys))
                    if unknown:
                        raise ValueError(
                            f"unknown item key(s) for {student_id}: "
                            f"{', '.join(unknown)}")
                    values: Dict[str, Optional[float]] = {}
                    present = []
                    for key in keys:
                        value = raw_items.get(key)
                        if value is None:
                            values[key] = None
                            continue
                        number = _number_field(value, f"score {key}", minimum=0)
                        if number > fulls[key]:
                            raise ValueError(
                                f"score for {key} must be at most {fulls[key]:g}")
                        values[key] = number
                        present.append(number)
                    total = round(sum(present), 2) if present else None
                    block[student_id] = {"total": total, "items": values}
                else:
                    if not isinstance(payload, dict):
                        raise ValueError(
                            f"scores for {student_id} must be an object")
                    raw_total = payload.get("total")
                    total = None
                    if raw_total is not None:
                        total = _number_field(raw_total, "total", minimum=0,
                                              maximum=exam["full_score"])
                    block[student_id] = {"total": total, "items": {}}
            by_exam = self._scores_map()
            by_exam[exam_id] = block
            self._write_doc("scores", {"by_exam": by_exam})
            return block

    # --- Analysis ----------------------------------------------------------

    def analysis(self, exam_id: str, class_id: Optional[str] = None) -> dict:
        from agent.teaching.analysis import analyze

        exam_id = _key(exam_id, "exam_id")
        with self._locked("classes", "students", "exams", "scores"):
            exam = self._find(self._exams(), exam_id)
            classes = self._classes()
            return analyze(
                exam,
                classes,
                self._students(),
                self._scores_map(),
                self._exams(),
                class_id=class_id,
            )
