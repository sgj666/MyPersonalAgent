"""Teaching endpoints under ``/api/teaching/*``.

Every handler resolves the caller's workspace first and then talks to
``TeachingStore``; no path, agent id or tenant id ever reaches the store from
the client. The store validates and raises, this module only maps those
refusals onto the console's error shape:

    {"status": "error", "code": "bad_request" | "not_found", "message": ...}

Response payloads are the documents themselves (``classes``, ``students``,
``items``, ``exams`` ...), so a client can replace its local state with the
answer instead of merging by hand.
"""

import functools
import json
import os

import web

from agent.teaching import TeachingStore
from channel.web.core._common import (
    _get_workspace_root,
    _request_agent_id,
    _require_auth,
)
from common.log import logger

_ADDRESSING = {"id", "agent_id", "agent", "session_id"}


def _store(agent_id=None) -> TeachingStore:
    workspace = _get_workspace_root(agent_id=agent_id)
    return TeachingStore(os.path.join(workspace, "teaching"))


def _json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False)


def _ok(**payload) -> str:
    return _json({"status": "success", **payload})


def _fail(code: str, message: str) -> str:
    return _json({"status": "error", "code": code, "message": message})


def _body() -> dict:
    """The JSON request body; an empty body is an empty object."""
    raw = web.data()
    if not raw:
        return {}
    body = json.loads(raw)
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    return body


def _id(body: dict) -> str:
    value = body.get("id")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("id is required")
    return value.strip()


def _payload(body: dict, allowed) -> dict:
    """The store's fields from a body, refusing anything else.

    A typo (``fullScore`` for ``full_score``) would otherwise be dropped and
    the call would look like it worked. Addressing keys are allowed alongside.
    """
    unknown = set(body) - set(allowed) - _ADDRESSING
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    return {key: body[key] for key in allowed if key in body}


def _require(fields: dict, *keys) -> None:
    """Refuse a create body that omits an essential field, by name."""
    for key in keys:
        if key not in fields:
            raise ValueError(f"{key} is required")


def _require_classes(fields: dict) -> None:
    if "class_ids" not in fields and "class_id" not in fields:
        raise ValueError("class_ids is required")


def _auto_sync(store, agent_id=None, session_id=None) -> None:
    """Re-align the scheduler's teaching tasks after a change; never fail the save."""
    try:
        from agent.teaching.reminders import auto_sync

        auto_sync(store, agent_id=agent_id, receiver=session_id or None)
    except Exception as e:
        logger.warning(f"[WebChannel] Teaching reminder sync skipped: {e}")


def _endpoint(method):
    """Authenticate, set the JSON header, map store refusals to the error shape."""
    @functools.wraps(method)
    def wrapper(self, *args):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            return method(self, *args)
        except KeyError as e:
            key = e.args[0] if e.args else ""
            return _fail("not_found", f"not found: {key}")
        except (ValueError, TypeError) as e:
            return _fail("bad_request", str(e))
        except Exception as e:
            logger.error(f"[WebChannel] Teaching {method.__name__} error: {e}")
            return _fail("bad_request", str(e))
    return wrapper


class TeachingClassesHandler:
    """GET / POST / PATCH / DELETE ``/api/teaching/classes``."""

    @_endpoint
    def GET(self):
        params = web.input(agent_id='')
        store = _store(_request_agent_id(params))
        return _ok(classes=store.list_classes())

    @_endpoint
    def POST(self):
        body = _body()
        store = _store(_request_agent_id(body))
        fields = _payload(body, ("name", "grade", "subject", "room"))
        _require(fields, "name")
        # "class" is a reserved word in Python but the natural JSON key.
        return _json({"status": "success", "class": store.create_class(**fields)})

    @_endpoint
    def PATCH(self):
        body = _body()
        store = _store(_request_agent_id(body))
        class_id = _id(body)
        fields = _payload(body, ("name", "grade", "subject", "room"))
        return _json({"status": "success", "class": store.update_class(class_id, **fields)})

    @_endpoint
    def DELETE(self):
        body = _body()
        store = _store(_request_agent_id(body))
        class_id = _id(body)
        result = store.delete_class(class_id)
        return _ok(deleted=True, class_id=class_id, removed=result["removed"])


