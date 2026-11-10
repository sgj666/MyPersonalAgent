"""``task_board`` tool: the chat-facing surface of the board."""



from agent.board import BoardStore
from agent.tools import TaskBoardTool


def _tool(tmp_path):
    return TaskBoardTool({"workspace_root": str(tmp_path)})


def test_tool_metadata_distinguishes_it_from_the_scheduler():
    tool = TaskBoardTool()

    assert tool.name == "task_board"
    assert "scheduler" in tool.description
    assert "定时" in tool.description
    assert "跟进" in tool.description
    assert tool.params["required"] == ["action"]
    assert set(tool.params["properties"]["action"]["enum"]) == {
        "board", "list", "create", "update", "delete",
    }


def test_tool_writes_board_json_under_its_workspace(tmp_path):
    result = _tool(tmp_path).execute({"action": "create", "title": "整单元备课"})

    assert result.status == "success"
    assert (tmp_path / "board.json").exists()
    assert result.result["task"]["title"] == "整单元备课"
    # The chat path records its origin, so the board can tell a spoken task
    # from one typed into the view.
    assert result.result["task"]["source"]["type"] == "chat"

    stored = BoardStore(tmp_path / "board.json").load_tasks()
    assert [t["id"] for t in stored] == [result.result["task"]["id"]]


def test_tool_moves_a_task_across_statuses(tmp_path):
    tool = _tool(tmp_path)
    task_id = tool.execute({"action": "create", "title": "改作业"}).result["task"]["id"]

    doing = tool.execute({"action": "update", "task_id": task_id, "status": "doing"})
    assert doing.status == "success"
    assert doing.result["task"]["status"] == "doing"

    done = tool.execute({"action": "update", "task_id": task_id, "status": "done"})
    assert done.result["task"]["done_at"]

    board = tool.execute({"action": "board"}).result
    assert board["counts"] == {"todo": 0, "doing": 0, "blocked": 0, "done": 1}
    assert board["total"] == 1


def test_tool_list_filters(tmp_path):
    tool = _tool(tmp_path)
    tool.execute({"action": "create", "title": "英语", "lane": "英语"})
    tool.execute({"action": "create", "title": "数学", "lane": "数学", "status": "doing"})

    listed = tool.execute({"action": "list", "lane": "数学"}).result["tasks"]
    assert [t["title"] for t in listed] == ["数学"]

    doing = tool.execute({"action": "list", "status": "doing"}).result["tasks"]
    assert [t["title"] for t in doing] == ["数学"]


def test_tool_delete(tmp_path):
    tool = _tool(tmp_path)
    task_id = tool.execute({"action": "create", "title": "临时"}).result["task"]["id"]

    assert tool.execute({"action": "delete", "task_id": task_id}).status == "success"
    assert tool.execute({"action": "board"}).result["total"] == 0

    missing = tool.execute({"action": "delete", "task_id": task_id})
    assert missing.status == "error"
    assert "不存在" in missing.result


def test_tool_refuses_unknown_action_missing_id_and_bad_status(tmp_path):
    tool = _tool(tmp_path)

    unknown = tool.execute({"action": "archive"})
    assert unknown.status == "error"
    assert "未知操作" in unknown.result

    assert tool.execute({"action": "update", "title": "x"}).status == "error"
    assert tool.execute({"action": "delete"}).status == "error"
    assert tool.execute({"action": "update", "task_id": ""}).status == "error"

    bad = tool.execute({"action": "create", "title": "x", "status": "waiting"})
    assert bad.status == "error"
    assert "invalid status" in bad.result
    assert (tmp_path / "board.json").exists() is False

    created = tool.execute({"action": "create", "title": "ok"}).result["task"]
    bad_update = tool.execute(
        {"action": "update", "task_id": created["id"], "priority": "urgent"}
    )
    assert bad_update.status == "error"
    assert BoardStore(tmp_path / "board.json").get(created["id"])["priority"] == "normal"

    no_fields = tool.execute({"action": "update", "task_id": created["id"]})
    assert no_fields.status == "error"
    assert "没有需要修改的字段" in no_fields.result


def test_tool_refuses_missing_title(tmp_path):
    result = _tool(tmp_path).execute({"action": "create"})

    assert result.status == "error"
    assert "title" in result.result
    assert not (tmp_path / "board.json").exists()
