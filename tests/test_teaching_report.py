"""AI 成绩分析报告：事实提取、落盘、再读回。

The model is stubbed out on purpose: what must hold is that the numbers come
from the analysis (not the model), the report is bound to its exam, and a failed
generation never overwrites a good one.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.teaching import report as report_mod
from channel.web.api import teaching as teaching_api
from channel.web.api.teaching import TeachingReportHandler

ANALYSIS = {
    "summary": {
        "exam_id": "exam-1",
        "name": "综合成绩（导入）",
        "date": "2026-11-22",
        "subject": "英语",
        "full_score": 780,
        "class_ids": ["c1"],
        "pass_line": 546,
        "excellent_line": 702,
        "low_line": 468,
        "students": 4,
        "absent": 1,
        "scored": 3,
        "average": 416.93,
        "pass_rate": 40.43,
        "excellent_rate": 2.13,
        "low_rate": 23.4,
        "stddev": 136.33,
        "max": 664.0,
        "min": 101.0,
    },
    "by_class": [
        {"class_id": "c1", "class_name": "九年级9班", "students": 4, "absent": 1,
         "average": 416.93, "pass_rate": 40.43, "excellent_rate": 2.13, "stddev": 136.33},
    ],
    "items": [
        {"key": "en", "label": "英语", "full": 120, "scored": 3, "absent": 1,
         "average": 99.5, "rate": 82.9, "by_class": []},
    ],
    "critical": [
        {"student_id": "s3", "name": "陈建昊", "no": "03", "class_name": "九年级9班",
         "total": 609.5, "kind": "excellent", "line": 702, "gap": 92.5},
    ],
    "students": [
        {"student_id": "s1", "name": "刘家兴", "no": "01", "class_id": "c1",
         "class_name": "九年级9班", "total": 664.0, "absent": False,
         "exams": [{"exam_id": "exam-1", "name": "综合成绩", "total": 664.0}], "trend": [664.0]},
        {"student_id": "s2", "name": "沈佳琪", "no": "02", "class_id": "c1",
         "class_name": "九年级9班", "total": 605.0, "absent": False,
         "exams": [{"exam_id": "exam-1", "name": "综合成绩", "total": 605.0}], "trend": [605.0]},
        {"student_id": "s3", "name": "陈建昊", "no": "03", "class_id": "c1",
         "class_name": "九年级9班", "total": 609.5, "absent": False,
         "exams": [{"exam_id": "exam-1", "name": "综合成绩", "total": 609.5}], "trend": [609.5]},
        {"student_id": "s4", "name": "王一冉", "no": "04", "class_id": "c1",
         "class_name": "九年级9班", "total": None, "absent": True,
         "exams": [{"exam_id": "exam-1", "name": "综合成绩", "total": None}], "trend": [None]},
    ],
}


class FakeStore:
    def __init__(self, base):
        self.base = base

    def analysis(self, exam_id, class_id=None):
        assert exam_id == "exam-1"
        return ANALYSIS


@pytest.fixture()
def store(tmp_path):
    return FakeStore(tmp_path / "teaching")


def test_facts_come_from_the_analysis_not_the_model():
    digest = report_mod._digest(ANALYSIS)
    assert digest["overall"]["average"] == 416.93
    assert digest["top"][0] == {"rank": 1, "name": "刘家兴", "class": "九年级9班", "total": 664.0}
    # 缺考的学生不进排名，但仍在「后几名」里以 None 出现时会被过滤掉。
    assert all(row["name"] != "王一冉" for row in digest["top"])

    # 分数段：低于低分线 468 / 及格 546 / 优秀 702
    assert [row["count"] for row in digest["distribution"]] == [0, 0, 3, 0]

    facts = report_mod._facts_text(digest)
    assert "416.93" in facts
    assert "分数段人数" in facts
    assert "九年级9班" in facts
    assert "陈建昊" in facts


def test_report_is_saved_next_to_its_exam_and_reloads(store, monkeypatch):
    monkeypatch.setattr(report_mod, "_call_model", lambda prompt: "## 成绩概览\n- 均分 416.93")
    out = report_mod.generate(store, "exam-1")

    assert out["ok"] is True
    assert out["markdown"].startswith("## 成绩概览")
    path = store.base / "reports" / "exam-1.json"
    assert path.is_file()
    assert json.loads(path.read_text(encoding="utf-8"))["markdown"] == out["markdown"]

    loaded = report_mod.load(store, "exam-1")
    assert loaded["markdown"] == out["markdown"]
    assert loaded["generated_at"]


def test_a_failed_generation_keeps_the_previous_report(store, monkeypatch):
    monkeypatch.setattr(report_mod, "_call_model", lambda prompt: "## 旧的报告\n- 均分 400")
    report_mod.generate(store, "exam-1")

    # The model fails: the answer says so, the stored report must survive.
    monkeypatch.setattr(report_mod, "_call_model", lambda prompt: "")
    out = report_mod.generate(store, "exam-1")
    assert out["ok"] is False
    assert out["markdown"] == ""
    assert report_mod.load(store, "exam-1")["markdown"].startswith("## 旧的报告")


def test_bad_exam_ids_are_refused(store, monkeypatch):
    monkeypatch.setattr(report_mod, "_call_model", lambda prompt: "## x")
    with pytest.raises(ValueError):
        report_mod.generate(store, "../../etc/passwd")


def _call(handler, method, workspace, *, payload=None, query=None):
    raw = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    with patch.object(teaching_api, "_require_auth"), \
         patch.object(teaching_api.web, "header"), \
         patch.object(teaching_api.web, "data", return_value=raw), \
         patch.object(teaching_api.web, "input",
                      return_value=SimpleNamespace(**(query or {}))), \
         patch.object(teaching_api, "_get_workspace_root",
                      return_value=str(workspace)):
        return json.loads(getattr(TeachingReportHandler(), method)())


def test_the_route_saves_then_returns_the_report(tmp_path, monkeypatch):
    workspace = tmp_path
    store = teaching_api._store("")
    store.save_profile(name="孙老师")

    # Nothing generated yet: the page must get report=None, not an error.
    first = _call(TeachingReportHandler, "GET", workspace, query={"exam_id": "exam-1", "agent_id": ""})
    assert first["status"] == "success"
    assert first["report"] is None

    # The handler builds its own store instance, so patch the class.
    monkeypatch.setattr(type(store), "analysis", lambda self, exam_id, class_id=None: ANALYSIS)
    monkeypatch.setattr(report_mod, "_call_model", lambda prompt: "## 成绩概览\n- 均分 416.93")
    made = _call(TeachingReportHandler, "POST", workspace, payload={"exam_id": "exam-1", "agent_id": ""})
    assert made["status"] == "success"
    assert made["report"]["markdown"].startswith("## 成绩概览")

    again = _call(TeachingReportHandler, "GET", workspace, query={"exam_id": "exam-1", "agent_id": ""})
    assert again["report"]["markdown"] == made["report"]["markdown"]