class TeachingStudentsHandler:
    """GET / POST ``/api/teaching/students``.

    POST takes one student (``class_id`` + name/学号 fields) or a batch:
    ``{"class_id": ..., "students": [...]}``. Batch rows may use the console's
    pasted headers (姓名/学号/性别/标签/备注) or the store's field names, and are
    upserted by 学号: an existing 学号 is updated, everything else imported.
    """

    @_endpoint
    def GET(self):
        params = web.input(class_id='', agent_id='')
        store = _store(_request_agent_id(params))
        class_id = (params.class_id or '').strip() or None
        return _ok(students=store.list_students(class_id=class_id))

    @_endpoint
    def POST(self):
        body = _body()
        store = _store(_request_agent_id(body))
        rows = body.get("students")
        if rows is None:
            fields = _payload(
                body, ("class_id", "no", "name", "gender", "tags", "note"))
            rows = [fields]
        elif isinstance(rows, list):
            extra = set(body) - {"class_id", "students"} - _ADDRESSING
            if extra:
                raise ValueError(f"unknown field(s): {', '.join(sorted(extra))}")
        else:
            raise ValueError("students must be a list")
        report = store.import_students(body.get("class_id"), rows)
        return _ok(**report)


class TeachingStudentHandler:
    """PATCH / DELETE ``/api/teaching/students/<id>``."""

    @_endpoint
    def PATCH(self, student_id):
        body = _body()
        store = _store(_request_agent_id(body))
        fields = _payload(body, ("class_id", "no", "name", "gender", "tags", "note"))
        return _ok(student=store.update_student(student_id, **fields))

    @_endpoint
    def DELETE(self, student_id):
        body = _body()
        store = _store(_request_agent_id(body))
        store.delete_student(student_id)
        return _ok(deleted=True, id=student_id)


class TeachingTimetableHandler:
    """GET / PUT ``/api/teaching/timetable`` (the whole table)."""

    @_endpoint
    def GET(self):
        params = web.input(agent_id='')
        store = _store(_request_agent_id(params))
        return _ok(**store.get_timetable())

    @_endpoint
    def PUT(self):
        body = _body()
        agent_id = _request_agent_id(body)
        store = _store(agent_id)
        fields = _payload(body, ("periods", "slots", "overrides"))
        saved = store.save_timetable(**fields)
        _auto_sync(store, agent_id, body.get("session_id"))
        return _ok(**saved)


class TeachingProgressHandler:
    """GET / POST / PATCH / DELETE ``/api/teaching/progress``."""

    @_endpoint
    def GET(self):
        params = web.input(class_id='', agent_id='')
        store = _store(_request_agent_id(params))
        class_id = (params.class_id or '').strip() or None
        return _ok(items=store.list_progress(class_id=class_id))

    @_endpoint
    def POST(self):
        body = _body()
        store = _store(_request_agent_id(body))
        fields = _payload(
            body, ("class_id", "topic", "planned_periods", "taught_periods", "order"))
        _require(fields, "class_id", "topic")
        return _ok(item=store.create_progress(**fields))

    @_endpoint
    def PATCH(self):
        body = _body()
        store = _store(_request_agent_id(body))
        item_id = _id(body)
        fields = _payload(
            body, ("class_id", "topic", "planned_periods", "taught_periods", "order"))
        return _ok(item=store.update_progress(item_id, **fields))

    @_endpoint
    def DELETE(self):
        body = _body()
        store = _store(_request_agent_id(body))
        item_id = _id(body)
        store.delete_progress(item_id)
        return _ok(deleted=True, id=item_id)


