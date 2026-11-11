"""Today's courses, reminder settings, text builders and scheduler sync.

The wording is pinned here: the console mirrors ``digest_text`` and the lesson
reminder verbatim, so a change to either builder must be a deliberate test
change. Sync runs against a throwaway ``TaskStore`` -- the real one is global
and must never be touched by a test.
"""

import json
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import channel.web.api.teaching as teaching_api
from agent.board import BoardStore
from agent.teaching import TeachingStore
from agent.teaching.reminders import (
    build_digest,
    build_lesson,
    digest_cron,
    lesson_cron,
    preview,
    sync,
)
from agent.tools.scheduler.task_store import TaskStore
from channel.web.api.teaching import (
    TeachingClassesHandler,
    TeachingRemindersPreviewHandler,
    TeachingRemindersSyncHandler,
    TeachingSettingsHandler,
    TeachingTodayHandler,
    TeachingTimetableHandler,
)

TUESDAY = "2026-11-10"


def _store(tmp_path):
    return TeachingStore(tmp_path / "teaching")


def _fixture_classes(store):
    first = store.create_class(name="七（1）班", grade="七", subject="英语")
    second = store.create_class(name="七（2）班", grade="七", subject="英语")
    return first, second


def _fixture(store):
    """Two of my lessons on Tuesday, one other teacher's, one Monday lesson."""
    first, second = _fixture_classes(store)
    store.save_timetable(
        periods=[
            {"index": 1, "start": "08:00", "end": "08:40"},
            {"index": 2, "start": "09:00", "end": "09:40"},
            {"index": 3, "start": "10:00", "end": "10:40"},
        ],
        slots=[
            {"class_id": first["id"], "weekday": 2, "period": 1,
             "subject": "英语", "kind": "regular"},
            {"class_id": first["id"], "weekday": 2, "period": 2,
             "subject": "数学", "kind": "regular", "mine": False,
             "teacher": "王老师"},
            {"class_id": second["id"], "weekday": 2, "period": 3,
             "subject": "英语", "kind": "regular"},
            {"class_id": first["id"], "weekday": 1, "period": 1,
             "subject": "英语", "kind": "regular"},
        ],
    )
    store.create_progress(first["id"], topic="Unit 3 My weekend plan",
                          planned_periods=4, taught_periods=1)
    zhang = store.create_student(first["id"], no="001", name="张三")
    li = store.create_student(second["id"], no="001", name="李四")
    wang = store.create_student(second["id"], no="002", name="王五")
    homework = store.create_homework(
        [first["id"], second["id"]], title="Unit 3 词汇练习",
        kind="practice", due=TUESDAY,
    )
    store.save_homework_records(homework["id"], {
        zhang["id"]: "missing", li["id"]: "missing", wang["id"]: "submitted",
    })
    return first, second


def _board_tasks(tmp_path):
    board = BoardStore(str(tmp_path / "board.json"))
    board.create(title="Unit 3 课件", due=TUESDAY)
    board.create(title="批改周测", due=TUESDAY)
    board.create(title="下周计划", due="2026-11-11")
    board.create(title="已完成", due=TUESDAY, status="done")


# --- Slot ownership --------------------------------------------------------


def test_slot_ownership_defaults_and_round_trips(tmp_path):
    store = _store(tmp_path)
    klass, _ = _fixture_classes(store)

    saved = store.save_timetable(slots=[
        {"class_id": klass["id"], "weekday": 1, "period": 1, "subject": "英语"},
    ])["slots"][0]
    assert saved["mine"] is True
    assert saved["teacher"] == ""

    marked = store.save_timetable(slots=[
        {"class_id": klass["id"], "weekday": 1, "period": 1, "subject": "数学",
         "mine": False, "teacher": "王老师"},
    ])["slots"][0]
    assert marked["mine"] is False
    assert marked["teacher"] == "王老师"
    assert store.get_timetable()["slots"][0]["mine"] is False

    with pytest.raises(ValueError):
        store.save_timetable(slots=[
            {"class_id": klass["id"], "weekday": 1, "period": 1, "mine": "yes"},
        ])
    with pytest.raises(ValueError):
        store.save_timetable(slots=[
            {"class_id": klass["id"], "weekday": 1, "period": 1,
             "teacher": "x" * 41},
        ])


