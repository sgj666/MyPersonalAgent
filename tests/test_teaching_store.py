"""Teaching store: validation, isolation, cascades and damaged files."""

import json
from unittest.mock import patch

import pytest

from agent.teaching import TeachingStore


def _store(tmp_path, name="teaching"):
    return TeachingStore(tmp_path / name)


def _class(store, name="高一(1)班"):
    return store.create_class(name=name, grade="高一", subject="英语", room="101")


def _student(store, class_id, no="001", name="张三"):
    return store.create_student(class_id, no=no, name=name)


EXAM_ITEMS = [
    {"key": "A", "label": "词汇", "full": 60},
    {"key": "B", "label": "阅读", "full": 40},
]


def test_class_lifecycle_and_validation(tmp_path):
    store = _store(tmp_path)
    assert store.list_classes() == []

    created = _class(store)
    assert store.get_class(created["id"])["name"] == "高一(1)班"
    assert [entry["id"] for entry in store.list_classes()] == [created["id"]]

    renamed = store.update_class(created["id"], name="高一(2)班", room="102")
    assert renamed["name"] == "高一(2)班"
    assert renamed["room"] == "102"

    with pytest.raises(ValueError):
        store.create_class(name="  ")
    with pytest.raises(ValueError):
        store.create_class(name="长" * 41)
    with pytest.raises(ValueError):
        store.update_class(created["id"], colour="red")
    with pytest.raises(ValueError):
        store.update_class(created["id"])
    with pytest.raises(KeyError):
        store.get_class("missing")
    with pytest.raises(KeyError):
        store.update_class("missing", name="x")
    with pytest.raises(KeyError):
        store.delete_class("missing")


def test_two_roots_are_isolated_and_default_base_follows_the_tenant(tmp_path):
    first = _store(tmp_path / "one")
    second = _store(tmp_path / "two")
    created = _class(first)

    assert [entry["id"] for entry in first.list_classes()] == [created["id"]]
    assert second.list_classes() == []
    with pytest.raises(KeyError):
        second.get_class(created["id"])

    # With no base, the store resolves <state_root>/teaching on every call:
    # two tenants patched one after the other see two different data sets.
    with patch("common.state_dir.state_root", return_value=tmp_path / "tenant-a"):
        tenant_a = TeachingStore()
        assert tenant_a.base == tmp_path / "tenant-a" / "teaching"
        tenant_a.create_class(name="A 班")
        # Resolved per call, so this same object follows the ambient tenant.
        assert [entry["name"] for entry in tenant_a.list_classes()] == ["A 班"]
    with patch("common.state_dir.state_root", return_value=tmp_path / "tenant-b"):
        tenant_b = TeachingStore()
        assert tenant_b.base == tmp_path / "tenant-b" / "teaching"
        assert tenant_b.list_classes() == []
    with patch("common.state_dir.state_root", return_value=tmp_path / "tenant-a"):
        assert [entry["name"] for entry in TeachingStore().list_classes()] == ["A 班"]
    assert (tmp_path / "tenant-b" / "teaching").exists() is False


def test_no_is_unique_per_class_not_globally(tmp_path):
    store = _store(tmp_path)
    first = _class(store, "一班")
    second = _class(store, "二班")

    student = _student(store, first["id"], no="001", name="张三")
    _student(store, first["id"], no="002", name="王五")
    _student(store, second["id"], no="001", name="李四")
    assert len(store.list_students(class_id=first["id"])) == 2

    with pytest.raises(ValueError):
        _student(store, first["id"], no="001", name="王五")
    with pytest.raises(ValueError):
        store.update_student(student["id"], no="002")
    # An update that keeps the same 学号 is not a collision with itself.
    assert store.update_student(student["id"], no="001", name="张三丰")["name"] == "张三丰"
    with pytest.raises(ValueError):
        store.create_student(first["id"], no=" ", name="无号")
    with pytest.raises(ValueError):
        store.create_student(first["id"], no="009", name=" ")
    with pytest.raises(KeyError):
        store.create_student("missing", no="009", name="x")