class TeachingHomeworkHandler:
    """GET / POST / PATCH / DELETE ``/api/teaching/homework``."""

    @_endpoint
    def GET(self):
        params = web.input(class_id='', agent_id='')
        store = _store(_request_agent_id(params))
        class_id = (params.class_id or '').strip() or None
        return _ok(items=store.list_homework(class_id=class_id),
                   records=store.all_homework_records())

    @_endpoint
    def POST(self):
        body = _body()
        store = _store(_request_agent_id(body))
        fields = _payload(body, ("class_ids", "class_id", "title", "kind", "due"))
        _require_classes(fields)
        _require(fields, "title", "kind", "due")
        return _ok(item=store.create_homework(**fields))

    @_endpoint
    def PATCH(self):
        body = _body()
        store = _store(_request_agent_id(body))
        homework_id = _id(body)
        fields = _payload(body, ("class_ids", "class_id", "title", "kind", "due"))
        return _ok(item=store.update_homework(homework_id, **fields))

    @_endpoint
    def DELETE(self):
        body = _body()
        store = _store(_request_agent_id(body))
        homework_id = _id(body)
        store.delete_homework(homework_id)
        return _ok(deleted=True, id=homework_id)


class TeachingHomeworkRecordsHandler:
    """PUT ``/api/teaching/homework/<id>/records`` -- the whole state block."""

    @_endpoint
    def PUT(self, homework_id):
        body = _body()
        store = _store(_request_agent_id(body))
        records = body.get("records")
        if records is None:
            records = {key: value for key, value in body.items()
                       if key not in _ADDRESSING}
        return _ok(homework_id=homework_id,
                   records=store.save_homework_records(homework_id, records))


class TeachingExamsHandler:
    """GET / POST / PATCH / DELETE ``/api/teaching/exams``."""

    @_endpoint
    def GET(self):
        params = web.input(class_id='', agent_id='')
        store = _store(_request_agent_id(params))
        class_id = (params.class_id or '').strip() or None
        return _ok(exams=store.list_exams(class_id=class_id))

    @_endpoint
    def POST(self):
        body = _body()
        store = _store(_request_agent_id(body))
        fields = _payload(
            body, ("name", "class_ids", "class_id", "subject", "full_score", "date", "items"))
        _require_classes(fields)
        _require(fields, "name", "full_score", "date")
        return _ok(exam=store.create_exam(**fields))

    @_endpoint
    def PATCH(self):
        body = _body()
        store = _store(_request_agent_id(body))
        exam_id = _id(body)
        fields = _payload(
            body, ("name", "class_ids", "class_id", "subject", "full_score", "date", "items"))
        return _ok(exam=store.update_exam(exam_id, **fields))

    @_endpoint
    def DELETE(self):
        body = _body()
        store = _store(_request_agent_id(body))
        exam_id = _id(body)
        store.delete_exam(exam_id)
        return _ok(deleted=True, id=exam_id)


class TeachingScoresHandler:
    """GET / PUT ``/api/teaching/scores/<exam_id>``.

    GET exists beside the PUT so the entry grid can reopen a paper it saved:
    the analysis report has totals, not the per-item marks a re-submit would
    otherwise overwrite with nulls.
    """

    @_endpoint
    def GET(self, exam_id):
        params = web.input(agent_id='')
        store = _store(_request_agent_id(params))
        return _ok(exam_id=exam_id, scores=store.get_scores(exam_id))

    @_endpoint
    def PUT(self, exam_id):
        body = _body()
        store = _store(_request_agent_id(body))
        scores = body.get("scores")
        if scores is None:
            scores = {key: value for key, value in body.items()
                      if key not in _ADDRESSING}
        return _ok(exam_id=exam_id, scores=store.save_scores(exam_id, scores))


class TeachingAnalysisHandler:
    """GET ``/api/teaching/analysis?exam_id=&class_id=``."""

    @_endpoint
    def GET(self):
        params = web.input(exam_id='', class_id='', agent_id='')
        store = _store(_request_agent_id(params))
        exam_id = (params.exam_id or '').strip()
        if not exam_id:
            raise ValueError("exam_id is required")
        class_id = (params.class_id or '').strip() or None
        return _ok(**store.analysis(exam_id, class_id=class_id))


