"""``/api/teaching/*`` handlers: shapes, error codes and tenant scoping."""

import json
from types import SimpleNamespace
from unittest.mock import patch

from channel.web.api import teaching as teaching_api
from channel.web.api.teaching import (
    TeachingAnalysisHandler,
    TeachingClassesHandler,
    TeachingExamsHandler,
    TeachingHomeworkHandler,
    TeachingHomeworkRecordsHandler,
    TeachingProgressHandler,
    TeachingScoresHandler,
    TeachingStudentHandler,
    TeachingStudentsHandler,
    TeachingTimetableHandler,
)

ITEMS = [
    {"key": "A", "label": "词汇", "full": 60},
    {"key": "B", "label": "阅读", "full": 40},
]


def _call(handler, method, workspace, *, payload=None, query=None, args=()):
    raw = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with patch.object(teaching_api, "_require_auth"), \
         patch.object(teaching_api.web, "header"), \
         patch.object(teaching_api.web, "data", return_value=raw), \
         patch.object(teaching_api.web, "input",
                      return_value=SimpleNamespace(**(query or {}))), \
         patch.object(teaching_api, "_get_workspace_root",
                      return_value=str(workspace)):
        return json.loads(getattr(handler(), method)(*args))


def _class(workspace, name="高一(1)班"):
    response = _call(TeachingClassesHandler, "POST", workspace, payload={"name": name})
    assert response["status"] == "success", response
    return response["class"]


def _students(workspace, class_id, rows):
    response = _call(TeachingStudentsHandler, "POST", workspace,
                     payload={"class_id": class_id, "students": rows})
    assert response["status"] == "success", response
    return response


def _exam(workspace, class_ids):
    response = _call(TeachingExamsHandler, "POST", workspace, payload={
        "name": "期中", "class_ids": class_ids, "full_score": 100,
        "date": "2026-11-02", "subject": "英语", "items": ITEMS,
    })
    assert response["status"] == "success", response
    return response["exam"]


def test_classes_crud_error_shape_and_tenant_isolation(tmp_path):
    first = tmp_path / "workspace-a"
    second = tmp_path / "workspace-b"

    created = _class(first)
    assert (first / "teaching" / "classes.json").exists()

    listed = _call(TeachingClassesHandler, "GET", first, query={"agent_id": ""})
    assert [entry["id"] for entry in listed["classes"]] == [created["id"]]
    assert _call(TeachingClassesHandler, "GET", second,
                 query={"agent_id": ""})["classes"] == []

    renamed = _call(TeachingClassesHandler, "PATCH", first,
                    payload={"id": created["id"], "name": "高一(2)班"})
    assert renamed["class"]["name"] == "高一(2)班"

    missing_name = _call(TeachingClassesHandler, "POST", first, payload={"grade": "高一"})
    assert missing_name["status"] == "error"
    assert missing_name["code"] == "bad_request"
    assert "name is required" in missing_name["message"]

    unknown_field = _call(TeachingClassesHandler, "POST", first,
                          payload={"name": "x", "colour": "red"})
    assert unknown_field["code"] == "bad_request"

    missing = _call(TeachingClassesHandler, "PATCH", first,
                    payload={"id": "nope", "name": "x"})
    assert missing == {"status": "error", "code": "not_found",
                       "message": "not found: nope"}
    assert _call(TeachingClassesHandler, "DELETE", first,
                 payload={"id": "nope"})["code"] == "not_found"

    deleted = _call(TeachingClassesHandler, "DELETE", first, payload={"id": created["id"]})
    assert deleted["deleted"] is True
    assert deleted["removed"]["students"] == 0
    assert _call(TeachingClassesHandler, "GET", first,
                 query={"agent_id": ""})["classes"] == []


