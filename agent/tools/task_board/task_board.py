"""The ``task_board`` Agent tool: chat-driven work items.

Use it when the teacher says something belongs on their board ("build three
tasks for this week's lesson prep", "the grading is done"). It never fires on
a timer; that is the scheduler's job, and the description says so, because the
two are easy to confuse from a single sentence.
"""

from __future__ import annotations

import os
from typing import Optional

from agent.board import BoardStore
from agent.board.store import FIELDS
from agent.tools.base_tool import BaseTool, ToolResult
from common.log import logger


class TaskBoardTool(BaseTool):
    name: str = "task_board"
    description: str = (
        "教师任务看板：记录教师自己要跟进的工作项（备课、批改、家长沟通、教研等）。\n"
        "与 scheduler 工具的区别：scheduler 是「到点自动触发的定时提醒/动作」，"
        "task_board 是「需要教师推进的事项」，不会在某个时间自动执行。"
        "用户说「提醒我」「每天/每周」「X 点」时用 scheduler；"
        "用户说「记一下」「待办」「拆成几个任务」「这件事做完了」时用 task_board。\n"
        "用法：\n"
        "- 看板：action='board'（四列：待办/进行中/受阻/已完成），可按 lane 过滤\n"
        "- 列表：action='list'，可按 status、lane 过滤\n"
        "- 新建：action='create', title='标题'（必填），可选 note/lane/due/due_time/category/priority\n"
        "- 修改：action='update', task_id='任务ID'，传要改的字段（改状态也走这里）\n"
        "- 删除：action='delete', task_id='任务ID'\n"
        "status: todo/doing/blocked/done；priority: urgent_important/important/urgent/neither；"
        "due: YYYY-MM-DD；due_time: HH:MM（需先有 due）；category: 类别，最多 20 字。"
    )
    params: dict = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["board", "list", "create", "update", "delete"],
                "description": "操作类型: board(看板), list(列表), create(新建), update(修改), delete(删除)",
            },
            "task_id": {
                "type": "string",
                "description": "任务ID（update / delete 必填）",
            },
            "title": {
                "type": "string",
                "description": "任务标题（create 必填，最多 120 字）",
            },
            "note": {
                "type": "string",
                "description": "详情（备注），可多行，最多 2000 字",
            },
            "status": {
                "type": "string",
                "enum": ["todo", "doing", "blocked", "done"],
                "description": "状态，默认 todo",
            },
            "lane": {
                "type": "string",
                "description": "泳道（学科或班级），最多 40 字",
            },
            "due": {
                "type": "string",
                "description": "截止日 YYYY-MM-DD，留空表示无期限",
            },
            "due_time": {
                "type": "string",
                "description": "截止时间 HH:MM，可空；有值时必须同时有 due",
            },
            "category": {
                "type": "string",
                "description": "类别（如备课/批改/班级/教研/家校/其他），最多 20 字",
            },
            "priority": {
                "type": "string",
                "enum": ["urgent_important", "important", "urgent", "neither"],
                "description": "四象限：urgent_important 重要紧急 / important 重要不紧急 / "
                               "urgent 不重要紧急 / neither 不重要不紧急，默认 important",
            },
        },
        "required": ["action"],
    }

    def __init__(self, config: Optional[dict] = None):
        super().__init__()
        self.config = config or {}

    def _store(self) -> BoardStore:
        """Explicit ``workspace_root`` (tests, scripts) wins over ambient identity."""
        root = self.config.get("workspace_root")
        if root:
            return BoardStore(os.path.join(os.fspath(root), "board.json"))
        return BoardStore()

    def execute(self, params: dict) -> ToolResult:
        action = params.get("action")
        store = self._store()
        try:
            if action == "board":
                return ToolResult.success(store.board(lane=params.get("lane")))
            if action == "list":
                return ToolResult.success({
                    "tasks": store.list(
                        status=params.get("status"), lane=params.get("lane")
                    )
                })
            if action == "create":
                fields = {
                    key: params[key] for key in FIELDS
                    if key in params and params[key] is not None
                }
                if "source" not in fields:
                    # Created from a conversation, so say so: a task whose
                    # origin is wrong is worse than one with no origin.
                    from common.runtime_identity import current_identity

                    fields["source"] = {
                        "type": "chat",
                        "ref": current_identity().session_id or "",
                    }
                task = store.create(**fields)
                return ToolResult.success({
                    "message": f"已创建任务「{task['title']}」（{task['id']}）",
                    "task": task,
                })
            if action == "update":
                task_id = params.get("task_id")
                if not task_id:
                    return ToolResult.fail("错误: 修改任务缺少任务ID (task_id)")
                fields = {
                    key: params[key] for key in FIELDS
                    if key in params and params[key] is not None
                }
                if not fields:
                    return ToolResult.fail("错误: 没有需要修改的字段")
                task = store.update(task_id, **fields)
                return ToolResult.success({
                    "message": f"已更新任务「{task['title']}」",
                    "task": task,
                })
            if action == "delete":
                task_id = params.get("task_id")
                if not task_id:
                    return ToolResult.fail("错误: 删除任务缺少任务ID (task_id)")
                if not store.delete(task_id):
                    return ToolResult.fail(f"错误: 任务不存在 ({task_id})")
                return ToolResult.success({"message": f"已删除任务 {task_id}"})
            return ToolResult.fail(f"未知操作: {action}")
        except KeyError as e:
            return ToolResult.fail(f"错误: 任务不存在 ({e.args[0] if e.args else ''})")
        except ValueError as e:
            return ToolResult.fail(f"错误: {e}")
        except Exception as e:
            logger.error(f"[TaskBoardTool] Error: {e}")
            return ToolResult.fail(f"操作失败: {e}")
