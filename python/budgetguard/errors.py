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


class VelocityDenied(BudgetGuardDenied):
    """Base class for the spend-velocity refusals (0.2.0). Catch this to handle any
    velocity denial uniformly. Every instance carries the velocity detail in
    `detail["velocity"]`."""

    code = "velocity_denied"


class VelocitySpendExceeded(VelocityDenied):
    """Money moved in the current window, plus this call, would cross max_spend_per_window."""

    code = "velocity_spend"


class VelocityCallsExceeded(VelocityDenied):
    """Calls made in the current window, plus this one, would cross max_calls_per_window."""

    code = "velocity_calls"


class VelocityAnomaly(VelocityDenied):
    """Spend in the current window exceeds anomaly_factor times the trailing baseline,
    and the policy's anomaly_action is "deny"."""

    code = "velocity_anomaly"
