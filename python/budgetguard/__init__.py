"""BudgetGuard: per-task budget, loop detection, kill-switch, and spend-velocity
middleware for agent LLM calls. Deterministic, dependency-free, fail-closed.

    from budgetguard import BudgetGuard, BudgetPolicy, Pricing

Token and call budgets need no configuration. USD budgets require a Pricing
table (prices change; supply your own for anything that bills)."""

from __future__ import annotations

from .errors import (
    BudgetExceeded,
    BudgetGuardDenied,
    KillSwitched,
    LoopDetected,
    UnknownTask,
    VelocityAnomaly,
    VelocityCallsExceeded,
    VelocityDenied,
    VelocitySpendExceeded,
)
from .guard import BudgetGuard, Decision, TaskLedger
from .policy import BudgetPolicy
from .pricing import DEFAULT_PRICES, ModelPrice, Pricing

__version__ = "0.2.0"

__all__ = [
    "BudgetGuard",
    "BudgetPolicy",
    "Pricing",
    "ModelPrice",
    "DEFAULT_PRICES",
    "Decision",
    "TaskLedger",
    "BudgetGuardDenied",
    "BudgetExceeded",
    "LoopDetected",
    "KillSwitched",
    "UnknownTask",
    "VelocityDenied",
    "VelocitySpendExceeded",
    "VelocityCallsExceeded",
    "VelocityAnomaly",
    "__version__",
]