def test_import_upserts_by_no_and_reports_bad_rows(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)

    report = store.import_students(klass["id"], [
        {"学号": "001", "姓名": "张三", "性别": "男", "标签": "组长,英语"},
        {"学号": "002", "姓名": "李四"},
        {"姓名": "没有学号"},
    ])
    assert report["imported"] == 2
    assert report["updated"] == 0
    assert report["failed"] == [{"row": 3, "reason": "no is required"}]

    roster = store.list_students(class_id=klass["id"])
    assert [student["no"] for student in roster] == ["001", "002"]
    assert roster[0]["tags"] == ["组长", "英语"]

    report = store.import_students(klass["id"], [
        {"学号": "001", "姓名": "张三", "备注": "转来"},
    ])
    assert (report["imported"], report["updated"]) == (0, 1)
    assert store.list_students(class_id=klass["id"])[0]["note"] == "转来"
    assert len(store.list_students()) == 2


def test_timetable_is_validated_as_a_whole(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)

    saved = store.save_timetable(
        periods=[{"index": 1, "start": "08:00", "end": "08:45"}],
        slots=[
            {"class_id": klass["id"], "weekday": 1, "period": 1,
             "subject": "英语", "kind": "regular"},
        ],
        overrides=[
            {"date": "2026-11-13", "period": 1, "class_id": klass["id"],
             "subject": "英语", "kind": "regular", "state": "cancelled"},
        ],
    )
    assert saved["slots"][0]["id"]
    assert saved["overrides"][0]["state"] == "cancelled"

    with pytest.raises(ValueError):
        store.save_timetable(slots=[
            {"class_id": klass["id"], "weekday": 8, "period": 1},
        ])
    with pytest.raises(ValueError):
        store.save_timetable(slots=[
            {"class_id": klass["id"], "weekday": 1, "period": 0},
        ])
    with pytest.raises(KeyError):
        store.save_timetable(slots=[
            {"class_id": "missing", "weekday": 1, "period": 1},
        ])
    with pytest.raises(ValueError):
        store.save_timetable(overrides=[
            {"date": "2026-11-13", "period": 1, "class_id": klass["id"],
             "state": "exploded"},
        ])
    with pytest.raises(ValueError):
        store.save_timetable(overrides=[
            {"date": "2026-02-30", "period": 1, "class_id": klass["id"]},
        ])

    # A group left out of PUT is untouched, not wiped.
    after = store.save_timetable(slots=[])
    assert after["periods"][0]["index"] == 1
    assert after["overrides"][0]["state"] == "cancelled"


def test_exam_requires_positive_full_and_unique_items(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)

    exam = store.create_exam(name="期中", class_ids=[klass["id"]], full_score=100,
                             date="2026-11-02", subject="英语", items=EXAM_ITEMS)
    assert exam["full_score"] == 100
    assert [item["key"] for item in store.get_exam(exam["id"])["items"]] == ["A", "B"]

    with pytest.raises(ValueError):
        store.create_exam(name="x", class_ids=[klass["id"]], full_score=0,
                          date="2026-11-02")
    with pytest.raises(ValueError):
        store.create_exam(name="x", class_ids=[klass["id"]], full_score=100,
                          date="2026-11-02",
                          items=[{"key": "A", "full": 10}, {"key": "A", "full": 20}])
    with pytest.raises(ValueError):
        store.create_exam(name="x", class_ids=[klass["id"]], full_score=100,
                          date="2026-11-02", items=[{"key": "A", "full": 0}])
    with pytest.raises(ValueError):
        store.create_exam(name="x", class_ids=[klass["id"]], full_score=100,
                          date="2026-13-40")
    with pytest.raises(KeyError):
        store.create_exam(name="x", class_ids=["missing"], full_score=100,
                          date="2026-11-02")
    with pytest.raises(KeyError):
        store.get_exam("missing")


