"""BudgetGuard exceptions. Every denial is fail-closed: the guarded call must
not proceed unless check() returns cleanly."""

from __future__ import annotations

from typing import Optional


class BudgetGuardDenied(Exception):
    """Base class for every refusal. Catch this to handle any denial uniformly."""

    code = "denied"

    def __init__(self, message: str, *, task_id: Optional[str] = None, detail: Optional[dict] = None):
        super().__init__(message)
        self.task_id = task_id
        self.detail = detail or {}


class BudgetExceeded(BudgetGuardDenied):
    """A USD, token, or call-count cap would be crossed by this call."""

    code = "budget_exceeded"


class LoopDetected(BudgetGuardDenied):
    """The same call signature has repeated past the policy's loop threshold."""

    code = "loop_detected"


class KillSwitched(BudgetGuardDenied):
    """A kill switch is engaged for this task (or globally)."""

    code = "kill_switched"


class UnknownTask(BudgetGuardDenied):
    """No open task for the given id. Call open() / use the task() context first."""

    code = "unknown_task"
