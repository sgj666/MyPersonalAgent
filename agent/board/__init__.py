"""Task board: the teacher's own follow-up work items.

Separate from the scheduler on purpose. A scheduled task is an action that
fires at a time; a board task is a work item the teacher tracks. They live in
different files, are edited by different endpoints, and neither can overwrite
the other.
"""

from agent.board.store import (
    BoardStore,
    FIELDS,
    STATUSES,
    STATUS_LABELS,
    PRIORITIES,
    SOURCE_TYPES,
    board_file,
)

__all__ = [
    "BoardStore",
    "FIELDS",
    "STATUSES",
    "STATUS_LABELS",
    "PRIORITIES",
    "SOURCE_TYPES",
    "board_file",
]
