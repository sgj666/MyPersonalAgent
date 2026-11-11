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
        due_time=" 18:00 ",
        category=" 备课 ",
        priority="urgent_important",
        source={"type": "chat", "ref": "sess-1"},
    )

    assert re.fullmatch(r"[0-9a-f]{12}", task["id"])
    assert task["title"] == "备 课 三单元"
    assert task["note"] == "第一行\n第二行"
    assert task["status"] == "todo"
    assert task["lane"] == "英语"
    assert task["due"] == "2026-12-01"
    assert task["due_time"] == "18:00"
    assert task["category"] == "备课"
    assert task["priority"] == "urgent_important"
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
        store.create(title="ok", due="2026-12-01", due_time="8:00")
    with pytest.raises(ValueError):
        store.create(title="ok", due="2026-12-01", due_time="24:00")
    with pytest.raises(ValueError):
        store.create(title="ok", due_time="09:00")
    with pytest.raises(ValueError):
        store.create(title="ok", category="备" * 21)
    with pytest.raises(ValueError):
        store.create(title="ok", priority="someday")
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
        store.update(task["id"], due_time="09:00")
    with pytest.raises(ValueError):
        store.update(task["id"], priority="someday")
    with pytest.raises(ValueError):
        store.update(task["id"], category="备" * 21)
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
    assert tasks[0]["priority"] == "important"
    assert tasks[0]["due_time"] == ""
    assert tasks[0]["category"] == ""


def test_legacy_priority_migrates_on_read_and_write(tmp_path):
    (tmp_path / "board.json").write_text(json.dumps({
        "version": 1,
        "tasks": [
            {"id": "aaa111", "title": "high", "priority": "high"},
            {"id": "bbb222", "title": "normal", "priority": "normal"},
            {"id": "ccc333", "title": "low", "priority": "low"},
            {"id": "ddd444", "title": "unknown", "priority": "whenever"},
        ],
    }), encoding="utf-8")

    store = _store(tmp_path)
    assert {t["title"]: t["priority"] for t in store.load_tasks()} == {
        "high": "urgent_important",
        "normal": "important",
        "low": "neither",
        "unknown": "important",
    }

    # Writing a legacy code normalizes it rather than storing the old value.
    assert store.create(title="迁移", priority="high")["priority"] == "urgent_important"
    assert store.create(title="迁移2", priority="low")["priority"] == "neither"
    stored = json.loads((tmp_path / "board.json").read_text(encoding="utf-8"))
    written = {t["title"]: t["priority"] for t in stored["tasks"]}
    assert written["迁移"] == "urgent_important"
    assert written["迁移2"] == "neither"


def test_priority_sort_orders_quadrants_then_due(tmp_path):
    store = _store(tmp_path)
    neither = store.create(title="不紧急不重要", priority="neither")
    urgent_late = store.create(title="不重要紧急-晚", priority="urgent", due="2026-12-20")
    urgent_soon = store.create(title="不重要紧急-早", priority="urgent", due="2026-12-01")
    important = store.create(title="重要不紧急", priority="important")
    first = store.create(title="重要紧急", priority="urgent_important", due="2026-12-10")

    ordered = [t["id"] for t in store.list(mode="priority")]
    assert ordered == [first["id"], important["id"], urgent_soon["id"],
                       urgent_late["id"], neither["id"]]

    # The default stays deadline-first.
    due_first = [t["id"] for t in store.list()]
    assert due_first == [urgent_soon["id"], first["id"], urgent_late["id"],
                         important["id"], neither["id"]]

    with pytest.raises(ValueError):
        store.list(mode="whenever")


def test_due_time_requires_due_and_is_dropped_with_it(tmp_path):
    store = _store(tmp_path)
    task = store.create(title="早读", due="2026-12-01", due_time="07:30")
    assert task["due_time"] == "07:30"

    # Adding a time to an undated task is refused without touching the file.
    no_due = store.create(title="无期限")
    board_path = tmp_path / "board.json"
    before = board_path.read_bytes()
    with pytest.raises(ValueError):
        store.update(no_due["id"], due_time="09:00")
    assert board_path.read_bytes() == before

    cleared = store.update(task["id"], due="")
    assert cleared["due"] == ""
    assert cleared["due_time"] == ""

    # A time sent together with its date in one update is accepted.
    together = store.update(no_due["id"], due="2026-12-02", due_time="10:15")
    assert together["due_time"] == "10:15"

    # An unreadable stored time reads as absent rather than breaking the card.
    stored = json.loads(board_path.read_text(encoding="utf-8"))
    for row in stored["tasks"]:
        if row["id"] == no_due["id"]:
            row["due_time"] = "25:99"
    board_path.write_text(json.dumps(stored), encoding="utf-8")
    assert store.get(no_due["id"])["due_time"] == ""


def test_category_and_due_time_default_empty_on_create(tmp_path):
    task = _store(tmp_path).create(title="普通任务")
    assert task["category"] == ""
    assert task["due_time"] == ""
