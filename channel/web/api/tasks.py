"""The task board's endpoints: ``/api/tasks``, ``/api/tasks/update``,
``/api/tasks/delete``.

The board is per Agent and lives in that Agent's workspace, so every handler
resolves the workspace first and never takes a path from the client. Body
fields are validated by ``BoardStore``; this module only turns its refusals
into the error shape the console understands:

    {"status": "error", "code": "bad_request" | "not_found", "message": ...}
"""

import json
import os

import web

from agent.board import BoardStore, FIELDS
from channel.web.core._common import (
    _get_workspace_root,
    _request_agent_id,
    _require_auth,
)
from common.log import logger


def _store(agent_id=None) -> BoardStore:
    workspace = _get_workspace_root(agent_id=agent_id)
    return BoardStore(os.path.join(workspace, "board.json"))


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


def _body_fields(body: dict) -> dict:
    """The task fields in a request body, refusing anything else.

    A typo (``due_date`` for ``due``) would otherwise be dropped and the call
    would look like it worked. ``id``/``agent_id``/``agent`` are addressing,
    not task data, so they are allowed alongside the store's own fields.
    """
    unknown = set(body) - (set(FIELDS) | {"id", "agent_id", "agent"})
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    return {key: body[key] for key in FIELDS if key in body}


class TasksHandler:
    def GET(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            params = web.input(status='', lane='', agent_id='')
            store = _store(_request_agent_id(params))
            lane = (params.lane or '').strip()
            tasks = store.list(status=(params.status or '').strip() or None,
                               lane=lane or None)
            return _ok(tasks=tasks, board=store.board(lane=lane or None))
        except ValueError as e:
            return _fail("bad_request", str(e))
        except Exception as e:
            logger.error(f"[WebChannel] Task board list error: {e}")
            return _fail("bad_request", str(e))

    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            body = _body()
            store = _store(_request_agent_id(body))
            task = store.create(**_body_fields(body))
            return _ok(task=task)
        except (ValueError, TypeError) as e:
            return _fail("bad_request", str(e))
        except Exception as e:
            logger.error(f"[WebChannel] Task board create error: {e}")
            return _fail("bad_request", str(e))


class TaskUpdateHandler:
    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            body = _body()
            store = _store(_request_agent_id(body))
            task_id = body.get("id")
            if not isinstance(task_id, str) or not task_id.strip():
                return _fail("bad_request", "id is required")
            fields = _body_fields(body)
            task = store.update(task_id, **fields)
            return _ok(task=task)
        except KeyError as e:
            return _fail("not_found", f"task not found: {e.args[0] if e.args else ''}")
        except (ValueError, TypeError) as e:
            return _fail("bad_request", str(e))
        except Exception as e:
            logger.error(f"[WebChannel] Task board update error: {e}")
            return _fail("bad_request", str(e))


class TaskDeleteHandler:
    def POST(self):
        _require_auth()
        web.header('Content-Type', 'application/json; charset=utf-8')
        try:
            body = _body()
            store = _store(_request_agent_id(body))
            task_id = body.get("id")
            # An empty id must never reach the store: deleting "everything" is
            # exactly what a missing field would look like if it were trusted.
            if not isinstance(task_id, str) or not task_id.strip():
                return _fail("bad_request", "id is required")
            if not store.delete(task_id):
                return _fail("not_found", f"task not found: {task_id}")
            return _ok(deleted=True, id=task_id.strip())
        except (ValueError, TypeError) as e:
            return _fail("bad_request", str(e))
        except Exception as e:
            logger.error(f"[WebChannel] Task board delete error: {e}")
            return _fail("bad_request", str(e))