def test_rows_written_before_ownership_read_as_mine(tmp_path):
    store = _store(tmp_path)
    klass, _ = _fixture_classes(store)
    path = tmp_path / "teaching" / "timetable.json"
    path.write_text(json.dumps({
        "version": 1,
        "periods": [{"index": 1, "start": "08:00", "end": "08:40"}],
        "slots": [{"id": "old", "class_id": klass["id"], "weekday": 1,
                   "period": 1, "subject": "英语", "kind": "regular"}],
        "overrides": [],
    }), encoding="utf-8")

    slot = store.get_timetable()["slots"][0]
    assert slot["mine"] is True
    assert slot["teacher"] == ""


# --- Settings --------------------------------------------------------------


def test_settings_defaults_merge_and_validation(tmp_path):
    store = _store(tmp_path)
    assert store.get_settings() == {
        "morning": {"enabled": True, "time": "07:30"},
        "lesson": {"enabled": True, "minutes": 10},
        "channel": "web",
    }

    saved = store.save_settings(lesson={"minutes": 15})
    assert saved["lesson"] == {"enabled": True, "minutes": 15}
    assert saved["morning"] == {"enabled": True, "time": "07:30"}
    assert store.get_settings()["lesson"]["minutes"] == 15

    store.save_settings(morning={"enabled": False, "time": "06:45"},
                        channel="feishu")
    round_trip = store.get_settings()
    assert round_trip["morning"] == {"enabled": False, "time": "06:45"}
    assert round_trip["channel"] == "feishu"

    for bad in ({"morning": {"time": "7:30"}},
                {"morning": {"time": "24:00"}},
                {"lesson": {"minutes": 0}},
                {"lesson": {"minutes": 61}},
                {"lesson": {"minutes": "10"}},
                {"channel": ""},
                {"colour": "red"},
                {"morning": {"repeat": "daily"}}):
        with pytest.raises(ValueError):
            store.save_settings(**bad)


def test_damaged_settings_read_as_defaults(tmp_path):
    store = _store(tmp_path)
    (tmp_path / "teaching").mkdir(exist_ok=True)
    (tmp_path / "teaching" / "settings.json").write_text(
        '{"morning": {"enabled": "no", "time": "99:99"}, "lesson": {"minutes": 0}}',
        encoding="utf-8",
    )
    assert store.get_settings() == {
        "morning": {"enabled": True, "time": "07:30"},
        "lesson": {"enabled": True, "minutes": 10},
        "channel": "web",
    }


# --- Today -----------------------------------------------------------------


def test_today_aggregation_excludes_other_teachers_and_builds_the_digest(tmp_path):
    store = _store(tmp_path)
    _fixture(store)
    _board_tasks(tmp_path)

    view = store.today(TUESDAY, name="孙老师")

    assert (view["date"], view["weekday"]) == (TUESDAY, 2)
    assert [slot["period"] for slot in view["slots"]] == [1, 3]
    assert all(slot["mine"] is True for slot in view["slots"])
    assert view["slots"][0] == {
        "period": 1, "start": "08:00", "end": "08:40",
        "class_id": view["slots"][0]["class_id"], "class_name": "七（1）班",
        "subject": "英语", "kind": "regular", "mine": True,
        "topic": "Unit 3 My weekend plan",
    }
    assert view["slots"][1]["topic"] == ""
    assert [(task["title"], task["status"]) for task in view["tasks_due"]] == [
        ("批改周测", "todo"), ("Unit 3 课件", "todo"),
    ]
    assert view["homework_due"] == [
        {"title": "Unit 3 词汇练习", "due": TUESDAY, "missing": ["张三", "李四"]},
    ]
    assert view["digest_text"] == (
        "早上好，孙老师。今天周二，2 节课：\n"
        "· 08:00–08:40 七（1）班 英语（Unit 3 My weekend plan）\n"
        "· 10:00–10:40 七（2）班 英语\n"
        "今日待办 2 项：批改周测（今天截止）、Unit 3 课件\n"
        "作业未交 2 人：张三、李四"
    )


