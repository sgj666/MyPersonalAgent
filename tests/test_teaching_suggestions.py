"""The AI drawer's per-page suggestions: fallback, cache and the handler shape.

Every test replaces ``suggest_from_model``: these pin the deterministic
three-line fallback, the day's cache and the data-aware summaries, not a
provider.
"""

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.teaching import TeachingStore
from agent.teaching import suggestions as suggestions_mod
from channel.web.api import teaching as teaching_api
from channel.web.api.teaching import TeachingSuggestionsHandler


def _store(tmp_path):
    return TeachingStore(tmp_path / "teaching")


def _seed(store):
    first = store.create_class("七年级(1)班", grade="七年级", subject="英语")
    second = store.create_class("八年级(2)班", grade="八年级", subject="英语")
    one = store.create_student(first["id"], "01", "张一", gender="男")
    two = store.create_student(first["id"], "02", "李二", gender="女")
    store.create_student(second["id"], "01", "王三", gender="男")
    store.create_student(second["id"], "02", "赵四", gender="女")

    store.save_timetable(
        periods=[
            {"index": 1, "start": "08:00", "end": "08:45"},
            {"index": 2, "start": "09:00", "end": "09:45"},
        ],
        slots=[
            {"class_id": first["id"], "weekday": 1, "period": 1,
             "subject": "英语", "mine": True},
            {"class_id": second["id"], "weekday": 5, "period": 2,
             "subject": "英语", "mine": False},
        ],
    )
    store.create_progress(first["id"], "Unit 1 词汇", planned_periods=2,
                          taught_periods=2, order=1)
    store.create_progress(first["id"], "Unit 3 阅读", planned_periods=3,
                          taught_periods=0, order=2)

    homework = store.create_homework(
        [first["id"]], "Unit 3 单词抄写", "practice", "2026-11-12")
    store.save_homework_records(homework["id"], {
        one["id"]: "submitted",
        two["id"]: "missing",
    })

    exam = store.create_exam(
        "期中", [first["id"]], 100, "2026-11-02", subject="英语",
        items=[{"key": "A", "label": "词汇", "full": 100}],
    )
    store.save_scores(exam["id"], {
        one["id"]: {"A": 90},
        two["id"]: {"A": 50},
    })
    return first, second


def _call(handler, method, workspace, *, query=None):
    from unittest.mock import patch as _patch

    with _patch.object(teaching_api, "_require_auth"), \
         _patch.object(teaching_api.web, "header"), \
         _patch.object(teaching_api.web, "data", return_value=b""), \
         _patch.object(teaching_api.web, "input",
                      return_value=SimpleNamespace(**(query or {}))), \
         _patch.object(teaching_api, "_get_workspace_root",
                      return_value=str(workspace)):
        return json.loads(getattr(handler(), method)())


@pytest.mark.parametrize("page", suggestions_mod.PAGES)
def test_fallback_is_three_data_aware_pills(tmp_path, page):
    store = _store(tmp_path)
    _seed(store)

    with patch.object(suggestions_mod, "suggest_from_model", return_value=""):
        result = suggestions_mod.suggest(store, page)

    assert result["page"] == page
    assert result["cached"] is False
    assert len(result["items"]) == 3
    assert all(0 < len(item) <= suggestions_mod.MAX_ITEM_CHARS
               for item in result["items"])
    assert len(set(result["items"])) == 3

    joined = "\n".join(result["items"])
    if page == "classes":
        assert "核对2个班的4人" in result["items"]
    elif page == "timetable":
        assert "检查我的1节课是否冲突" in result["items"]
    elif page == "progress":
        assert "Unit 3" in joined
    elif page == "homework":
        assert "提醒1人" in joined
    else:
        assert "期中" in joined and "70" in joined

    cached = json.loads(
        (tmp_path / "teaching" / "suggestions.json").read_text(encoding="utf-8"))
    assert cached["date"] == date.today().isoformat()
    assert cached[page] == result["items"]


def test_cache_is_per_day_and_per_page(tmp_path):
    store = _store(tmp_path)
    _seed(store)
    calls = []

    def fake(page, summary):
        calls.append(page)
        assert summary
        return json.dumps(["看看班级名单", "补全学生学号", "安排本周讲评"])

    with patch.object(suggestions_mod, "suggest_from_model", side_effect=fake):
        first = suggestions_mod.suggest(store, "classes")
        other = suggestions_mod.suggest(store, "scores")
        again = suggestions_mod.suggest(store, "classes")

    assert first["cached"] is False
    assert first["items"] == ["看看班级名单", "补全学生学号", "安排本周讲评"]
    assert other["cached"] is False
    assert again["cached"] is True
    assert again["items"] == first["items"]
    assert calls == ["classes", "scores"]

    doc = json.loads(
        (tmp_path / "teaching" / "suggestions.json").read_text(encoding="utf-8"))
    assert doc["classes"] == first["items"]
    assert doc["scores"] == other["items"]


def test_model_output_is_cut_to_three_short_pills(tmp_path):
    store = _store(tmp_path)
    _seed(store)
    payload = "```json\n" + json.dumps([
        "看看七年级(1)班的名单",
        "给落后的班级补上三节课时",
        "分析这次期中考试的低分题",
        "第四条不应该出现",
    ], ensure_ascii=False) + "\n```"

    with patch.object(suggestions_mod, "suggest_from_model", return_value=payload):
        result = suggestions_mod.suggest(store, "classes")

    assert len(result["items"]) == 3
    assert all(len(item) <= suggestions_mod.MAX_ITEM_CHARS for item in result["items"])
    assert "第四条" not in "".join(result["items"])


def test_unknown_page_is_a_bad_request(tmp_path):
    store = _store(tmp_path)

    with pytest.raises(ValueError, match="invalid page"):
        suggestions_mod.suggest(store, "settings")

    workspace = tmp_path / "workspace"
    with patch.object(suggestions_mod, "suggest_from_model", return_value=""):
        ok = _call(TeachingSuggestionsHandler, "GET", workspace,
                   query={"page": "classes", "agent_id": ""})
    assert ok["status"] == "success"
    assert len(ok["items"]) == 3

    bad = _call(TeachingSuggestionsHandler, "GET", workspace,
                query={"page": "settings", "agent_id": ""})
    assert bad["status"] == "error"
    assert bad["code"] == "bad_request"

    missing = _call(TeachingSuggestionsHandler, "GET", workspace,
                    query={"page": "", "agent_id": ""})
    assert missing["code"] == "bad_request"
