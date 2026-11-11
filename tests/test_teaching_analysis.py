"""Exam analysis: hand-computed rates, boundaries and trends."""

import statistics

import pytest

from agent.teaching import TeachingStore

ITEMS = [
    {"key": "A", "label": "词汇", "full": 60},
    {"key": "B", "label": "阅读", "full": 40},
]


def _scores(store, exam_id, rows):
    store.save_scores(exam_id, {
        student["id"]: values for student, values in rows
    })


def _fixture(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    first = store.create_class(name="高一(1)班")
    second = store.create_class(name="高一(2)班")
    exam = store.create_exam(
        name="期中", class_ids=[first["id"], second["id"]], full_score=100,
        date="2026-11-02", subject="英语", items=ITEMS)

    students = [
        store.create_student(first["id"], no="001", name="甲"),
        store.create_student(first["id"], no="002", name="乙"),
        store.create_student(first["id"], no="003", name="丙"),
        store.create_student(first["id"], no="004", name="丁"),
        store.create_student(first["id"], no="005", name="戊"),  # 缺考
        store.create_student(second["id"], no="001", name="己"),
        store.create_student(second["id"], no="002", name="庚"),
        store.create_student(second["id"], no="003", name="辛"),
    ]
    _scores(store, exam["id"], [
        (students[0], {"A": 50, "B": 40}),   # 90
        (students[1], {"A": 45, "B": 30}),   # 75
        (students[2], {"A": 40, "B": 20}),   # 60
        (students[3], {"A": 30, "B": 10}),   # 40
        (students[5], {"A": 55, "B": 35}),   # 90
        (students[6], {"A": 50, "B": 35}),   # 85
        (students[7], {"A": 20, "B": 20}),   # 40
    ])
    return store, first, second, exam, students


def test_summary_excludes_the_absent_student(tmp_path):
    store, first, second, exam, _ = _fixture(tmp_path)

    analysis = store.analysis(exam["id"])
    summary = analysis["summary"]

    assert summary["students"] == 8
    assert summary["scored"] == 7
    assert summary["absent"] == 1
    totals = [90, 75, 60, 40, 90, 85, 40]
    assert summary["average"] == round(statistics.fmean(totals), 2) == 68.57
    assert summary["pass_rate"] == 71.43
    assert summary["excellent_rate"] == 42.86
    assert summary["low_rate"] == 0.0
    assert summary["stddev"] == round(statistics.pstdev(totals), 2)
    assert (summary["max"], summary["min"]) == (90, 40)
    assert summary["pass_line"] == 60.0
    assert summary["excellent_line"] == 85.0
    assert summary["low_line"] == 40.0


def test_parallel_classes_are_compared_on_the_same_scale(tmp_path):
    store, first, second, exam, _ = _fixture(tmp_path)

    by_class = {row["class_id"]: row for row in store.analysis(exam["id"])["by_class"]}

    one = by_class[first["id"]]
    assert one["class_name"] == "高一(1)班"
    assert (one["students"], one["scored"], one["absent"]) == (5, 4, 1)
    assert one["average"] == 66.25
    assert one["pass_rate"] == 75.0
    assert one["excellent_rate"] == 25.0
    assert one["low_rate"] == 0.0
    assert one["stddev"] == 18.5
    assert (one["max"], one["min"]) == (90, 40)
    # 缺考 is not a zero: the class of 5 is averaged over the 4 who sat it.

    two = by_class[second["id"]]
    assert two["average"] == 71.67
    assert two["pass_rate"] == 66.67
    assert two["excellent_rate"] == 66.67
    assert two["stddev"] == 22.48
    assert two["absent"] == 0


def test_item_score_rate_math(tmp_path):
    store, first, second, exam, _ = _fixture(tmp_path)

    analysis = store.analysis(exam["id"])
    items = {item["key"]: item for item in analysis["items"]}
    # 词汇: 50+45+40+30+55+50+20 = 290 over 7 papers.
    assert items["A"]["average"] == 41.43
    assert items["A"]["rate"] == 69.05
    assert items["A"]["scored"] == 7
    assert items["A"]["absent"] == 1
    # 阅读: 40+30+20+10+35+35+20 = 190 over 7 papers.
    assert items["B"]["average"] == 27.14
    assert items["B"]["rate"] == 67.86

    scoped = store.analysis(exam["id"], class_id=first["id"])
    scoped_items = {item["key"]: item for item in scoped["items"]}
    assert scoped_items["A"]["average"] == 41.25     # 165 / 4
    assert scoped_items["A"]["rate"] == 68.75        # 41.25 / 60
    assert scoped_items["B"]["average"] == 25.0      # 100 / 4
    assert scoped_items["B"]["rate"] == 62.5         # 25 / 40
    assert [row["class_id"] for row in scoped_items["A"]["by_class"]] == [first["id"]]
    assert scoped_items["A"]["by_class"][0]["absent"] == 1

    per_class = {row["class_id"]: row
                 for row in items["A"]["by_class"]}
    assert per_class[first["id"]]["rate"] == 68.75
    assert per_class[second["id"]]["average"] == 41.67   # 125 / 3
    assert per_class[second["id"]]["rate"] == 69.44      # 41.666.. / 60


def test_critical_students_sit_on_the_band_boundaries(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    klass = store.create_class(name="一班")
    exam = store.create_exam(
        name="周测", class_ids=[klass["id"]], full_score=100,
        date="2026-11-06", subject="英语",
        items=[{"key": "A", "label": "全卷", "full": 100}])

    # 60 = pass line, 85 = excellent line; the band is [line-5, line).
    totals = {"001": 54, "002": 55, "003": 60, "004": 79,
              "005": 80, "006": 84.99, "007": 85}
    scores = {}
    for no, total in totals.items():
        student = store.create_student(klass["id"], no=no, name=f"学生{no}")
        scores[student["id"]] = {"A": total}
    store.save_scores(exam["id"], scores)

    critical = store.analysis(exam["id"])["critical"]
    assert [(entry["no"], entry["total"], entry["kind"], entry["gap"]) for entry in critical] == [
        ("006", 84.99, "excellent", 0.01),
        ("005", 80, "excellent", 5.0),
        ("002", 55, "pass", 5.0),
    ]


def test_trend_uses_the_same_subject_and_skips_other_subjects(tmp_path):
    store = TeachingStore(tmp_path / "teaching")
    klass = store.create_class(name="一班")
    student = store.create_student(klass["id"], no="001", name="甲")
    classmate = store.create_student(klass["id"], no="002", name="乙")

    first_exam = store.create_exam(
        name="月考", class_ids=[klass["id"]], full_score=100,
        date="2026-09-01", subject="英语")
    second_exam = store.create_exam(
        name="期中", class_ids=[klass["id"]], full_score=100,
        date="2026-10-01", subject="英语", items=ITEMS)
    math_exam = store.create_exam(
        name="数学周测", class_ids=[klass["id"]], full_score=100,
        date="2026-11-01", subject="数学")

    store.save_scores(first_exam["id"], {student["id"]: {"total": 75}})
    store.save_scores(second_exam["id"], {student["id"]: {"A": 50, "B": 30}})
    store.save_scores(math_exam["id"], {student["id"]: {"total": 95}})

    analysis = store.analysis(second_exam["id"])
    rows = {row["student_id"]: row for row in analysis["students"]}
    trend = rows[student["id"]]
    assert [entry["exam_id"] for entry in trend["exams"]] == [
        first_exam["id"], second_exam["id"],
    ]
    assert trend["trend"] == [75, 80]
    assert trend["total"] == 80
    # 乙 has no scores at all: absent for this exam, and absent in the trend.
    assert rows[classmate["id"]]["absent"] is True
    assert rows[classmate["id"]]["trend"] == [None, None]


def test_unknown_exam_or_class_is_an_error(tmp_path):
    store, first, second, exam, _ = _fixture(tmp_path)
    other = store.create_class(name="三班")

    with pytest.raises(KeyError):
        store.analysis("missing")
    with pytest.raises(KeyError):
        store.analysis(exam["id"], class_id=other["id"])
    with pytest.raises(KeyError):
        store.analysis(exam["id"], class_id="missing")