def test_scores_validate_against_item_full_and_keep_absence(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)
    exam = store.create_exam(name="期中", class_ids=[klass["id"]],
                             full_score=100, date="2026-11-02", items=EXAM_ITEMS)
    alice = _student(store, klass["id"], no="001", name="张三")
    bob = _student(store, klass["id"], no="002", name="李四")

    scores_path = tmp_path / "teaching" / "scores.json"
    with pytest.raises(ValueError):
        store.save_scores(exam["id"], {
            alice["id"]: {"A": 61, "B": 10},
        })
    assert not scores_path.exists()

    with pytest.raises(KeyError):
        store.save_scores(exam["id"], {"ghost": {"A": 1}})
    with pytest.raises(ValueError):
        store.save_scores(exam["id"], {alice["id"]: {"Z": 1}})
    with pytest.raises(KeyError):
        store.save_scores("missing", {alice["id"]: {"A": 1}})

    saved = store.save_scores(exam["id"], {
        alice["id"]: {"A": 50, "B": 40},
        bob["id"]: {"A": 45, "B": None},
    })
    assert saved[alice["id"]] == {"total": 90, "items": {"A": 50, "B": 40}}
    assert saved[bob["id"]] == {"total": 45, "items": {"A": 45, "B": None}}
    assert store.get_scores(exam["id"])[bob["id"]]["total"] == 45

    # The whole block is replaced, so an omitted student becomes 缺考.
    store.save_scores(exam["id"], {alice["id"]: {"A": 50, "B": 40}})
    assert bob["id"] not in store.get_scores(exam["id"])


def test_exam_edit_rechecks_recorded_scores(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)
    exam = store.create_exam(name="期中", class_ids=[klass["id"]],
                             full_score=100, date="2026-11-02", items=EXAM_ITEMS)
    alice = _student(store, klass["id"], no="001", name="张三")
    store.save_scores(exam["id"], {alice["id"]: {"A": 60, "B": 40}})

    # Dropping a group prunes its marks; the total follows the surviving ones.
    store.update_exam(exam["id"], items=[{"key": "A", "label": "词汇", "full": 60}])
    assert store.get_scores(exam["id"])[alice["id"]] == {
        "total": 60, "items": {"A": 60},
    }
    # Lowering a group below an existing mark is refused, leaving it alone.
    with pytest.raises(ValueError):
        store.update_exam(exam["id"], items=[{"key": "A", "label": "词汇", "full": 50}])
    assert store.get_exam(exam["id"])["items"][0]["full"] == 60
    assert store.get_scores(exam["id"])[alice["id"]]["items"]["A"] == 60


def test_delete_class_cascades_and_keeps_the_other_class(tmp_path):
    store = _store(tmp_path)
    gone = _class(store, "一班")
    kept = _class(store, "二班")
    gone_student = _student(store, gone["id"], no="001", name="张三")
    kept_student = _student(store, kept["id"], no="001", name="李四")

    store.save_timetable(
        periods=[{"index": 1, "start": "08:00", "end": "08:45"}],
        slots=[
            {"class_id": gone["id"], "weekday": 1, "period": 1},
            {"class_id": kept["id"], "weekday": 2, "period": 1},
        ],
        overrides=[
            {"date": "2026-11-13", "period": 1, "class_id": gone["id"]},
        ],
    )
    store.create_progress(gone["id"], topic="Unit 1", planned_periods=4)
    store.create_progress(kept["id"], topic="Unit 1", planned_periods=4)

    shared = store.create_homework(
        [gone["id"], kept["id"]], title="练习", kind="practice", due="2026-11-12")
    only_gone = store.create_homework(
        [gone["id"]], title="订正", kind="correction", due="2026-11-12")
    store.save_homework_records(shared["id"], {gone_student["id"]: "submitted",
                                               kept_student["id"]: "missing"})
    store.save_homework_records(only_gone["id"], {gone_student["id"]: "fix"})

    shared_exam = store.create_exam(
        name="期中", class_ids=[gone["id"], kept["id"]], full_score=100,
        date="2026-11-02", items=EXAM_ITEMS)
    only_gone_exam = store.create_exam(
        name="小测", class_ids=[gone["id"]], full_score=100,
        date="2026-11-05", items=[{"key": "A", "label": "词汇", "full": 100}])
    store.save_scores(shared_exam["id"], {
        gone_student["id"]: {"A": 50, "B": 40},
        kept_student["id"]: {"A": 55, "B": 35},
    })
    store.save_scores(only_gone_exam["id"], {gone_student["id"]: {"A": 70}})

    result = store.delete_class(gone["id"])
    assert result["removed"] == {
        "students": 1, "slots": 1, "overrides": 1,
        "progress": 1, "homework": 1, "exams": 1,
    }

    assert [entry["name"] for entry in store.list_classes()] == ["二班"]
    assert [student["id"] for student in store.list_students()] == [kept_student["id"]]
    timetable = store.get_timetable()
    assert [slot["class_id"] for slot in timetable["slots"]] == [kept["id"]]
    assert timetable["overrides"] == []
    assert [item["class_id"] for item in store.list_progress()] == [kept["id"]]

    homework = {item["id"]: item for item in store.list_homework()}
    assert set(homework) == {shared["id"]}
    assert homework[shared["id"]]["class_ids"] == [kept["id"]]
    assert store.get_homework_records(shared["id"]) == {kept_student["id"]: "missing"}

    exams = {exam["id"]: exam for exam in store.list_exams()}
    assert set(exams) == {shared_exam["id"]}
    assert exams[shared_exam["id"]]["class_ids"] == [kept["id"]]
    assert set(store.get_scores(shared_exam["id"])) == {kept_student["id"]}
    stored_scores = json.loads((tmp_path / "teaching" / "scores.json").read_text())
    assert only_gone_exam["id"] not in stored_scores["by_exam"]


