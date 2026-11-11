"""Exam statistics: one function over plain documents, no I/O.

``TeachingStore.analysis`` loads the exam, roster and score documents and hands
them here, so the maths can be tested on a hand-computed fixture without a
workspace. Every rate is a percentage (0-100, two decimals); every average,
total and deviation is out of two decimals as well.

A student is *absent* (缺考) for an exam when they have no score record or every
item value in it is ``null``. Absent students are excluded from averages,
rates, deviations and maxima; they still count in ``students`` and as
``absent`` so a class comparison is honest about participation.

Pass, excellent and low lines are percentages of the paper's full score. They
are module constants rather than per-class settings: a school that moves a line
changes it here, in one place, and every exam uses the same rule.
"""

from __future__ import annotations

import statistics
from typing import Dict, List, Optional

#: 60% of full score, the default 及格线.
PASS_RATIO = 0.6
#: 85% of full score, the default 优秀线.
EXCELLENT_RATIO = 0.85
#: Below 40% of full score counts as 低分.
LOW_RATIO = 0.4
#: 临界生 band width: within this many points below a line.
CRITICAL_MARGIN = 5.0


def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def student_total(record, item_keys) -> Optional[float]:
    """The student's total for one exam, or ``None`` when they were absent.

    Items are authoritative: a value of ``null`` means that item was not sat
    (缺考), and a total of only the non-null values keeps a partial attendance
    meaningful. An exam without item groups stores its total directly.
    """
    if not isinstance(record, dict):
        return None
    keys = list(item_keys or [])
    if keys:
        items = record.get("items")
        if not isinstance(items, dict):
            return None
        values = [items.get(key) for key in keys]
        present = [value for value in values if _is_number(value)]
        if not present:
            return None
        return round(float(sum(present)), 2)
    total = record.get("total")
    return round(float(total), 2) if _is_number(total) else None


def _percent(hits: int, count: int) -> Optional[float]:
    if not count:
        return None
    return round(hits * 100.0 / count, 2)


def _stats(totals: List[Optional[float]], pass_line: float,
           excellent_line: float, low_line: float) -> dict:
    scored = [total for total in totals if total is not None]
    count = len(scored)
    if not count:
        return {
            "scored": 0,
            "average": None,
            "pass_rate": None,
            "excellent_rate": None,
            "low_rate": None,
            "stddev": None,
            "max": None,
            "min": None,
        }
    return {
        "scored": count,
        "average": round(statistics.fmean(scored), 2),
        "pass_rate": _percent(sum(1 for t in scored if t >= pass_line), count),
        "excellent_rate": _percent(sum(1 for t in scored if t >= excellent_line), count),
        "low_rate": _percent(sum(1 for t in scored if t < low_line), count),
        # Population deviation: the class is the whole population being
        # compared, not a sample drawn from it.
        "stddev": round(statistics.pstdev(scored), 2),
        "max": max(scored),
        "min": min(scored),
    }


def _trend(student: dict, exam: dict, exams: List[dict],
           scores_by_exam: Dict[str, dict]) -> List[dict]:
    """This student's scores across the same subject, oldest first."""
    subject = exam.get("subject") or ""
    series = []
    for other in exams:
        if (other.get("subject") or "") != subject:
            continue
        if student.get("class_id") not in (other.get("class_ids") or []):
            continue
        keys = [item.get("key") for item in other.get("items") or []]
        record = (scores_by_exam.get(other.get("id")) or {}).get(student.get("id"))
        total = student_total(record, keys)
        series.append({
            "exam_id": other.get("id"),
            "name": other.get("name") or "",
            "date": other.get("date") or "",
            "total": total,
            "absent": total is None,
        })
    series.sort(key=lambda entry: (entry["date"], entry["name"], entry["exam_id"] or ""))
    return series


