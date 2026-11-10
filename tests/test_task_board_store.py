"""BoardStore: the task board's file contract."""

import json
import re

import pytest

from agent.board import BoardStore


def _store(tmp_path, name="board.json"):
    return BoardStore(tmp_path / name)


def test_per_path_isolation(tmp_path):
    one = BoardStore(tmp_path / "a" / "board.json")
    two = BoardStore(tmp_path / "b" / "board.json")

    task = one.create(title="备课")

    assert [t["id"] for t in one.load_tasks()] == [task["id"]]
    assert two.load_tasks() == []
    assert two.get(task["id"]) is None
    assert two.board()["total"] == 0


def test_missing_file_reads_as_empty(tmp_path):
    store = _store(tmp_path)
    assert store.load_tasks() == []
    # A read must not create the file: only a write does.
    assert not (tmp_path / "board.json").exists()


@pytest.mark.parametrize("payload", [
    "not json at all",
    '["a list"]',
    '{"version": 1, "tasks": "nope"}',
    '{"version": 1}',
])
def test_corrupt_file_reads_as_empty(tmp_path, payload):
    (tmp_path / "board.json").write_text(payload, encoding="utf-8")
    store = _store(tmp_path)

    assert store.load_tasks() == []
    assert store.list() == []
    assert store.board() == {
        "columns": [
            {"status": "todo", "label": "待办", "tasks": []},
            {"status": "doing", "label": "进行中", "tasks": []},
            {"status": "blocked", "label": "受阻", "tasks": []},
            {"status": "done", "label": "已完成", "tasks": []},
        ],
        "counts": {"todo": 0, "doing": 0, "blocked": 0, "done": 0},
        "total": 0,
    }


