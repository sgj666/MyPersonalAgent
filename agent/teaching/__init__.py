"""Structured teaching data for the teacher workbench.

One package, one store: classes and their rosters, the weekly timetable, the
syllabus progress, homework and its per-student states, exams and the scores
recorded for them. Analysis lives beside the store so a caller can ask
"how did this exam go" without re-implementing the pass/excellent maths.
"""

from agent.teaching.analysis import (
    CRITICAL_MARGIN,
    EXCELLENT_RATIO,
    LOW_RATIO,
    PASS_RATIO,
    analyze,
    student_total,
)
from agent.teaching.store import (
    DEFAULT_SETTINGS,
    FILES,
    HOMEWORK_KINDS,
    SETTINGS_KEYS,
    STORE_VERSION,
    SUBMISSION_STATES,
    TIMETABLE_KINDS,
    TeachingStore,
    default_settings,
    teaching_dir,
)

__all__ = [
    "CRITICAL_MARGIN",
    "DEFAULT_SETTINGS",
    "EXCELLENT_RATIO",
    "FILES",
    "HOMEWORK_KINDS",
    "LOW_RATIO",
    "PASS_RATIO",
    "SETTINGS_KEYS",
    "STORE_VERSION",
    "SUBMISSION_STATES",
    "TIMETABLE_KINDS",
    "TeachingStore",
    "analyze",
    "default_settings",
    "student_total",
    "teaching_dir",
]
