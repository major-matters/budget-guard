"""The budget envelope for a task. Any limit left as None is not enforced."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Optional

MAX_SAFE_INT = 2 ** 53 - 1

ANOMALY_ACTIONS = ("deny", "flag")


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


def _positive_int(name: str, v) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or not 0 < v <= MAX_SAFE_INT:
        raise ValueError(f"{name} must be a positive integer, got {v!r}")
    return v


@dataclass(frozen=True)
class BudgetPolicy:
    """Limits applied to a single task.

    max_usd               stop once estimated spend would cross this (needs Pricing)
    max_spend             cumulative money the task may move out, across every guarded
                          action: {"value": integer, "currency": str}. MandateKit caps a
                          single transaction; this caps the running total.
    max_tokens            total input+output tokens
    max_input_tokens      input tokens only
    max_output_tokens     output tokens only
    max_calls             number of guarded calls
    max_repeats           same call signature this many times -> LoopDetected
    repeat_window         look at the last N signatures when counting repeats

    Spend velocity (0.2.0). A total cap says how much; these say how fast.

    window_seconds        length of the sliding window, in seconds. Required when
                          any of the three limits below is set.
    max_spend_per_window  money that may move in any one window, in the ledger's
                          currency (must match max_spend's currency when both are
                          set) -> VelocitySpendExceeded, code velocity_spend
    max_calls_per_window  guarded calls that fit in any one window
                          -> VelocityCallsExceeded, code velocity_calls
    anomaly_factor        the current window's spend, including the proposed call,
                          is an anomaly when it exceeds this many times the mean
                          spend of the trailing completed windows. Greater than 1.
    baseline_windows      how many completed windows feed the baseline, and how
                          many must exist since the task's first recorded event
                          before the anomaly check is active. Default 3.
    anomaly_action        "deny" (default, fail closed -> VelocityAnomaly, code
                          velocity_anomaly) or "flag" (allow, mark the decision).
    """

    max_usd: Optional[float] = None
    max_spend: Optional[Dict] = None
    max_tokens: Optional[int] = None
    max_input_tokens: Optional[int] = None
    max_output_tokens: Optional[int] = None
    max_calls: Optional[int] = None
    max_repeats: Optional[int] = 3
    repeat_window: int = 20
    window_seconds: Optional[int] = None
    max_spend_per_window: Optional[Dict] = None
    max_calls_per_window: Optional[int] = None
    anomaly_factor: Optional[float] = None
    baseline_windows: int = 3
    anomaly_action: str = "deny"

    def __post_init__(self) -> None:
        for name in ("max_usd", "max_tokens", "max_input_tokens", "max_output_tokens", "max_calls", "max_repeats"):
            v = getattr(self, name)
            if v is not None and v <= 0:
                raise ValueError(f"{name} must be positive, got {v!r}")
        if self.repeat_window <= 0:
            raise ValueError("repeat_window must be positive")
        if self.max_spend is not None:
            check_money("max_spend", self.max_spend)
        self._check_velocity()

    def _check_velocity(self) -> None:
        """Every velocity setting is validated at construction so a bad policy
        fails closed before it can guard anything."""
        if self.window_seconds is not None:
            _positive_int("window_seconds", self.window_seconds)
        if self.max_spend_per_window is not None:
            check_money("max_spend_per_window", self.max_spend_per_window)
            if self.max_spend is not None and self.max_spend["currency"] != self.max_spend_per_window["currency"]:
                raise ValueError(
                    f"max_spend_per_window currency {self.max_spend_per_window['currency']} does not match "
                    f"max_spend currency {self.max_spend['currency']}"
                )
        if self.max_calls_per_window is not None:
            _positive_int("max_calls_per_window", self.max_calls_per_window)
        f = self.anomaly_factor
        if f is not None and (
            isinstance(f, bool) or not isinstance(f, (int, float)) or not math.isfinite(f) or f <= 1
        ):
            raise ValueError(f"anomaly_factor must be a finite number greater than 1, got {f!r}")
        _positive_int("baseline_windows", self.baseline_windows)
        if self.anomaly_action not in ANOMALY_ACTIONS:
            raise ValueError(f"anomaly_action must be 'deny' or 'flag', got {self.anomaly_action!r}")
        if self.window_seconds is None and (
            self.max_spend_per_window is not None
            or self.max_calls_per_window is not None
            or self.anomaly_factor is not None
        ):
            raise ValueError(
                "window_seconds is required when max_spend_per_window, max_calls_per_window or anomaly_factor is set"
            )

    def spend_currency(self) -> Optional[Dict]:
        """The money cap that fixes the currency every `amount` must carry: max_spend
        when set, else max_spend_per_window, else None (any currency is counted)."""
        return self.max_spend if self.max_spend is not None else self.max_spend_per_window

    def has_any_limit(self) -> bool:
        return any(
            getattr(self, n) is not None
            for n in (
                "max_usd", "max_spend", "max_tokens", "max_input_tokens", "max_output_tokens",
                "max_calls", "max_repeats", "max_spend_per_window", "max_calls_per_window", "anomaly_factor",
            )
        )