def test_student_batch_import_upserts_and_reports_rows(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace)

    report = _students(workspace, klass["id"], [
        {"学号": "001", "姓名": "张三", "性别": "男", "标签": "组长"},
        {"学号": "002", "姓名": "李四"},
        {"姓名": "无号"},
    ])
    assert (report["imported"], report["updated"]) == (2, 0)
    assert report["failed"][0]["row"] == 3
    assert "no is required" in report["failed"][0]["reason"]

    again = _students(workspace, klass["id"], [{"学号": "001", "姓名": "张三丰"}])
    assert (again["imported"], again["updated"]) == (0, 1)

    roster = _call(TeachingStudentsHandler, "GET", workspace,
                   query={"class_id": klass["id"], "agent_id": ""})["students"]
    assert [student["no"] for student in roster] == ["001", "002"]
    assert roster[0]["name"] == "张三丰"

    patched = _call(TeachingStudentHandler, "PATCH", workspace,
                    payload={"name": "张三", "note": "转来"},
                    args=(roster[0]["id"],))
    assert patched["student"]["note"] == "转来"

    assert _call(TeachingStudentHandler, "DELETE", workspace, payload={},
                 args=(roster[0]["id"],))["deleted"] is True
    assert _call(TeachingStudentHandler, "DELETE", workspace, payload={},
                 args=(roster[0]["id"],))["code"] == "not_found"
    assert _call(TeachingStudentsHandler, "GET", workspace,
                 query={"class_id": "missing", "agent_id": ""})["code"] == "not_found"


def test_timetable_put_validates_and_round_trips(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace)

    empty = _call(TeachingTimetableHandler, "GET", workspace, query={"agent_id": ""})
    assert (empty["periods"], empty["slots"], empty["overrides"]) == ([], [], [])

    bad_weekday = _call(TeachingTimetableHandler, "PUT", workspace, payload={
        "slots": [{"class_id": klass["id"], "weekday": 8, "period": 1}],
    })
    assert bad_weekday["code"] == "bad_request"
    assert "weekday" in bad_weekday["message"]

    bad_class = _call(TeachingTimetableHandler, "PUT", workspace, payload={
        "slots": [{"class_id": "missing", "weekday": 1, "period": 1}],
    })
    assert bad_class["code"] == "not_found"

    saved = _call(TeachingTimetableHandler, "PUT", workspace, payload={
        "periods": [{"index": 1, "start": "08:00", "end": "08:45"}],
        "slots": [{"class_id": klass["id"], "weekday": 1, "period": 1,
                   "subject": "英语", "kind": "regular"}],
        "overrides": [{"date": "2026-11-13", "period": 1,
                       "class_id": klass["id"], "state": "cancelled"}],
    })
    assert saved["status"] == "success"
    assert saved["slots"][0]["weekday"] == 1
    assert saved["overrides"][0]["state"] == "cancelled"

    round_trip = _call(TeachingTimetableHandler, "GET", workspace, query={"agent_id": ""})
    assert round_trip["periods"][0]["start"] == "08:00"
    assert len(round_trip["slots"]) == 1


def test_progress_and_homework_handlers(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace)
    student = _students(workspace, klass["id"], [{"学号": "001", "姓名": "张三"}])
    roster = _call(TeachingStudentsHandler, "GET", workspace,
                   query={"class_id": klass["id"], "agent_id": ""})["students"]
    student_id = roster[0]["id"]

    item = _call(TeachingProgressHandler, "POST", workspace, payload={
        "class_id": klass["id"], "topic": "Unit 1", "planned_periods": 3,
    })["item"]
    advanced = _call(TeachingProgressHandler, "PATCH", workspace,
                     payload={"id": item["id"], "taught_periods": 1})["item"]
    assert advanced["taught_periods"] == 1
    assert [entry["id"] for entry in _call(
        TeachingProgressHandler, "GET", workspace,
        query={"class_id": klass["id"], "agent_id": ""})["items"]] == [item["id"]]

    bad_kind = _call(TeachingHomeworkHandler, "POST", workspace, payload={
        "class_id": klass["id"], "title": "练习", "kind": "quiz", "due": "2026-11-12",
    })
    assert bad_kind["code"] == "bad_request"
    bad_due = _call(TeachingHomeworkHandler, "POST", workspace, payload={
        "class_id": klass["id"], "title": "练习", "kind": "practice",
        "due": "2026-02-30",
    })
    assert bad_due["code"] == "bad_request"

    homework = _call(TeachingHomeworkHandler, "POST", workspace, payload={
        "class_ids": [klass["id"]], "title": "练习", "kind": "practice",
        "due": "2026-11-12",
    })["item"]
    records = _call(TeachingHomeworkRecordsHandler, "PUT", workspace,
                    payload={"records": {student_id: "submitted"}},
                    args=(homework["id"],))
    assert records["records"] == {student_id: "submitted"}

    listing = _call(TeachingHomeworkHandler, "GET", workspace,
                    query={"class_id": klass["id"], "agent_id": ""})
    assert listing["records"][homework["id"]] == {student_id: "submitted"}

    bad_state = _call(TeachingHomeworkRecordsHandler, "PUT", workspace,
                      payload={"records": {student_id: "lost"}},
                      args=(homework["id"],))
    assert bad_state["code"] == "bad_request"

    assert student["imported"] == 1
    assert _call(TeachingHomeworkHandler, "DELETE", workspace,
                 payload={"id": homework["id"]})["deleted"] is True