def analyze(exam: dict, classes: List[dict], students: List[dict],
            scores_by_exam: Dict[str, dict], exams: List[dict],
            class_id: Optional[str] = None) -> dict:
    """Statistics for one exam, optionally narrowed to one of its classes.

    ``KeyError`` when the class is not one of the exam's classes: a report for
    a class that never sat the paper would be an empty lie rather than a
    mistake the caller can see.
    """
    full_score = round(float(exam["full_score"]), 2)
    pass_line = round(full_score * PASS_RATIO, 2)
    excellent_line = round(full_score * EXCELLENT_RATIO, 2)
    low_line = round(full_score * LOW_RATIO, 2)

    exam_classes = list(exam.get("class_ids") or [])
    if class_id is not None:
        class_id = str(class_id)
        if class_id not in exam_classes:
            raise KeyError(class_id)
        scope = [class_id]
    else:
        scope = exam_classes

    names = {entry.get("id"): entry.get("name") or "" for entry in classes}
    roster = [student for student in students if student.get("class_id") in scope]
    exam_scores = scores_by_exam.get(exam.get("id")) or {}
    item_keys = [item.get("key") for item in exam.get("items") or []]

    totals = {
        student.get("id"): student_total(exam_scores.get(student.get("id")), item_keys)
        for student in roster
    }

    overall = _stats(list(totals.values()), pass_line, excellent_line, low_line)

    by_class = []
    for entry in scope:
        class_totals = [totals[s.get("id")] for s in roster if s.get("class_id") == entry]
        stats = _stats(class_totals, pass_line, excellent_line, low_line)
        by_class.append({
            "class_id": entry,
            "class_name": names.get(entry, ""),
            "students": len(class_totals),
            "absent": len(class_totals) - stats["scored"],
            **stats,
        })

    items = []
    for item in exam.get("items") or []:
        key = item.get("key")
        full = round(float(item.get("full") or 0), 2)
        class_rows = []
        all_values: List[float] = []
        for entry in scope:
            values = []
            for student in roster:
                if student.get("class_id") != entry:
                    continue
                record = exam_scores.get(student.get("id")) or {}
                raw_items = record.get("items")
                value = raw_items.get(key) if isinstance(raw_items, dict) else None
                if _is_number(value):
                    values.append(float(value))
            all_values.extend(values)
            mean = statistics.fmean(values) if values else None
            class_rows.append({
                "class_id": entry,
                "class_name": names.get(entry, ""),
                # Absent for the item, not for the exam: a student can sit the
                # paper and leave one group blank.
                "scored": len(values),
                "absent": sum(
                    1 for student in roster if student.get("class_id") == entry
                ) - len(values),
                "average": round(mean, 2) if mean is not None else None,
                # Rates come from the unrounded mean; rounding twice would
                # shift a rate by a hundredth for no reason.
                "rate": round(mean / full * 100.0, 2)
                        if mean is not None and full else None,
            })
        mean = statistics.fmean(all_values) if all_values else None
        items.append({
            "key": key,
            "label": item.get("label") or key,
            "full": full,
            "scored": len(all_values),
            "absent": len(roster) - len(all_values),
            "average": round(mean, 2) if mean is not None else None,
            "rate": round(mean / full * 100.0, 2)
                    if mean is not None and full else None,
            "by_class": class_rows,
        })

    critical = []
    for student in roster:
        total = totals.get(student.get("id"))
        if total is None:
            continue
        bands = []
        if pass_line - CRITICAL_MARGIN <= total < pass_line:
            bands.append(("pass", pass_line))
        if excellent_line - CRITICAL_MARGIN <= total < excellent_line:
            bands.append(("excellent", excellent_line))
        if not bands:
            continue
        # Overlapping bands (a very short paper) keep the closer line: that is
        # the one the student is most likely to cross next.
        kind, line = min(
            bands,
            key=lambda band: (round(band[1] - total, 2), 0 if band[0] == "pass" else 1),
        )
        critical.append({
            "student_id": student.get("id"),
            "name": student.get("name") or "",
            "no": student.get("no") or "",
            "class_id": student.get("class_id"),
            "class_name": names.get(student.get("class_id"), ""),
            "total": total,
            "kind": kind,
            "line": line,
            "gap": round(line - total, 2),
        })
    critical.sort(key=lambda entry: (entry["gap"], -entry["total"]))

    class_order = {entry: index for index, entry in enumerate(scope)}
    rows = []
    for student in sorted(
        roster,
        key=lambda s: (
            class_order.get(s.get("class_id"), len(class_order)),
            str(s.get("no") or ""),
            s.get("name") or "",
        ),
    ):
        trend = _trend(student, exam, exams, scores_by_exam)
        rows.append({
            "student_id": student.get("id"),
            "name": student.get("name") or "",
            "no": student.get("no") or "",
            "class_id": student.get("class_id"),
            "class_name": names.get(student.get("class_id"), ""),
            "total": totals.get(student.get("id")),
            "absent": totals.get(student.get("id")) is None,
            "exams": trend,
            "trend": [entry["total"] for entry in trend],
        })

    summary = {
        "exam_id": exam.get("id"),
        "name": exam.get("name") or "",
        "date": exam.get("date") or "",
        "subject": exam.get("subject") or "",
        "full_score": full_score,
        "class_ids": exam_classes,
        "class_id": class_id,
        "pass_line": pass_line,
        "excellent_line": excellent_line,
        "low_line": low_line,
        "students": len(roster),
        "absent": len(roster) - overall["scored"],
        **overall,
    }

    return {
        "summary": summary,
        "by_class": by_class,
        "items": items,
        "critical": critical,
        "students": rows,
    }