def test_homework_records_need_real_students_and_states(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)
    student = _student(store, klass["id"])
    homework = store.create_homework(
        [klass["id"]], title="练习", kind="practice", due="2026-11-12")

    with pytest.raises(ValueError):
        store.save_homework_records(homework["id"], {student["id"]: "lost"})
    with pytest.raises(KeyError):
        store.save_homework_records(homework["id"], {"ghost": "submitted"})
    with pytest.raises(KeyError):
        store.save_homework_records("missing", {student["id"]: "submitted"})
    with pytest.raises(ValueError):
        store.create_homework([klass["id"]], title="x", kind="quiz", due="2026-11-12")
    with pytest.raises(ValueError):
        store.create_homework([klass["id"]], title="x", kind="practice",
                              due="2026-02-30")

    store.save_homework_records(homework["id"], {student["id"]: "excellent"})
    assert store.get_homework_records(homework["id"]) == {student["id"]: "excellent"}

    exam = store.create_exam(name="期中", class_ids=[klass["id"]], full_score=100,
                             date="2026-11-02",
                             items=[{"key": "A", "label": "词汇", "full": 100}])
    store.save_scores(exam["id"], {student["id"]: {"A": 80}})

    # Deleting the student drops their state and marks instead of leaving
    # dangling ids behind.
    assert store.delete_student(student["id"]) is True
    assert store.get_homework_records(homework["id"]) == {}
    assert store.get_scores(exam["id"]) == {}


def test_corrupt_file_reads_empty_and_the_next_write_repairs_it(tmp_path):
    store = _store(tmp_path)
    (tmp_path / "teaching").mkdir()
    (tmp_path / "teaching" / "classes.json").write_text("{not json", encoding="utf-8")

    with patch("agent.teaching.store.logger") as logger:
        assert store.list_classes() == []
    assert logger.warning.called

    created = _class(store)
    repaired = json.loads((tmp_path / "teaching" / "classes.json").read_text())
    assert repaired["version"] == 1
    assert repaired["classes"][0]["id"] == created["id"]


def test_unknown_progress_and_homework_ids_raise(tmp_path):
    store = _store(tmp_path)
    klass = _class(store)
    item = store.create_progress(klass["id"], topic="Unit 1", planned_periods=2)

    assert store.update_progress(item["id"], taught_periods=1)["taught_periods"] == 1
    assert store.delete_progress(item["id"]) is True
    with pytest.raises(KeyError):
        store.delete_progress(item["id"])
    with pytest.raises(KeyError):
        store.update_progress("missing", taught_periods=1)
    with pytest.raises(KeyError):
        store.list_progress("missing")
    with pytest.raises(KeyError):
        store.list_students("missing")
    with pytest.raises(KeyError):
        store.list_exams("missing")
    with pytest.raises(KeyError):
        store.delete_exam("missing")
