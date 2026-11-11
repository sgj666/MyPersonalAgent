"""Storage for the teacher task board.

One JSON document per Agent at ``<agent workspace>/board.json``:

    {"version": 1, "tasks": [ ... ]}

The same rules as the scheduler store apply: one lock per resolved path, and
the file is replaced atomically, so a reader never sees a half-written board
and two writers never lose each other's tasks. Unlike the scheduler store the
payload is a list, because the board is ordered by explicit rules rather than
by id lookups.

Validation happens before anything is written: a rejected create or update
leaves the file byte-identical, and the caller gets a ``ValueError`` saying
which field it refused.
"""

from __future__ import annotations

import json
import os
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from common.atomic_write import write_json_atomic

BOARD_VERSION = 1

STATUSES = ("todo", "doing", "blocked", "done")
STATUS_LABELS = {
    "todo": "待办",
    "doing": "进行中",
    "blocked": "受阻",
    "done": "已完成",
}
# The four quadrants, in display order. The codes are the contract the clients
# sort and colour by, not labels: labels belong to each client's i18n.
PRIORITIES = ("urgent_important", "important", "urgent", "neither")
PRIORITY_ORDER = {code: index for index, code in enumerate(PRIORITIES)}
# Boards written before the quadrants used a three-step scale. Reading maps it
# forward so old files keep their intent without a migration pass.
LEGACY_PRIORITIES = {
    "high": "urgent_important",
    "normal": "important",
    "low": "neither",
}
DEFAULT_PRIORITY = "important"
SOURCE_TYPES = ("manual", "chat", "doc")

MAX_TITLE = 120
MAX_NOTE = 2000
MAX_LANE = 40
MAX_CATEGORY = 20

# Fields a caller may set. ``id``, the timestamps and ``done_at`` are derived
# here: accepting them would let a caller forge the ordering the board relies
# on.
FIELDS = ("title", "note", "status", "lane", "due", "due_time", "category", "priority", "source")

SORT_MODES = ("due", "priority", "created")

_DUE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^\d{2}:\d{2}$")

_locks_guard = threading.Lock()
_locks: Dict[str, threading.RLock] = {}


def board_file() -> Path:
    """The current Agent's board, resolved at call time.

    Resolved per call rather than per store or at import: one process serves
    several Agents, and the ambient identity is what decides which workspace a
    tool call or request belongs to.
    """
    from common.state_dir import state_root

    return state_root() / "board.json"


def _lock_for_path(path: str) -> threading.RLock:
    key = os.path.normcase(os.path.realpath(path))
    with _locks_guard:
        return _locks.setdefault(key, threading.RLock())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_title(value) -> str:
    if not isinstance(value, str):
        raise ValueError("title must be a string")
    # Whitespace collapsed: a pasted multi-line heading is one title, and the
    # length limit then counts what the board actually renders.
    title = " ".join(value.split())
    if not title:
        raise ValueError("title is required")
    if len(title) > MAX_TITLE:
        raise ValueError(f"title must be at most {MAX_TITLE} characters")
    return title