class TeachingTodayHandler:
    """GET ``/api/teaching/today?date=YYYY-MM-DD``."""

    @_endpoint
    def GET(self):
        params = web.input(date='', agent_id='')
        agent_id = _request_agent_id(params)
        store = _store(agent_id)
        day = (params.date or '').strip() or None
        return _ok(**store.today(day, agent_id=agent_id))


class TeachingSettingsHandler:
    """GET / PUT ``/api/teaching/settings``.

    PUT accepts the settings object either flattened (the file's own shape) or
    under a ``settings`` key; a group that is omitted keeps its stored value.
    """

    @_endpoint
    def GET(self):
        params = web.input(agent_id='')
        store = _store(_request_agent_id(params))
        return _ok(**store.get_settings())

    @_endpoint
    def PUT(self):
        body = _body()
        agent_id = _request_agent_id(body)
        store = _store(agent_id)
        raw = body.get("settings")
        if raw is None:
            raw = {key: value for key, value in body.items()
                   if key not in _ADDRESSING}
        if not isinstance(raw, dict):
            raise ValueError("settings must be an object")
        saved = store.save_settings(**raw)
        _auto_sync(store, agent_id, body.get("session_id"))
        return _ok(**saved)


class TeachingRemindersSyncHandler:
    """POST ``/api/teaching/reminders/sync`` -- rebuild the ``[teaching]`` tasks."""

    @_endpoint
    def POST(self):
        body = _body()
        extra = set(body) - _ADDRESSING - {"receiver"}
        if extra:
            raise ValueError(f"unknown field(s): {', '.join(sorted(extra))}")
        agent_id = _request_agent_id(body)
        store = _store(agent_id)
        receiver = body.get("session_id") or body.get("receiver") or None
        from agent.teaching.reminders import sync

        return _ok(**sync(store, agent_id=agent_id, receiver=receiver))


class TeachingRemindersPreviewHandler:
    """GET ``/api/teaching/reminders/preview`` -- digest and next lesson text."""

    @_endpoint
    def GET(self):
        params = web.input(agent_id='')
        agent_id = _request_agent_id(params)
        store = _store(agent_id)
        from agent.teaching.reminders import preview

        return _ok(**preview(store, agent_id=agent_id))


#: Splice into ``URLS``; the coordinator owns that wiring.
TEACHING_URLS = (
    ('/api/teaching/classes', 'TeachingClassesHandler'),
    ('/api/teaching/students', 'TeachingStudentsHandler'),
    ('/api/teaching/students/([^/]+)', 'TeachingStudentHandler'),
    ('/api/teaching/timetable', 'TeachingTimetableHandler'),
    ('/api/teaching/progress', 'TeachingProgressHandler'),
    ('/api/teaching/homework', 'TeachingHomeworkHandler'),
    ('/api/teaching/homework/([^/]+)/records', 'TeachingHomeworkRecordsHandler'),
    ('/api/teaching/exams', 'TeachingExamsHandler'),
    ('/api/teaching/scores/([^/]+)', 'TeachingScoresHandler'),
    ('/api/teaching/analysis', 'TeachingAnalysisHandler'),
    ('/api/teaching/today', 'TeachingTodayHandler'),
    ('/api/teaching/settings', 'TeachingSettingsHandler'),
    ('/api/teaching/reminders/sync', 'TeachingRemindersSyncHandler'),
    ('/api/teaching/reminders/preview', 'TeachingRemindersPreviewHandler'),
)

__all__ = [
    "TeachingAnalysisHandler",
    "TeachingClassesHandler",
    "TeachingExamsHandler",
    "TeachingHomeworkHandler",
    "TeachingHomeworkRecordsHandler",
    "TeachingProgressHandler",
    "TeachingRemindersPreviewHandler",
    "TeachingRemindersSyncHandler",
    "TeachingScoresHandler",
    "TeachingSettingsHandler",
    "TeachingStudentHandler",
    "TeachingStudentsHandler",
    "TeachingTimetableHandler",
    "TeachingTodayHandler",
    "TEACHING_URLS",
]
