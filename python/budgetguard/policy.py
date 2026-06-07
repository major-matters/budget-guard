"""The budget envelope for a task. Any limit left as None is not enforced."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class BudgetPolicy:
    """Limits applied to a single task.

    max_usd            stop once estimated spend would cross this (needs Pricing)
    max_tokens         total input+output tokens
    max_input_tokens   input tokens only
    max_output_tokens  output tokens only
    max_calls          number of guarded calls
    max_repeats        same call signature this many times -> LoopDetected
    repeat_window      look at the last N signatures when counting repeats
    """

    max_usd: Optional[float] = None
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

    def has_any_limit(self) -> bool:
        return any(
            getattr(self, n) is not None
            for n in ("max_usd", "max_tokens", "max_input_tokens", "max_output_tokens", "max_calls", "max_repeats")
        )