def _clean_note(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("note must be a string")
    note = value.strip()
    if len(note) > MAX_NOTE:
        raise ValueError(f"note must be at most {MAX_NOTE} characters")
    return note


def _clean_lane(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("lane must be a string")
    lane = value.strip()
    if len(lane) > MAX_LANE:
        raise ValueError(f"lane must be at most {MAX_LANE} characters")
    return lane


def _clean_status(value) -> str:
    if value not in STATUSES:
        raise ValueError(f"invalid status: {value!r}")
    return value


def _clean_due(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("due must be a string")
    due = value.strip()
    if not due:
        return ""
    if not _DUE_RE.match(due):
        raise ValueError("due must be YYYY-MM-DD")
    try:
        datetime.strptime(due, "%Y-%m-%d")
    except ValueError:
        raise ValueError(f"due is not a real date: {due}") from None
    return due


def _clean_due_time(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("due_time must be a string")
    due_time = value.strip()
    if not due_time:
        return ""
    if not _TIME_RE.match(due_time):
        raise ValueError("due_time must be HH:MM")
    hour, minute = (int(part) for part in due_time.split(":"))
    if hour > 23 or minute > 59:
        raise ValueError(f"due_time is not a real time: {due_time}")
    return due_time


def _clean_category(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("category must be a string")
    category = value.strip()
    if len(category) > MAX_CATEGORY:
        raise ValueError(f"category must be at most {MAX_CATEGORY} characters")
    return category


def _normalize_priority(value) -> str:
    """Read side: legacy codes map forward, anything unknown is the default."""
    if not isinstance(value, str):
        return DEFAULT_PRIORITY
    if value in PRIORITY_ORDER:
        return value
    return LEGACY_PRIORITIES.get(value, DEFAULT_PRIORITY)


def _clean_priority(value) -> str:
    """Write side: new codes and legacy codes are both accepted, normalized."""
    if not isinstance(value, str) or (value not in PRIORITY_ORDER and value not in LEGACY_PRIORITIES):
        raise ValueError(f"invalid priority: {value!r}")
    return _normalize_priority(value)


def _clean_source(value) -> dict:
    if value is None:
        return {"type": "manual", "ref": ""}
    if not isinstance(value, dict):
        raise ValueError("source must be an object")
    source_type = value.get("type") or "manual"
    if source_type not in SOURCE_TYPES:
        raise ValueError(f"invalid source type: {source_type!r}")
    ref = value.get("ref") or ""
    if not isinstance(ref, str):
        raise ValueError("source.ref must be a string")
    return {"type": source_type, "ref": ref.strip()}


def _clean_sort_mode(value) -> str:
    mode = (value or "due").strip() if isinstance(value, str) else "due"
    if mode not in SORT_MODES:
        raise ValueError(f"invalid sort: {value!r}")
    return mode


def _sort_tasks(tasks: List[dict], mode: str = "due") -> List[dict]:
    """Display order.

    ``due``: nearest deadline first, undated last.
    ``priority``: quadrant 0..3, then the same due order inside each.
    ``created``: newest first.
    """
    ordered = sorted(tasks, key=lambda t: t.get("created_at") or "", reverse=True)
    if mode == "created":
        return ordered
    if mode == "priority":
        ordered.sort(key=lambda t: (
            PRIORITY_ORDER.get(t.get("priority"), PRIORITY_ORDER[DEFAULT_PRIORITY]),
            not t.get("due"),
            t.get("due") or "",
        ))
        return ordered
    ordered.sort(key=lambda t: (not t.get("due"), t.get("due") or ""))
    return ordered


def _normalize_stored(raw) -> Optional[dict]:
    """Coerce one stored task, tolerating hand edits.

    A board that a person or an older build wrote is still their work, so an
    unknown status degrades to ``todo`` instead of dropping the row. Only an
    entry with no usable id or title is skipped: it has nothing to show.
    """
    if not isinstance(raw, dict):
        return None
    task_id = raw.get("id")
    if not isinstance(task_id, str) or not task_id.strip():
        return None
    title = raw.get("title")
    if not isinstance(title, str) or not title.strip():
        return None

    status = raw.get("status")
    if status not in STATUSES:
        status = "todo"
    priority = _normalize_priority(raw.get("priority"))
    due = raw.get("due")
    if not isinstance(due, str) or not _DUE_RE.match(due.strip()):
        due = ""
    else:
        due = due.strip()
        try:
            datetime.strptime(due, "%Y-%m-%d")
        except ValueError:
            due = ""
    due_time = raw.get("due_time")
    if not isinstance(due_time, str) or not due:
        due_time = ""
    else:
        due_time = due_time.strip()
        if not _TIME_RE.match(due_time) or int(due_time[:2]) > 23 or int(due_time[3:]) > 59:
            due_time = ""
    category = raw.get("category")
    note = raw.get("note")
    lane = raw.get("lane")
    source = raw.get("source")
    if not isinstance(source, dict):
        source = {"type": "manual", "ref": ""}
    else:
        source = {
            "type": source.get("type") if source.get("type") in SOURCE_TYPES else "manual",
            "ref": source.get("ref") if isinstance(source.get("ref"), str) else "",
        }
    created_at = raw.get("created_at")
    updated_at = raw.get("updated_at")
    done_at = raw.get("done_at")

    return {
        "id": task_id.strip(),
        "title": " ".join(title.split())[:MAX_TITLE],
        "note": note.strip()[:MAX_NOTE] if isinstance(note, str) else "",
        "status": status,
        "lane": lane.strip()[:MAX_LANE] if isinstance(lane, str) else "",
        "due": due,
        "due_time": due_time,
        "category": category.strip()[:MAX_CATEGORY] if isinstance(category, str) else "",
        "priority": priority,
        "source": source if isinstance(source, dict) else {"type": "manual", "ref": ""},
        "created_at": created_at if isinstance(created_at, str) else "",
        "updated_at": updated_at if isinstance(updated_at, str) else "",
        "done_at": done_at if status == "done" and isinstance(done_at, str) else "",
    }


class BoardStore:
    """CRUD over one Agent's ``board.json``.

    ``path=None`` means the current Agent's board, resolved on every call: a
    store can be built once by a long-lived tool and still write to the right
    workspace on each invocation.
    """

    def __init__(self, path=None):
        self._explicit_path = os.fspath(path) if path else None

    @property
    def path(self) -> str:
        return self._explicit_path or str(board_file())

    def _lock(self) -> threading.RLock:
        return _lock_for_path(self.path)

    def _load(self) -> List[dict]:
        path = self.path
        if not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            # An unreadable board reads as empty rather than raising: the view
            # must open, and the next write repairs the file.
            return []
        if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
            return []
        tasks = []
        for raw in data["tasks"]:
            task = _normalize_stored(raw)
            if task is not None:
                tasks.append(task)
        return tasks

    def _save(self, tasks: List[dict]) -> None:
        path = self.path
        directory = os.path.dirname(path) or "."
        os.makedirs(directory, exist_ok=True)
        write_json_atomic(path, {"version": BOARD_VERSION, "tasks": tasks}, indent=2)

    @staticmethod
    def _validate_updates(fields: dict) -> dict:
        """Every field validated before any of them is applied."""
        unknown = set(fields) - set(FIELDS)
        if unknown:
            raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
        clean = {}
        if "title" in fields:
            clean["title"] = _clean_title(fields["title"])
        if "note" in fields:
            clean["note"] = _clean_note(fields["note"])
        if "status" in fields:
            clean["status"] = _clean_status(fields["status"])
        if "lane" in fields:
            clean["lane"] = _clean_lane(fields["lane"])
        if "due" in fields:
            clean["due"] = _clean_due(fields["due"])
        if "due_time" in fields:
            clean["due_time"] = _clean_due_time(fields["due_time"])
        if "category" in fields:
            clean["category"] = _clean_category(fields["category"])
        if "priority" in fields:
            clean["priority"] = _clean_priority(fields["priority"])
        if "source" in fields:
            clean["source"] = _clean_source(fields["source"])
        if "due" in clean and not clean["due"] and clean.get("due_time"):
            raise ValueError("due_time requires a due date")
        return clean

    def load_tasks(self) -> List[dict]:
        """All tasks, unsorted except for the board's display order."""
        with self._lock():
            return _sort_tasks(self._load())

    def get(self, task_id: str) -> Optional[dict]:
        if not isinstance(task_id, str) or not task_id.strip():
            return None
        task_id = task_id.strip()
        with self._lock():
            for task in self._load():
                if task["id"] == task_id:
                    return task
        return None

    def list(self, status: Optional[str] = None, lane: Optional[str] = None,
             mode: str = "due") -> List[dict]:
        if status:
            status = _clean_status(status)
        mode = _clean_sort_mode(mode)
        lane = lane.strip() if isinstance(lane, str) else ""
        with self._lock():
            tasks = self._load()
        if status:
            tasks = [t for t in tasks if t["status"] == status]
        if lane:
            tasks = [t for t in tasks if t["lane"] == lane]
        return _sort_tasks(tasks, mode)

    def board(self, lane: Optional[str] = None, mode: str = "due") -> dict:
        """The four columns in fixed status order, plus counts and total.

        Empty columns are returned: the view draws a place to drop a task into,
        and a missing column would read as a missing status.
        """
        tasks = self.list(lane=lane, mode=mode)
        columns = []
        counts = {}
        for status in STATUSES:
            column_tasks = [t for t in tasks if t["status"] == status]
            counts[status] = len(column_tasks)
            columns.append({
                "status": status,
                "label": STATUS_LABELS[status],
                "tasks": column_tasks,
            })
        return {"columns": columns, "counts": counts, "total": len(tasks)}

    def create(self, **fields) -> dict:
        clean = self._validate_updates(fields)
        if not clean.get("title"):
            raise ValueError("title is required")
        if clean.get("due_time") and not clean.get("due"):
            raise ValueError("due_time requires a due date")
        now = _now()
        with self._lock():
            tasks = self._load()
            taken = {t["id"] for t in tasks}
            task_id = uuid.uuid4().hex[:12]
            while task_id in taken:
                task_id = uuid.uuid4().hex[:12]
            status = clean.get("status", "todo")
            task = {
                "id": task_id,
                "title": clean["title"],
                "note": clean.get("note", ""),
                "status": status,
                "lane": clean.get("lane", ""),
                "due": clean.get("due", ""),
                "due_time": clean.get("due_time", ""),
                "category": clean.get("category", ""),
                "priority": clean.get("priority", DEFAULT_PRIORITY),
                "source": clean.get("source", {"type": "manual", "ref": ""}),
                "created_at": now,
                "updated_at": now,
                "done_at": now if status == "done" else "",
            }
            tasks.append(task)
            self._save(tasks)
            return task

    def update(self, task_id: str, **fields) -> dict:
        if not isinstance(task_id, str) or not task_id.strip():
            raise KeyError("task id is required")
        task_id = task_id.strip()
        clean = self._validate_updates(fields)
        with self._lock():
            tasks = self._load()
            task = next((t for t in tasks if t["id"] == task_id), None)
            if task is None:
                raise KeyError(task_id)
            effective_due = clean["due"] if "due" in clean else task.get("due", "")
            effective_time = clean["due_time"] if "due_time" in clean else task.get("due_time", "")
            clearing_due = "due" in clean and not clean["due"]
            if effective_time and not effective_due and not clearing_due:
                raise ValueError("due_time requires a due date")
            now = _now()
            task.update(clean)
            if clearing_due:
                # A time without a date would be unreachable, so dropping the
                # date drops the time with it.
                task["due_time"] = ""
            if "status" in clean:
                if clean["status"] == "done":
                    # Keep the moment it was first completed while other fields
                    # are edited on a finished task.
                    task["done_at"] = task.get("done_at") or now
                else:
                    task["done_at"] = ""
            task["updated_at"] = now
            self._save(tasks)
            return task

    def delete(self, task_id: str) -> bool:
        """Remove one task. An empty id is refused: it would match everything."""
        if not isinstance(task_id, str) or not task_id.strip():
            return False
        task_id = task_id.strip()
        with self._lock():
            tasks = self._load()
            remaining = [t for t in tasks if t["id"] != task_id]
            if len(remaining) == len(tasks):
                return False
            self._save(remaining)
            return True
