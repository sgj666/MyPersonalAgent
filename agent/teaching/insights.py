"""Teaching facts, conservative plan imports and recent local drafts.

Facts aggregate recorded exam totals (absences excluded), and item rates are
earned / available points pooled by item key across exams. Homework missing
counts distinct students missing at least one matching assignment.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

from agent.teaching.store import MAX_TOPIC

DRAFT_KINDS = ("deck", "card", "plan", "advice")


def facts(store, class_id="", unit="") -> dict:
    """Return only facts backed by data; blank class_id aggregates all classes."""
    classes = {row["id"] for row in store.list_classes()}
    if not classes or (class_id and class_id not in classes):
        return {"facts": [], "stats": {}}
    selected = {class_id} if class_id else classes
    students = {row["id"]: row for row in store.list_students()
                if row["class_id"] in selected}
    needle = unit.strip().casefold()
    result = []
    stats = {"students": len(students)}
    progress = [row for row in store.list_progress()
                if row["class_id"] in selected and needle in row["topic"].casefold()]
    if progress:
        planned = sum(row["planned_periods"] for row in progress)
        taught = sum(row["taught_periods"] for row in progress)
        stats.update(planned=planned, taught=taught)
        gap = planned - taught
        value = f"落后 {gap} 课时" if gap > 0 else (
            f"超前 {-gap} 课时" if gap < 0 else "与计划一致")
        result.append({"key": "progress_gap", "label": "教学进度", "value": value,
                       "detail": f"计划 {planned}，已授 {taught}"})

    homework = [row for row in store.list_homework()
                if selected.intersection(row["class_ids"])
                and needle in row["title"].casefold()]
    if homework:
        missing = set()
        records = store.all_homework_records()
        for row in homework:
            states = records.get(row["id"], {})
            missing.update(student_id for student_id, student in students.items()
                           if student["class_id"] in row["class_ids"]
                           and states.get(student_id, "missing") == "missing")
        stats["homework_missing"] = len(missing)
        result.append({"key": "homework_missing", "label": "未交作业",
                       "value": f"{len(missing)} 人",
                       "detail": f"{len(homework)} 份作业，至少一份未交的人数（去重）"})

    totals, skills = [], {}
    for exam in store.list_exams():
        if not selected.intersection(exam["class_ids"]):
            continue
        for student_id, score in store.get_scores(exam["id"]).items():
            if student_id not in students:
                continue
            if score["total"] is not None:
                totals.append(score["total"])
            for item in exam["items"]:
                value = score["items"].get(item["key"])
                if value is None:
                    continue
                skill = skills.setdefault(item["key"], {
                    "name": item["label"], "earned": 0, "full": 0})
                skill["earned"] += value
                skill["full"] += item["full"]
    if totals:
        stats["exam_avg"] = round(sum(totals) / len(totals), 2)
        result.append({"key": "exam_avg", "label": "考试均分",
                       "value": f"{stats['exam_avg']:g} 分",
                       "detail": f"汇总 {len(totals)} 人次已录入成绩，缺考不计入"})
    if skills:
        weakest = sorted(skills.values(), key=lambda row: row["earned"] / row["full"])[:3]
        stats["weak_skills"] = [{"name": row["name"],
                                 "rate": row["earned"] / row["full"]} for row in weakest]
        result.append({"key": "exam_weak", "label": "薄弱项",
                       "value": "、".join(f"{row['name']} {row['rate']:.0%}"
                                         for row in stats["weak_skills"]),
                       "detail": "按题目 key 汇总已录入得分 / 对应满分，按得分率升序"})
    return {"facts": result, "stats": stats}


def import_progress(store, class_ids, weeks, overwrite=False) -> dict:
    """Map week to order, join unit/topic, ignore goal/assess (no store fields).

    Existing entries match by order or identical joined topic. Even with
    overwrite, taught entries are immutable; only planned_periods can change.
    skipped counts entries left untouched (including unchanged planned values).
    """
    if not isinstance(class_ids, list) or not class_ids or any(
            not isinstance(value, str) or not value.strip() for value in class_ids):
        raise ValueError("请选择至少一个班级（class_ids）")
    class_ids = list(dict.fromkeys(value.strip() for value in class_ids))
    if not isinstance(overwrite, bool):
        raise ValueError("overwrite 必须为布尔值")
    if not isinstance(weeks, list) or not weeks:
        raise ValueError("请提供非空的周次计划（weeks）")
    clean = []
    for index, row in enumerate(weeks, 1):
        if not isinstance(row, dict):
            raise ValueError(f"第 {index} 条周次计划必须为对象")
        week, periods = row.get("week"), row.get("periods")
        if type(week) is not int or week < 1:
            raise ValueError(f"第 {index} 条 week 必须为正整数")
        if type(periods) is not int or periods < 0:
            raise ValueError(f"第 {week} 周 periods 必须为非负整数")
        unit, topic = row.get("unit", ""), row.get("topic", "")
        if not isinstance(unit, str) or not isinstance(topic, str):
            raise ValueError(f"第 {week} 周单元和课题必须为文字")
        topic = " ".join(part.strip() for part in (unit, topic) if part.strip())
        if not topic or len(topic) > MAX_TOPIC:
            raise ValueError(f"第 {week} 周单元和课题合计须为 1–{MAX_TOPIC} 字")
        clean.append((week, topic, periods))

    report = {"created": 0, "skipped": 0, "conflicts": []}
    # Keep match/check/write under the store's existing locks so concurrent
    # imports cannot duplicate rows or overwrite a newly taught entry.
    with store._locked("classes", "progress"):
        known = {row["id"] for row in store.list_classes()}
        unknown = [value for value in class_ids if value not in known]
        if unknown:
            raise ValueError(f"班级不存在：{'、'.join(unknown)}，请先创建班级")
        existing = store.list_progress()
        for class_id in class_ids:
            for week, topic, periods in clean:
                matches = [row for row in existing if row["class_id"] == class_id
                           and (row["order"] == week or row["topic"] == topic)]
                if matches:
                    if any(row["taught_periods"] > 0 for row in matches):
                        report["conflicts"].append({"class_id": class_id, "week": week,
                                                    "reason": "已有已授课时，保留原进度"})
                    elif overwrite and len(matches) == 1 and matches[0]["planned_periods"] != periods:
                        matches[0].update(store.update_progress(
                            matches[0]["id"], planned_periods=periods))
                        continue
                    elif len(matches) > 1:
                        report["conflicts"].append({"class_id": class_id, "week": week,
                                                    "reason": "周次或课题匹配多条进度，请先核对"})
                    report["skipped"] += 1
                    continue
                existing.append(store.create_progress(class_id, topic, planned_periods=periods,
                                                      order=week))
                report["created"] += 1
    return report


def recent(workspace, kind="", limit=5) -> dict:
    """List valid draft JSON files newest first, confined to this workspace."""
    if kind and kind not in DRAFT_KINDS:
        raise ValueError("kind 必须为 deck、card、plan 或 advice")
    if type(limit) is not int or limit < 1:
        raise ValueError("limit 必须为正整数")
    workspace = Path(workspace).resolve()
    items = []
    for draft_kind in (kind,) if kind else DRAFT_KINDS:
        directory = workspace / "artifacts" / "教学工具" / draft_kind
        if not directory.is_dir():
            continue
        for path in directory.glob("*.json"):
            try:
                path.resolve().relative_to(workspace)
                draft = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(draft, dict):
                    continue
                meta = draft.get("meta") or {}
                if not isinstance(meta, dict):
                    continue
                modified = path.stat().st_mtime
            except (OSError, ValueError, UnicodeError):
                continue
            items.append((modified, {
                "slug": path.stem, "title": meta.get("title") or draft.get("title") or path.stem,
                "when": datetime.fromtimestamp(modified, timezone.utc).isoformat(),
                "rel": path.relative_to(workspace).as_posix(), "kind": draft_kind,
                "class_ids": meta.get("class_ids", draft.get("class_ids", [])),
            }))
    items.sort(key=lambda row: (row[0], row[1]["rel"]), reverse=True)
    return {"items": [row for _, row in items[:limit]]}