def test_today_without_lessons_reports_the_due_work(tmp_path):
    store = _store(tmp_path)
    _fixture(store)
    board = BoardStore(str(tmp_path / "board.json"))
    board.create(title="备课", due="2026-11-14")

    view = store.today("2026-11-14", name="孙老师")
    assert view["slots"] == []
    assert view["digest_text"] == (
        "早上好，孙老师。今天没有课。\n"
        "今日待办 1 项：备课（今天截止）"
    )


def test_cancelled_and_changed_overrides_apply_to_today(tmp_path):
    store = _store(tmp_path)
    first, second = _fixture(store)
    store.save_timetable(overrides=[
        {"date": TUESDAY, "period": 3, "class_id": second["id"],
         "state": "cancelled"},
        {"date": TUESDAY, "period": 2, "class_id": second["id"],
         "subject": "英语", "kind": "regular", "state": "changed"},
    ])

    slots = store.today(TUESDAY, name="孙老师")["slots"]
    # Period 3 is cancelled; the changed period 2 replaces the other teacher's
    # maths lesson with the caller's English lesson.
    assert [(slot["period"], slot["class_name"]) for slot in slots] == [
        (1, "七（1）班"), (2, "七（2）班"),
    ]
    assert all(slot["mine"] is True for slot in slots)


# --- Text builders ---------------------------------------------------------


def test_digest_text_omits_empty_sections():
    lessons = [
        {"start": "08:00", "end": "08:40", "class_name": "七（1）班",
         "subject": "英语"},
    ]
    assert build_digest("孙老师", 2, lessons, [], []) == (
        "早上好，孙老师。今天周二，1 节课：\n"
        "· 08:00–08:40 七（1）班 英语"
    )
    assert build_digest("孙老师", 2, [], [], []) == "早上好，孙老师。今天没有课。"


def test_lesson_text_with_and_without_topic_and_homework():
    assert build_lesson(
        10, 3, "10:00", "七（1）班", "英语",
        topic="Unit 3 My weekend plan", homework="Unit 3 词汇练习",
    ) == (
        "⏰ 10 分钟后上课：第 3 节 10:00 七（1）班 · 英语\n"
        "今天讲「Unit 3 My weekend plan」；作业：Unit 3 词汇练习"
    )
    assert build_lesson(10, 3, "10:00", "七（1）班", "英语") == (
        "⏰ 10 分钟后上课：第 3 节 10:00 七（1）班 · 英语"
    )
    assert build_lesson(10, 3, "10:00", "七（1）班", "英语",
                        topic="Unit 3") == (
        "⏰ 10 分钟后上课：第 3 节 10:00 七（1）班 · 英语\n"
        "今天讲「Unit 3」"
    )
    assert build_lesson(10, 3, "10:00", "七（1）班", "英语",
                        homework="练习") == (
        "⏰ 10 分钟后上课：第 3 节 10:00 七（1）班 · 英语\n"
        "作业：练习"
    )


def test_cron_expressions_shift_before_midnight():
    assert digest_cron("07:30") == "30 7 * * *"
    assert digest_cron("23:59") == "59 23 * * *"
    assert digest_cron("25:00") is None
    assert lesson_cron(1, "08:00", 10) == "50 7 * * 1"
    assert lesson_cron(7, "08:00", 10) == "50 7 * * 0"
    assert lesson_cron(1, "00:05", 10) == "55 23 * * 0"
    assert lesson_cron(1, "", 10) is None


# --- Sync ------------------------------------------------------------------


def _teaching_tasks(task_store, agent_id):
    return [task for task in task_store.load_tasks().values()
            if str(task.get("name", "")).startswith("[teaching]")
            and task.get("agent_id") == agent_id]


