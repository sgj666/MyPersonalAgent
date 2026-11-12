"""Insight API contracts, recorded-data maths and non-destructive imports."""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agent.teaching import TeachingStore
from agent.teaching.insights import facts, import_progress, recent
from channel.web.api import teaching_insights as api


def call(handler, workspace, *, payload=None, query=None):
    defaults = {"agent_id": "", "class_id": "", "unit": "", "kind": "", "limit": "5"}
    defaults.update(query or {})
    with patch.object(api, "_require_auth") as auth, \
         patch.object(api.web, "header"), \
         patch.object(api.web, "input", return_value=SimpleNamespace(**defaults)), \
         patch.object(api.web, "data", return_value=json.dumps(payload).encode()), \
         patch.object(api, "_get_workspace_root", return_value=str(workspace)) as root:
        method = handler().GET if payload is None else handler().POST
        response = json.loads(method())
        auth.assert_called_once_with()
        root.assert_called_once_with(agent_id=(payload or defaults).get("agent_id") or None)
        return response


@pytest.fixture
def populated(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    klass = store.create_class("七(1)班")
    roster = [store.create_student(klass["id"], str(i), name)
              for i, name in enumerate(("张三", "李四", "王五"), 1)]
    for week, taught in enumerate((2, 2, 0, 0), 1):
        store.create_progress(klass["id"], f"Unit {week} 听说", planned_periods=2,
                              taught_periods=taught, order=week)
    hw = store.create_homework([klass["id"]], "UNIT 1 练习", "practice", "2026-11-12")
    store.save_homework_records(hw["id"], {roster[0]["id"]: "submitted",
                                          roster[1]["id"]: "missing"})
    another = store.create_homework([klass["id"]], "Unit 2 练习", "practice", "2026-11-13")
    store.save_homework_records(another["id"], {roster[0]["id"]: "excellent",
                                               roster[1]["id"]: "fix"})
    exam = store.create_exam("单元测", [klass["id"]], 100, "2026-11-12", items=[
        {"key": "A", "label": "词汇", "full": 20},
        {"key": "B", "label": "阅读", "full": 40},
        {"key": "C", "label": "写作", "full": 40},
    ])
    store.save_scores(exam["id"], {
        roster[0]["id"]: {"A": 20, "B": 8, "C": 20},
        roster[1]["id"]: {"A": 16, "B": 16, "C": 28},
        roster[2]["id"]: {"A": 18, "B": 12, "C": 24},
    })
    return store, klass, roster, exam


def test_empty_workspace(tmp_path):
    assert call(api.TeachingFactsHandler, tmp_path) == {
        "status": "success", "facts": [], "stats": {}}
    assert call(api.TeachingRecentHandler, tmp_path) == {"status": "success", "items": []}
    error = call(api.TeachingProgressImportHandler, tmp_path, payload={
        "class_ids": ["missing"], "weeks": [{"week": 1, "topic": "听说", "periods": 2}]})
    assert error["status"] == "error"
    assert error["code"] == "bad_request"
    assert "班级不存在" in error["message"]
    assert not (tmp_path / "teaching" / "progress.json").exists()


def test_facts_math_sort_and_unit_filter(tmp_path, populated):
    store, klass, _, _ = populated
    response = call(api.TeachingFactsHandler, tmp_path, query={"class_id": klass["id"]})
    assert response["status"] == "success"
    assert response["stats"] == {
        "students": 3, "planned": 8, "taught": 4, "homework_missing": 2, "exam_avg": 54,
        "weak_skills": [{"name": "阅读", "rate": 0.3}, {"name": "写作", "rate": 0.6},
                        {"name": "词汇", "rate": 0.9}],
    }
    assert response["facts"][0] == {
        "key": "progress_gap", "label": "教学进度", "value": "落后 4 课时", "detail": "计划 8，已授 4"}
    assert next(row for row in response["facts"] if row["key"] == "exam_weak")["value"].startswith("阅读 30%")
    filtered = facts(store, klass["id"], "uNiT 1")
    assert filtered["stats"]["planned"] == filtered["stats"]["taught"] == 2
    assert filtered["stats"]["homework_missing"] == 2
    unmatched = facts(store, klass["id"], "unknown")
    assert "planned" not in unmatched["stats"]
    assert "homework_missing" not in unmatched["stats"]
    assert unmatched["stats"]["exam_avg"] == 54


def test_absences_and_pool_item_keys(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    klass = store.create_class("一班")
    student = store.create_student(klass["id"], "1", "张三")
    assert facts(store, klass["id"]) == {"facts": [], "stats": {"students": 1}}
    first = store.create_exam("一测", [klass["id"]], 20, "2026-11-01",
                              items=[{"key": "A", "label": "阅读", "full": 20}])
    store.save_scores(first["id"], {student["id"]: {"A": None}})
    assert "exam_avg" not in facts(store)["stats"]
    assert "weak_skills" not in facts(store)["stats"]
    store.save_scores(first["id"], {student["id"]: {"A": 0}})
    second = store.create_exam("二测", [klass["id"]], 80, "2026-11-02",
                               items=[{"key": "A", "label": "阅读", "full": 80}])
    store.save_scores(second["id"], {student["id"]: {"A": 40}})
    assert facts(store)["stats"]["exam_avg"] == 20
    assert facts(store)["stats"]["weak_skills"] == [{"name": "阅读", "rate": 0.4}]
    other = store.create_class("二班")
    outsider = store.create_student(other["id"], "1", "李四")
    shared = store.create_exam("联考", [klass["id"], other["id"]], 100, "2026-11-03")
    store.save_scores(shared["id"], {outsider["id"]: {"total": 100}})
    assert facts(store, klass["id"])["stats"]["exam_avg"] == 20
    assert facts(store, "unknown") == {"facts": [], "stats": {}}


def test_import_idempotent_and_taught_immutable(tmp_path, populated):
    store, klass, _, _ = populated
    weeks = [{"week": week, "unit": f"Unit {week}", "topic": "听说", "periods": 5,
              "goal": "交流", "assess": "口述"} for week in range(1, 6)]
    payload = {"class_ids": [klass["id"]], "weeks": weeks}
    before = store.list_progress()
    first = call(api.TeachingProgressImportHandler, tmp_path, payload=payload)
    assert (first["created"], first["skipped"]) == (1, 4)
    assert len(first["conflicts"]) == 2
    after = store.list_progress()
    assert after[:4] == before
    assert [row["taught_periods"] for row in after] == [2, 2, 0, 0, 0]
    second = call(api.TeachingProgressImportHandler, tmp_path, payload=payload)
    assert (second["created"], second["skipped"]) == (0, 5)
    assert store.list_progress() == after
    assert [row["taught_periods"] for row in store.list_progress()] == [2, 2, 0, 0, 0]
    overwrite = call(api.TeachingProgressImportHandler, tmp_path,
                     payload={**payload, "overwrite": True})
    assert (overwrite["created"], overwrite["skipped"]) == (0, 3)
    changed = store.list_progress()
    assert changed[:2] == before[:2]
    assert [row["taught_periods"] for row in changed] == [2, 2, 0, 0, 0]
    assert [row["planned_periods"] for row in changed] == [2, 2, 5, 5, 5]
    for old, new in zip(after[2:4], changed[2:4]):
        assert {k: v for k, v in old.items() if k not in ("updated_at", "planned_periods")} == {
            k: v for k, v in new.items() if k not in ("updated_at", "planned_periods")}


def test_import_matches_topic_validates_before_writing_and_multiple_classes(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    classes = [store.create_class(name)["id"] for name in ("一班", "二班")]
    original = store.create_progress(classes[0], "Unit 1 听说", order=9, planned_periods=1)
    weeks = [{"week": 1, "unit": "Unit 1", "topic": "听说", "periods": 2}]
    report = import_progress(store, classes, weeks)
    assert report == {"created": 1, "skipped": 1, "conflicts": []}
    assert store.list_progress(classes[0]) == [original]
    before = (tmp_path / "teaching" / "progress.json").read_bytes()
    with pytest.raises(ValueError, match="班级不存在"):
        import_progress(store, classes + ["unknown"], weeks, True)
    with pytest.raises(ValueError, match="periods"):
        import_progress(store, classes, weeks + [{"week": 2, "topic": "bad", "periods": -1}])
    assert (tmp_path / "teaching" / "progress.json").read_bytes() == before


def test_concurrent_import_does_not_duplicate(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    klass = store.create_class("一班")
    weeks = [{"week": week, "topic": f"第 {week} 课", "periods": 2} for week in range(1, 6)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(lambda _: import_progress(store, [klass["id"]], weeks), range(2)))
    assert sorted(row["created"] for row in reports) == [0, 5]
    assert sorted(row["skipped"] for row in reports) == [0, 5]
    assert len(store.list_progress()) == 5


def test_recent_drafts_mtime_metadata_and_workspace_boundary(tmp_path):
    for kind, slug, modified, draft in [
        ("deck", "older", 100, {"meta": {"title": "词汇课", "class_ids": ["c1"]}}),
        ("card", "newer", 200, {"meta": {"title": "练习", "class_ids": ["c2"]}}),
        ("advice", "latest", 300, {"title": "建议", "class_ids": ["c3"]}),
    ]:
        directory = tmp_path / "artifacts" / "教学工具" / kind
        directory.mkdir(parents=True)
        path = directory / f"{slug}.json"
        path.write_text(json.dumps(draft), encoding="utf-8")
        os.utime(path, (modified, modified))
    deck = tmp_path / "artifacts" / "教学工具" / "deck"
    (deck / "broken.json").write_text("{", encoding="utf-8")
    (deck / "array.json").write_text("[]", encoding="utf-8")
    outside = tmp_path.parent / "secret.json"
    outside.write_text('{"title":"secret"}', encoding="utf-8")
    (deck / "escape.json").symlink_to(outside)
    response = call(api.TeachingRecentHandler, tmp_path, query={"limit": "2"})
    assert [row["slug"] for row in response["items"]] == ["latest", "newer"]
    assert set(response["items"][0]) == {"slug", "title", "when", "rel", "kind", "class_ids"}
    assert response["items"][0]["class_ids"] == ["c3"]
    only_deck = recent(tmp_path, "deck")["items"]
    assert len(only_deck) == 1
    assert only_deck[0] == {"slug": "older", "title": "词汇课", "when": "1970-01-01T00:01:40+00:00",
                             "rel": "artifacts/教学工具/deck/older.json", "kind": "deck", "class_ids": ["c1"]}
    assert recent(tmp_path, "plan")["items"] == []
    assert call(api.TeachingRecentHandler, tmp_path, query={"kind": "../"})["status"] == "error"
    assert call(api.TeachingRecentHandler, tmp_path, query={"limit": "bad"})["status"] == "error"


def test_agent_scoping_authentication_and_routes(tmp_path):
    for handler in (api.TeachingFactsHandler, api.TeachingRecentHandler):
        assert call(handler, tmp_path, query={"agent_id": "teacher-b"})["status"] == "success"
        with patch.object(api, "_require_auth", side_effect=PermissionError), \
             patch.object(api, "_get_workspace_root") as root:
            with pytest.raises(PermissionError):
                handler().GET()
            root.assert_not_called()
    error = call(api.TeachingProgressImportHandler, tmp_path, payload={"agent_id": "teacher-b"})
    assert error["status"] == "error"
    assert all(name in api.__all__ for _, name in api.TEACHING_INSIGHTS_URLS)
    assert {url for url, _ in api.TEACHING_INSIGHTS_URLS} == {
        "/api/teaching/facts", "/api/teaching/progress/import", "/api/teaching/recent"}
