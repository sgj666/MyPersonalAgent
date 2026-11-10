"""Web endpoints for the task board: /api/tasks, /update, /delete."""

import json
from types import SimpleNamespace
from unittest.mock import patch

from agent.board import BoardStore
from channel.web.api import tasks as tasks_api


def _get(tmp_path, **params):
    defaults = {"status": "", "lane": "", "agent_id": ""}
    defaults.update(params)
    with patch.object(tasks_api, "_require_auth"), \
         patch.object(tasks_api.web, "header"), \
         patch.object(tasks_api.web, "input", return_value=SimpleNamespace(**defaults)), \
         patch.object(tasks_api, "_get_workspace_root", return_value=str(tmp_path)):
        return json.loads(tasks_api.TasksHandler().GET())


def _post(handler, tmp_path, payload):
    with patch.object(tasks_api, "_require_auth"), \
         patch.object(tasks_api.web, "header"), \
         patch.object(tasks_api.web, "data",
                      return_value=json.dumps(payload, ensure_ascii=False).encode("utf-8")), \
         patch.object(tasks_api, "_get_workspace_root", return_value=str(tmp_path)):
        return json.loads(handler().POST())


def _seed(tmp_path, **fields):
    return BoardStore(tmp_path / "board.json").create(**fields)


def test_get_returns_tasks_and_four_column_board(tmp_path):
    _seed(tmp_path, title="备课", lane="英语", due="2026-12-01")
    _seed(tmp_path, title="批改", status="doing")

    response = _get(tmp_path)

    assert response["status"] == "success"
    assert [t["title"] for t in response["tasks"]] == ["备课", "批改"]
    board = response["board"]
    assert [c["status"] for c in board["columns"]] == ["todo", "doing", "blocked", "done"]
    assert board["counts"] == {"todo": 1, "doing": 1, "blocked": 0, "done": 0}
    assert board["total"] == 2


def test_get_filters_by_status_and_lane(tmp_path):
    _seed(tmp_path, title="a", lane="英语")
    _seed(tmp_path, title="b", lane="数学", status="doing")

    by_lane = _get(tmp_path, lane="数学")
    assert [t["title"] for t in by_lane["tasks"]] == ["b"]
    assert by_lane["board"]["total"] == 1

    by_status = _get(tmp_path, status="todo")
    assert [t["title"] for t in by_status["tasks"]] == ["a"]


def test_get_rejects_invalid_status_filter(tmp_path):
    response = _get(tmp_path, status="waiting")

    assert response["status"] == "error"
    assert response["code"] == "bad_request"


def test_post_creates_task(tmp_path):
    response = _post(tasks_api.TasksHandler, tmp_path, {
        "title": "  试卷分析 ", "lane": "英语", "due": "2026-12-05", "priority": "high",
        "source": {"type": "doc", "ref": "unit3.md"},
    })

    assert response["status"] == "success"
    task = response["task"]
    assert task["title"] == "试卷分析"
    assert task["priority"] == "high"
    assert BoardStore(tmp_path / "board.json").get(task["id"])["source"]["type"] == "doc"


def test_post_rejects_invalid_or_missing_fields(tmp_path):
    missing = _post(tasks_api.TasksHandler, tmp_path, {})
    assert missing["status"] == "error"
    assert missing["code"] == "bad_request"

    bad_due = _post(tasks_api.TasksHandler, tmp_path, {"title": "x", "due": "2026-02-30"})
    assert bad_due["code"] == "bad_request"

    bad_field = _post(tasks_api.TasksHandler, tmp_path, {"title": "x", "colour": "red"})
    assert bad_field["code"] == "bad_request"
    assert not (tmp_path / "board.json").exists()


def test_update_moves_status_and_errors_are_typed(tmp_path):
    task = _seed(tmp_path, title="家长沟通")

    moved = _post(tasks_api.TaskUpdateHandler, tmp_path,
                  {"id": task["id"], "status": "done"})
    assert moved["status"] == "success"
    assert moved["task"]["done_at"]

    missing_id = _post(tasks_api.TaskUpdateHandler, tmp_path, {"status": "doing"})
    assert missing_id["code"] == "bad_request"

    unknown = _post(tasks_api.TaskUpdateHandler, tmp_path,
                    {"id": "deadbeef0000", "status": "doing"})
    assert unknown["status"] == "error"
    assert unknown["code"] == "not_found"

    rejected = _post(tasks_api.TaskUpdateHandler, tmp_path, {"id": task["id"], "due": "x"})
    assert rejected["code"] == "bad_request"
    assert BoardStore(tmp_path / "board.json").get(task["id"])["status"] == "done"


def test_delete_empty_id_never_clears_the_board(tmp_path):
    first = _seed(tmp_path, title="a")
    second = _seed(tmp_path, title="b")

    assert _post(tasks_api.TaskDeleteHandler, tmp_path, {})["code"] == "bad_request"
    assert _post(tasks_api.TaskDeleteHandler, tmp_path, {"id": ""})["code"] == "bad_request"
    assert _post(tasks_api.TaskDeleteHandler, tmp_path, {"id": None})["code"] == "bad_request"

    store = BoardStore(tmp_path / "board.json")
    assert sorted(t["id"] for t in store.load_tasks()) == sorted([first["id"], second["id"]])

    unknown = _post(tasks_api.TaskDeleteHandler, tmp_path, {"id": "deadbeef0000"})
    assert unknown["code"] == "not_found"
    assert store.board()["total"] == 2

    deleted = _post(tasks_api.TaskDeleteHandler, tmp_path, {"id": first["id"]})
    assert deleted == {"status": "success", "deleted": True, "id": first["id"]}
    assert [t["id"] for t in store.load_tasks()] == [second["id"]]