def test_sync_is_idempotent_and_removes_stale_marked_tasks(tmp_path):
    store = _store(tmp_path)
    _fixture(store)
    task_store = TaskStore(str(tmp_path / "tasks.json"))
    now = datetime(2026, 11, 10, 6, 0)

    first = sync(store, agent_id="teacher-a", task_store=task_store,
                 receiver="session-1", now=now)
    assert first == {"scheduled": 4, "digest": {"enabled": True},
                     "lesson": {"count": 3}}
    tasks = _teaching_tasks(task_store, "teacher-a")
    assert len(tasks) == 4

    digest = next(task for task in tasks
                  if task["name"] == "[teaching] 早晨简报")
    assert digest["schedule"] == {"type": "cron", "expression": "30 7 * * *"}
    assert digest["action"]["type"] == "teaching_digest"
    assert "content" not in digest["action"]
    assert digest["action"]["receiver"] == "session-1"

    monday = next(task for task in tasks if "周一" in task["name"])
    assert monday["schedule"] == {"type": "cron", "expression": "50 7 * * 1"}
    assert monday["action"]["type"] == "send_message"
    assert monday["action"]["content"] == (
        "⏰ 10 分钟后上课：第 1 节 08:00 七（1）班 · 英语\n"
        "今天讲「Unit 3 My weekend plan」；作业：Unit 3 词汇练习"
    )

    # A stale task under this Agent's namespace goes away; another Agent's
    # identically named task is none of our business.
    task_store.add_task({"id": "stale1", "name": "[teaching] stale",
                         "agent_id": "teacher-a"})
    task_store.add_task({"id": "other1", "name": "[teaching] other",
                         "agent_id": "teacher-b"})

    second = sync(store, agent_id="teacher-a", task_store=task_store,
                  receiver="session-1", now=now)
    assert second == first
    assert len(_teaching_tasks(task_store, "teacher-a")) == 4
    assert task_store.get_task("stale1") is None
    assert task_store.get_task("other1") is not None


def test_sync_respects_disabled_reminders(tmp_path):
    store = _store(tmp_path)
    _fixture(store)
    task_store = TaskStore(str(tmp_path / "tasks.json"))
    now = datetime(2026, 11, 10, 6, 0)

    store.save_settings(lesson={"enabled": False})
    result = sync(store, agent_id="teacher-a", task_store=task_store,
                  receiver="session-1", now=now)
    assert result == {"scheduled": 1, "digest": {"enabled": True},
                      "lesson": {"count": 0}}
    assert [task["name"] for task in _teaching_tasks(task_store, "teacher-a")] == [
        "[teaching] 早晨简报",
    ]

    store.save_settings(morning={"enabled": False})
    result = sync(store, agent_id="teacher-a", task_store=task_store,
                  receiver="session-1", now=now)
    assert result == {"scheduled": 0, "digest": {"enabled": False},
                      "lesson": {"count": 0}}
    assert _teaching_tasks(task_store, "teacher-a") == []


def test_preview_returns_the_digest_and_the_next_lesson(tmp_path):
    store = _store(tmp_path)
    _fixture(store)
    _board_tasks(tmp_path)

    view = preview(store, now=datetime(2026, 11, 10, 6, 0))
    assert view["digest"].startswith("早上好，")
    assert "今天周二，2 节课：" in view["digest"]
    assert view["next_lesson"].startswith(
        "⏰ 10 分钟后上课：第 1 节 08:00 七（1）班 · 英语")
    assert "今天讲「Unit 3 My weekend plan」" in view["next_lesson"]

    # Monday evening: the day is over, so the next reminder is next Monday's
    # lesson rather than an empty preview.
    evening = preview(store, now=datetime(2026, 11, 9, 20, 0))
    assert evening["next_lesson"].startswith(
        "⏰ 10 分钟后上课：第 1 节 08:00 七（1）班")


# --- API handlers ----------------------------------------------------------


def _call(handler, method, workspace, *, payload=None, query=None, args=()):
    raw = b"" if payload is None else json.dumps(
        payload, ensure_ascii=False).encode("utf-8")
    with patch.object(teaching_api, "_require_auth"), \
         patch.object(teaching_api.web, "header"), \
         patch.object(teaching_api.web, "data", return_value=raw), \
         patch.object(teaching_api.web, "input",
                      return_value=SimpleNamespace(**(query or {}))), \
         patch.object(teaching_api, "_get_workspace_root",
                      return_value=str(workspace)):
        return json.loads(getattr(handler(), method)(*args))


def _class(workspace, name):
    response = _call(TeachingClassesHandler, "POST", workspace,
                     payload={"name": name, "subject": "英语"})
    assert response["status"] == "success", response
    return response["class"]