def test_exams_scores_and_analysis(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace)
    _students(workspace, klass["id"], [
        {"学号": "001", "姓名": "张三"},
        {"学号": "002", "姓名": "李四"},
        {"学号": "003", "姓名": "王五"},  # 缺考
    ])
    roster = _call(TeachingStudentsHandler, "GET", workspace,
                   query={"class_id": klass["id"], "agent_id": ""})["students"]
    exam = _exam(workspace, [klass["id"]])

    scores_path = workspace / "teaching" / "scores.json"
    invalid = _call(TeachingScoresHandler, "PUT", workspace,
                    payload={"scores": {roster[0]["id"]: {"A": 61, "B": 10}}},
                    args=(exam["id"],))
    assert invalid["code"] == "bad_request"
    assert "A" in invalid["message"]
    assert not scores_path.exists()

    unknown_student = _call(TeachingScoresHandler, "PUT", workspace,
                            payload={"scores": {"ghost": {"A": 1}}},
                            args=(exam["id"],))
    assert unknown_student["code"] == "not_found"

    saved = _call(TeachingScoresHandler, "PUT", workspace,
                  payload={"scores": {
                      roster[0]["id"]: {"A": 50, "B": 40},
                      roster[1]["id"]: {"A": 40, "B": 20},
                  }}, args=(exam["id"],))
    assert saved["scores"][roster[0]["id"]]["total"] == 90

    fetched = _call(TeachingScoresHandler, "GET", workspace,
                    query={"agent_id": ""}, args=(exam["id"],))
    assert fetched["scores"] == saved["scores"]

    analysis = _call(TeachingAnalysisHandler, "GET", workspace,
                     query={"exam_id": exam["id"], "class_id": "", "agent_id": ""})
    assert analysis["status"] == "success"
    summary = analysis["summary"]
    assert summary["average"] == 75.0          # (90 + 60) / 2
    assert summary["pass_rate"] == 100.0
    assert summary["excellent_rate"] == 50.0
    assert (summary["students"], summary["absent"]) == (3, 1)
    assert analysis["items"][0]["rate"] == 75.0     # (50+40) / 2 / 60
    assert analysis["items"][1]["rate"] == 75.0     # (40+20) / 2 / 40
    assert analysis["critical"] == []
    assert [row["total"] for row in analysis["students"]] == [90, 60, None]

    missing_id = _call(TeachingAnalysisHandler, "GET", workspace,
                       query={"exam_id": "", "class_id": "", "agent_id": ""})
    assert missing_id["code"] == "bad_request"
    unknown_exam = _call(TeachingAnalysisHandler, "GET", workspace,
                         query={"exam_id": "nope", "class_id": "", "agent_id": ""})
    assert unknown_exam["code"] == "not_found"

    assert [entry["id"] for entry in _call(
        TeachingExamsHandler, "GET", workspace,
        query={"class_id": klass["id"], "agent_id": ""})["exams"]] == [exam["id"]]

    # Patching the paper re-checks the marks that are already in.
    shrink = _call(TeachingExamsHandler, "PATCH", workspace, payload={
        "id": exam["id"], "items": [{"key": "A", "label": "词汇", "full": 40}],
    })
    assert shrink["code"] == "bad_request"
    assert "exceeds" in shrink["message"]

    assert _call(TeachingExamsHandler, "DELETE", workspace,
                 payload={"id": exam["id"]})["deleted"] is True
    assert _call(TeachingAnalysisHandler, "GET", workspace,
                 query={"exam_id": exam["id"], "class_id": "",
                        "agent_id": ""})["code"] == "not_found"


def test_unknown_body_fields_are_refused(tmp_path):
    workspace = tmp_path / "ws"
    klass = _class(workspace)

    response = _call(TeachingExamsHandler, "POST", workspace, payload={
        "name": "期中", "class_ids": [klass["id"]], "fullScore": 100,
        "date": "2026-11-02",
    })
    assert response["code"] == "bad_request"
    assert "fullScore" in response["message"]

    response = _call(TeachingProgressHandler, "POST", workspace, payload={
        "class_id": klass["id"], "topic": "Unit 1", "plannedPeriods": 3,
    })
    assert response["code"] == "bad_request"