def test_create_normalizes_fields_and_writes_versioned_document(tmp_path):
    store = _store(tmp_path)
    task = store.create(
        title="  备 课 \n 三单元  ",
        note="第一行\n第二行",
        lane=" 英语 ",
        due="2026-12-01",
        priority="high",
        source={"type": "chat", "ref": "sess-1"},
    )

    assert re.fullmatch(r"[0-9a-f]{12}", task["id"])
    assert task["title"] == "备 课 三单元"
    assert task["note"] == "第一行\n第二行"
    assert task["status"] == "todo"
    assert task["lane"] == "英语"
    assert task["due"] == "2026-12-01"
    assert task["priority"] == "high"
    assert task["source"] == {"type": "chat", "ref": "sess-1"}
    assert task["created_at"] and task["updated_at"]
    assert task["done_at"] == ""

    data = json.loads((tmp_path / "board.json").read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert [t["id"] for t in data["tasks"]] == [task["id"]]


def test_create_rejects_invalid_fields(tmp_path):
    store = _store(tmp_path)

    with pytest.raises(ValueError):
        store.create(title="   ")
    with pytest.raises(ValueError):
        store.create(title="x" * 121)
    with pytest.raises(ValueError):
        store.create(title="ok", note="x" * 2001)
    with pytest.raises(ValueError):
        store.create(title="ok", lane="x" * 41)
    with pytest.raises(ValueError):
        store.create(title="ok", status="waiting")
    with pytest.raises(ValueError):
        store.create(title="ok", due="2026-02-30")
    with pytest.raises(ValueError):
        store.create(title="ok", due="12/01/2026")
    with pytest.raises(ValueError):
        store.create(title="ok", priority="urgent")
    with pytest.raises(ValueError):
        store.create(title="ok", colour="red")

    assert store.load_tasks() == []
    assert not (tmp_path / "board.json").exists()


def test_create_with_done_status_sets_done_at(tmp_path):
    store = _store(tmp_path)
    task = store.create(title="已交材料", status="done")
    assert task["done_at"]


def test_done_at_tracks_leaving_done(tmp_path):
    store = _store(tmp_path)
    task = store.create(title="批改作业")

    moved = store.update(task["id"], status="done")
    assert moved["done_at"]
    first_done_at = moved["done_at"]

    # Editing another field on a finished task keeps the completion moment.
    again = store.update(task["id"], note="已批完")
    assert again["done_at"] == first_done_at

    reopened = store.update(task["id"], status="doing")
    assert reopened["done_at"] == ""
    assert store.get(task["id"])["done_at"] == ""


def test_update_rejects_unknown_or_invalid_fields_without_writing(tmp_path):
    store = _store(tmp_path)
    task = store.create(title="家长会", lane="一班")
    board_path = tmp_path / "board.json"
    before = board_path.read_bytes()

    with pytest.raises(ValueError):
        store.update(task["id"], colour="red")
    with pytest.raises(ValueError):
        store.update(task["id"], status="waiting")
    with pytest.raises(ValueError):
        store.update(task["id"], due="2026-13-01")
    with pytest.raises(ValueError):
        store.update(task["id"], priority="urgent")
    with pytest.raises(ValueError):
        # A rejected second field must not leave the first one applied.
        store.update(task["id"], note="changed", status="nope")

    assert board_path.read_bytes() == before
    assert store.get(task["id"]) == task


def test_update_missing_id_raises_key_error(tmp_path):
    store = _store(tmp_path)

    with pytest.raises(KeyError):
        store.update("", title="x")
    with pytest.raises(KeyError):
        store.update("deadbeef0000", title="x")


def test_delete_refuses_empty_id_and_unknown_id(tmp_path):
    store = _store(tmp_path)
    task = store.create(title="留着的任务")

    assert store.delete("") is False
    assert store.delete("   ") is False
    assert store.delete("deadbeef0000") is False
    assert [t["id"] for t in store.load_tasks()] == [task["id"]]

    assert store.delete(task["id"]) is True
    assert store.load_tasks() == []
    assert store.delete(task["id"]) is False


def test_board_columns_counts_and_lane_filter(tmp_path):
    store = _store(tmp_path)
    store.create(title="a", status="todo", lane="英语")
    store.create(title="b", status="doing", lane="英语")
    store.create(title="c", status="blocked", lane="数学")
    store.create(title="d", status="done", lane="英语")

    board = store.board()
    assert [c["status"] for c in board["columns"]] == ["todo", "doing", "blocked", "done"]
    assert [c["label"] for c in board["columns"]] == ["待办", "进行中", "受阻", "已完成"]
    assert board["counts"] == {"todo": 1, "doing": 1, "blocked": 1, "done": 1}
    assert board["total"] == 4

    english = store.board(lane="英语")
    assert english["counts"] == {"todo": 1, "doing": 1, "blocked": 0, "done": 1}
    assert english["total"] == 3
    assert len(english["columns"][2]["tasks"]) == 0


def test_list_filters_and_order(tmp_path):
    store = _store(tmp_path)
    undated = store.create(title="无期限")
    later = store.create(title="晚", due="2026-12-20")
    sooner = store.create(title="早", due="2026-12-01")

    ids = [t["id"] for t in store.list()]
    assert ids == [sooner["id"], later["id"], undated["id"]]
    assert [t["id"] for t in store.list(status="doing")] == []
    assert [t["id"] for t in store.list(lane="数学")] == []

    with pytest.raises(ValueError):
        store.list(status="waiting")


def test_hand_edited_entry_is_tolerated(tmp_path):
    (tmp_path / "board.json").write_text(json.dumps({
        "version": 1,
        "tasks": [
            {"id": "abc123abc123", "title": "旧任务", "status": "later"},
            {"id": "", "title": "no id"},
            {"id": "def456def456", "title": ""},
        ],
    }), encoding="utf-8")

    tasks = _store(tmp_path).load_tasks()
    assert [t["id"] for t in tasks] == ["abc123abc123"]
    assert tasks[0]["status"] == "todo"
    assert tasks[0]["priority"] == "normal"