def test_today_settings_and_preview_handlers(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace, "七（1）班")
    saved = _call(TeachingTimetableHandler, "PUT", workspace, payload={
        "periods": [{"index": 1, "start": "08:00", "end": "08:40"}],
        "slots": [{"class_id": klass["id"], "weekday": 2, "period": 1,
                   "subject": "英语"}],
    })
    assert saved["status"] == "success"

    with patch("agent.teaching.reminders.teacher_name", return_value="孙老师"):
        today = _call(TeachingTodayHandler, "GET", workspace,
                      query={"date": TUESDAY, "agent_id": ""})
    assert today["status"] == "success"
    assert today["date"] == TUESDAY
    assert today["slots"][0]["mine"] is True
    assert today["digest_text"].startswith("早上好，孙老师。今天周二，1 节课：")

    settings = _call(TeachingSettingsHandler, "GET", workspace,
                     query={"agent_id": ""})
    assert settings["lesson"] == {"enabled": True, "minutes": 10}

    updated = _call(TeachingSettingsHandler, "PUT", workspace,
                    payload={"lesson": {"minutes": 20}})
    assert updated["lesson"] == {"enabled": True, "minutes": 20}

    nested = _call(TeachingSettingsHandler, "PUT", workspace,
                   payload={"settings": {"morning": {"enabled": False}}})
    assert nested["morning"]["enabled"] is False

    bad = _call(TeachingSettingsHandler, "PUT", workspace,
                payload={"lesson": {"minutes": 0}})
    assert bad["code"] == "bad_request"

    with patch("agent.teaching.reminders.teacher_name", return_value="孙老师"):
        view = _call(TeachingRemindersPreviewHandler, "GET", workspace,
                     query={"agent_id": ""})
    assert view["digest"].startswith("早上好，孙老师。")
    assert view["next_lesson"].startswith("⏰ 20 分钟后上课")


def test_sync_handler_rebuilds_tasks(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace, "七（1）班")
    _call(TeachingTimetableHandler, "PUT", workspace, payload={
        "periods": [{"index": 1, "start": "08:00", "end": "08:40"}],
        "slots": [{"class_id": klass["id"], "weekday": 1, "period": 1,
                   "subject": "英语"}],
    })
    task_store = TaskStore(str(tmp_path / "tasks.json"))

    with patch("agent.teaching.reminders._default_task_store",
               return_value=task_store):
        response = _call(TeachingRemindersSyncHandler, "POST", workspace,
                         payload={"session_id": "web-session"})

    assert response == {
        "status": "success",
        "scheduled": 2,
        "digest": {"enabled": True},
        "lesson": {"count": 1},
    }
    tasks = list(task_store.load_tasks().values())
    assert {task["schedule"]["expression"] for task in tasks} == {
        "30 7 * * *", "50 7 * * 1",
    }
    assert all(task["action"]["receiver"] == "web-session" for task in tasks)


def test_auto_sync_failure_never_fails_the_save(tmp_path):
    workspace = tmp_path / "ws"
    _class(workspace, "七（1）班")

    with patch("agent.tools.scheduler.integration.get_scheduler_service",
               return_value=SimpleNamespace(running=True)), \
         patch("agent.teaching.reminders.sync",
               side_effect=RuntimeError("scheduler unavailable")):
        response = _call(TeachingSettingsHandler, "PUT", workspace,
                         payload={"lesson": {"minutes": 20}})

    assert response["status"] == "success"
    assert response["lesson"]["minutes"] == 20


def test_teaching_digest_sends_text_computed_at_fire_time(monkeypatch):
    import agent.teaching.reminders as reminders
    import agent.tools.scheduler.integration as integration

    monkeypatch.setattr(
        reminders, "digest_for_today",
        lambda agent_id=None: "早上好。今天周三，1 节课。",
    )
    captured = {}

    def fake_send(task, bridge, agent_id=None, output_sink=None):
        captured["task"] = task
        return True

    monkeypatch.setattr(integration, "_execute_send_message", fake_send)
    task = {"id": "t1", "action": {"receiver": "r", "channel_type": "web",
                                   "receiver_name": "Web", "is_group": False}}
    assert integration._execute_teaching_digest(task, None, "t_1") is True
    sent = captured["task"]["action"]
    assert sent["type"] == "send_message"
    assert sent["content"] == "早上好。今天周三，1 节课。"
    assert task["action"].get("content") is None  # stored task stays text-free
