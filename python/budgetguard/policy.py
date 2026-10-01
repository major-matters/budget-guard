"""The budget envelope for a task. Any limit left as None is not enforced."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

MAX_SAFE_INT = 2 ** 53 - 1


def check_money(name: str, amount) -> Dict:
    """Validate a money amount: {"value": integer >= 0, "currency": str}, the same
    integer-unit-plus-currency convention as MandateKit."""
    if not isinstance(amount, dict):
        raise ValueError(f"{name} must be a dict like {{'value': 500, 'currency': 'GBP'}}")
    v = amount.get("value")
    cur = amount.get("currency")
    if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= MAX_SAFE_INT:
        raise ValueError(f"{name}.value must be an integer in [0, 2**53-1], got {v!r}")
    if not isinstance(cur, str) or not cur:
        raise ValueError(f"{name}.currency must be a non-empty string")
    return {"value": v, "currency": cur}


@dataclass(frozen=True)
class BudgetPolicy:
    """Limits applied to a single task.

    max_usd            stop once estimated spend would cross this (needs Pricing)
    max_spend          cumulative money the task may move out, across every guarded
                       action: {"value": integer, "currency": str}. MandateKit caps a
                       single transaction; this caps the running total.
    max_tokens         total input+output tokens
    max_input_tokens   input tokens only
    max_output_tokens  output tokens only
    max_calls          number of guarded calls
    max_repeats        same call signature this many times -> LoopDetected
    repeat_window      look at the last N signatures when counting repeats
    """

    max_usd: Optional[float] = None
    max_spend: Optional[Dict] = None
    max_tokens: Optional[int] = None
    max_input_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None
    max_calls: Optional[int] = None
    max_repeats: Optional[int] = 3
    repeat_window: int = 20

    def __post_init__(self) -> None:
        for name in ("max_usd", "max_tokens", "max_input_tokens", "max_output_tokens", "max_calls", "max_repeats"):
            v = getattr(self, name)
            if v is not None and v <= 0:
                raise ValueError(f"{name} must be positive, got {v!r}")
        if self.repeat_window <= 0:
            raise ValueError("repeat_window must be positive")
        if self.max_spend is not None:
            check_money("max_spend", self.max_spend)

    def has_any_limit(self) -> bool:
        return any(
            getattr(self, n) is not None
            for n in ("max_usd", "max_spend", "max_tokens", "max_input_tokens", "max_output_tokens", "max_calls", "max_repeats")
        )
