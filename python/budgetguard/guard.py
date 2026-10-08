"""BudgetGuard: runtime spend, token, loop, and kill-switch enforcement for
agent LLM calls.

Lifecycle per task:

    guard = BudgetGuard(pricing=Pricing())
    with guard.task("task-123", BudgetPolicy(max_usd=0.50, max_calls=20)):
        # BEFORE each model call, check the projected cost. Raises if it would
        # breach the envelope (fail-closed).
        guard.check("task-123", model="claude-sonnet-4-6",
                    est_input_tokens=1200, est_output_tokens=600, signature=sig)
        result = call_the_model(...)
        # AFTER the call, record what actually happened.
        guard.record("task-123", model="claude-sonnet-4-6",
                     input_tokens=usage.input, output_tokens=usage.output, signature=sig)

The guard never makes the model call itself. It only decides whether the next
call is permitted and keeps the running ledger.

Time (0.2.0): spend-velocity windows need a timestamp. Pass `now=` (seconds,
int or float) to check() and record(), or give the guard a `clock` callable at
construction. The wall clock is used only when neither is supplied, so tests
and replays stay deterministic.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, Iterator, Optional, Tuple


def _toknum(name: str, v) -> float:
    """Validate a token count: a finite, non-negative number. Rejects NaN and
    inf, which would otherwise slip past comparison checks and fail OPEN."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name} must be a number, got {type(v).__name__}")
    if isinstance(v, float) and not math.isfinite(v):
        raise ValueError(f"{name} must be finite, got {v!r}")
    if v < 0:
        raise ValueError(f"{name} must be non-negative, got {v!r}")
    return v


def _timenum(name: str, v) -> float:
    """Validate a timestamp: a finite number of seconds (int or float)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{name} must be a number of seconds, got {type(v).__name__}")
    if isinstance(v, float) and not math.isfinite(v):
        raise ValueError(f"{name} must be finite, got {v!r}")
    return v


def _fmt(x) -> str:
    """Format a number the way JavaScript's String() does for the ranges money
    uses, so both implementations produce identical reason strings: an integral
    float prints without a trailing .0."""
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)

from .errors import (
    BudgetExceeded,
    KillSwitched,
    LoopDetected,
    UnknownTask,
    VelocityAnomaly,
    VelocityCallsExceeded,
    VelocitySpendExceeded,
)
from .policy import BudgetPolicy, check_money
from .pricing import Pricing


def _money(name: str, amount, policy: BudgetPolicy) -> int:
    """Validate an optional money amount against the policy's currency (fixed by
    max_spend, else max_spend_per_window). Returns the integer value (0 when no
    amount is given)."""
    if amount is None:
        return 0
    m = check_money(name, amount)
    cap = policy.spend_currency()
    if cap is not None and m["currency"] != cap["currency"]:
        label = "max_spend" if policy.max_spend is not None else "max_spend_per_window"
        raise ValueError(
            f"{name} currency {m['currency']} does not match the policy's {label} currency {cap['currency']}"
        )
    return m["value"]


@dataclass
class TaskLedger:
    """Running totals for one task."""

    task_id: str
    policy: BudgetPolicy
    input_tokens: int = 0
    output_tokens: int = 0
    usd: float = 0.0
    spend: int = 0
    calls: int = 0
    killed: bool = False
    _recent: Deque[str] = field(default_factory=deque)
    # (recorded_at, spend) per recorded call, kept only while a velocity window
    # can still see it. Empty unless the policy sets window_seconds.
    _events: Deque[Tuple[float, int]] = field(default_factory=deque)
    _first_at: Optional[float] = None

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def snapshot(self) -> dict:
        p = self.policy
        return {
            "task_id": self.task_id,
            "calls": self.calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "tokens": self.tokens,
            "usd": round(self.usd, 6),
            "spend": self.spend,
            "killed": self.killed,
            "limits": {
                "max_usd": p.max_usd,
                "max_tokens": p.max_tokens,
                "max_calls": p.max_calls,
                "max_spend": p.max_spend,
                "window_seconds": p.window_seconds,
                "max_spend_per_window": p.max_spend_per_window,
                "max_calls_per_window": p.max_calls_per_window,
                "anomaly_factor": p.anomaly_factor,
            },
            "remaining": {
                "usd": None if p.max_usd is None else round(p.max_usd - self.usd, 6),
                "tokens": None if p.max_tokens is None else p.max_tokens - self.tokens,
                "calls": None if p.max_calls is None else p.max_calls - self.calls,
                "spend": None if p.max_spend is None else p.max_spend["value"] - self.spend,
            },
        }


def _velocity(led: TaskLedger, now: float, amount_value: int) -> dict:
    """The spend-velocity picture for a call proposed at `now`.

    The current window is the sliding window (now - W, now]: a recorded event
    counts while it is less than window_seconds old, so at exactly W seconds it
    has aged out. For the anomaly baseline, the W seconds before the current
    window form completed bucket 1, the W before that bucket 2, and so on. The
    baseline is the mean spend of buckets 1..N (N = baseline_windows). It is
    active only once the task's first recorded event is at least N*W seconds
    old, so every one of those buckets lies inside the task's history; empty
    buckets inside the history count as zero, and with an active baseline of
    zero any positive spend in the current window is an anomaly. Before that,
    baseline is None and nothing trips (a cold start never fires).

    window_spend and window_calls include the proposed call. Returns a plain
    dict so it can ride along in a WitnessKit trail."""
    p = led.policy
    w = p.window_seconds
    n = p.baseline_windows
    window_spend = amount_value
    window_calls = 1
    baseline_total = 0
    horizon = (n + 1) * w
    for recorded_at, spend in led._events:
        age = now - recorded_at
        if age < w:
            window_spend += spend
            window_calls += 1
        elif age < horizon:
            baseline_total += spend
    factor = p.anomaly_factor
    active = factor is not None and led._first_at is not None and (now - led._first_at) >= n * w
    baseline = None
    anomaly = False
    if active:
        baseline = baseline_total / n
        if baseline.is_integer():
            baseline = int(baseline)
        anomaly = window_spend > factor * baseline
    return {
        "window_seconds": w,
        "window_spend": window_spend,
        "window_calls": window_calls,
        "baseline": baseline,
        "factor": factor,
        "anomaly": bool(anomaly),
        "action": p.anomaly_action if anomaly else None,
    }


@dataclass(frozen=True)
class Decision:
    """Result of a non-enforcing check().

    anomaly   True when the spend-velocity anomaly condition holds for this call,
              whatever the verdict (in "flag" mode the call is allowed and marked).
    velocity  the velocity detail (window_seconds, window_spend, window_calls,
              baseline, factor, anomaly, action), None when the policy sets no
              window_seconds.
    """

    allowed: bool
    code: Optional[str] = None
    reason: Optional[str] = None
    projected_usd: Optional[float] = None
    projected_tokens: Optional[int] = None
    projected_spend: Optional[int] = None
    anomaly: bool = False
    velocity: Optional[dict] = None


class BudgetGuard:
    def __init__(self, pricing: Optional[Pricing] = None, clock: Optional[Callable[[], float]] = None):
        """`clock` returns the current time in seconds; it is consulted only when a
        call omits `now=`. Without a clock the wall clock is used."""
        if clock is not None and not callable(clock):
            raise ValueError("clock must be a callable returning seconds")
        self._pricing = pricing
        self._clock = clock
        self._tasks: Dict[str, TaskLedger] = {}
        self._global_kill = False
        self._lock = threading.RLock()

    # -- task lifecycle ------------------------------------------------------

    def open(self, task_id: str, policy: Optional[BudgetPolicy] = None) -> TaskLedger:
        if not task_id:
            raise ValueError("task_id is required")
        with self._lock:
            if task_id in self._tasks:
                raise ValueError(f"task {task_id!r} is already open")
            ledger = TaskLedger(task_id=task_id, policy=policy or BudgetPolicy())
            self._tasks[task_id] = ledger
            return ledger

    def close(self, task_id: str) -> Optional[TaskLedger]:
        with self._lock:
            return self._tasks.pop(task_id, None)

    @contextmanager
    def task(self, task_id: str, policy: Optional[BudgetPolicy] = None) -> Iterator[TaskLedger]:
        ledger = self.open(task_id, policy)
        try:
            yield ledger
        finally:
            self.close(task_id)

    def _ledger(self, task_id: str) -> TaskLedger:
        led = self._tasks.get(task_id)
        if led is None:
            raise UnknownTask(f"no open task {task_id!r}", task_id=task_id)
        return led

    def _now(self, now) -> float:
        """Resolve the timestamp for this call: the explicit `now`, else the clock
        given at construction, else the wall clock."""
        if now is None:
            now = self._clock() if self._clock is not None else time.time()
        return _timenum("now", now)

    # -- enforcement ---------------------------------------------------------

    def check(
        self,
        task_id: str,
        *,
        model: Optional[str] = None,
        est_input_tokens: int = 0,
        est_output_tokens: int = 0,
        amount: Optional[dict] = None,
        signature: Optional[str] = None,
        now: Optional[float] = None,
        enforce: bool = True,
    ) -> Decision:
        """Decide whether the next call may proceed. With enforce=True (default)
        a violation raises a BudgetGuardDenied subclass; otherwise it returns a
        Decision(allowed=False, ...). `amount` is the money this action would
        move out, checked against the policy's max_spend. `now` is the time of
        the call in seconds, used by the spend-velocity window."""
        est_input_tokens = _toknum("est_input_tokens", est_input_tokens)
        est_output_tokens = _toknum("est_output_tokens", est_output_tokens)
        if now is not None:
            _timenum("now", now)

        with self._lock:
            led = self._ledger(task_id)
            p = led.policy
            # Validated up front so a malformed amount can never slip past the cap.
            amount_value = _money("amount", amount, p)
            # The velocity picture is computed first so every decision carries it,
            # whichever check settles the verdict.
            vel = _velocity(led, self._now(now), amount_value) if p.window_seconds is not None else None

            if self._global_kill or led.killed:
                return self._deny(
                    enforce, KillSwitched, task_id,
                    "kill switch engaged", "kill_switched", velocity=vel,
                )

            # Loop detection: count this signature among the recent window.
            if signature is not None and p.max_repeats is not None:
                window = list(led._recent)[-p.repeat_window:]
                repeats = window.count(signature) + 1  # +1 for the pending call
                if repeats > p.max_repeats:
                    return self._deny(
                        enforce, LoopDetected, task_id,
                        f"signature repeated {repeats}x within window of {p.repeat_window} "
                        f"(max {p.max_repeats})",
                        "loop_detected",
                        detail={"repeats": repeats, "signature": signature}, velocity=vel,
                    )

            # Call-count cap.
            if p.max_calls is not None and led.calls + 1 > p.max_calls:
                return self._deny(
                    enforce, BudgetExceeded, task_id,
                    f"call cap reached ({p.max_calls})", "budget_exceeded", velocity=vel,
                )

            proj_in = led.input_tokens + est_input_tokens
            proj_out = led.output_tokens + est_output_tokens
            proj_tokens = proj_in + proj_out

            if p.max_input_tokens is not None and proj_in > p.max_input_tokens:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"input-token cap exceeded ({proj_in} > {p.max_input_tokens})",
                                  "budget_exceeded", projected_tokens=proj_tokens, velocity=vel)
            if p.max_output_tokens is not None and proj_out > p.max_output_tokens:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"output-token cap exceeded ({proj_out} > {p.max_output_tokens})",
                                  "budget_exceeded", projected_tokens=proj_tokens, velocity=vel)
            if p.max_tokens is not None and proj_tokens > p.max_tokens:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"token cap exceeded ({proj_tokens} > {p.max_tokens})",
                                  "budget_exceeded", projected_tokens=proj_tokens, velocity=vel)

            proj_spend = led.spend + amount_value
            if p.max_spend is not None and proj_spend > p.max_spend["value"]:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"spend cap exceeded ({proj_spend} > {p.max_spend['value']} {p.max_spend['currency']})",
                                  "budget_exceeded", projected_spend=proj_spend,
                                  projected_tokens=proj_tokens, velocity=vel)

            proj_usd = led.usd
            if p.max_usd is not None:
                if self._pricing is None:
                    raise ValueError(
                        "policy sets max_usd but BudgetGuard was created without Pricing"
                    )
                proj_usd = led.usd + self._pricing.cost(model, est_input_tokens, est_output_tokens)
                if proj_usd > p.max_usd:
                    return self._deny(enforce, BudgetExceeded, task_id,
                                      f"USD cap exceeded (${proj_usd:.4f} > ${p.max_usd:.4f})",
                                      "budget_exceeded", projected_usd=proj_usd,
                                      projected_tokens=proj_tokens, velocity=vel)

            # Spend velocity: window caps first, then the anomaly check. These run
            # after every existing control, so a total cap or the kill switch
            # always reports its own reason.
            if vel is not None:
                w = p.window_seconds
                cap = p.max_spend_per_window
                if cap is not None and vel["window_spend"] > cap["value"]:
                    return self._deny(enforce, VelocitySpendExceeded, task_id,
                                      f"window spend cap exceeded ({vel['window_spend']} > {cap['value']} {cap['currency']} in {w}s)",
                                      "velocity_spend", projected_usd=proj_usd, projected_tokens=proj_tokens,
                                      projected_spend=proj_spend, velocity=vel)
                if p.max_calls_per_window is not None and vel["window_calls"] > p.max_calls_per_window:
                    return self._deny(enforce, VelocityCallsExceeded, task_id,
                                      f"window call cap exceeded ({vel['window_calls']} > {p.max_calls_per_window} in {w}s)",
                                      "velocity_calls", projected_usd=proj_usd, projected_tokens=proj_tokens,
                                      projected_spend=proj_spend, velocity=vel)
                if vel["anomaly"] and p.anomaly_action == "deny":
                    return self._deny(enforce, VelocityAnomaly, task_id,
                                      f"spend velocity anomaly ({vel['window_spend']} > {_fmt(vel['factor'])} x baseline "
                                      f"{_fmt(vel['baseline'])} over {w}s)",
                                      "velocity_anomaly", projected_usd=proj_usd, projected_tokens=proj_tokens,
                                      projected_spend=proj_spend, velocity=vel)

            return Decision(allowed=True, projected_usd=proj_usd, projected_tokens=proj_tokens,
                            projected_spend=proj_spend, anomaly=bool(vel is not None and vel["anomaly"]),
                            velocity=vel)

    def record(
        self,
        task_id: str,
        *,
        model: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        amount: Optional[dict] = None,
        signature: Optional[str] = None,
        now: Optional[float] = None,
    ) -> TaskLedger:
        """Commit actual usage after a call completed. `amount` is the money the
        action actually moved out; `now` is when it happened, in seconds."""
        input_tokens = _toknum("input_tokens", input_tokens)
        output_tokens = _toknum("output_tokens", output_tokens)
        if now is not None:
            _timenum("now", now)
        with self._lock:
            led = self._ledger(task_id)
            p = led.policy
            amount_value = _money("amount", amount, p)
            recorded_at = self._now(now) if p.window_seconds is not None else None
            led.input_tokens += input_tokens
            led.output_tokens += output_tokens
            led.spend += amount_value
            led.calls += 1
            if recorded_at is not None:
                led._events.append((recorded_at, amount_value))
                led._first_at = recorded_at if led._first_at is None else min(led._first_at, recorded_at)
                # Bound memory: an event older than every bucket the policy can
                # look at never matters again (time is expected not to go backwards).
                horizon = (p.baseline_windows + 1) * p.window_seconds
                while led._events and recorded_at - led._events[0][0] >= horizon:
                    led._events.popleft()
            if self._pricing is not None:
                if led.policy.max_usd is not None:
                    # Fail closed: under a USD cap, an unpriced model must not be
                    # silently recorded as $0 (audit 2026-06-10 finding #5).
                    # cost() raises KeyError on a missing price, matching check().
                    led.usd += self._pricing.cost(model, input_tokens, output_tokens)
                elif self._pricing.has(model):
                    led.usd += self._pricing.cost(model, input_tokens, output_tokens)
            if signature is not None:
                led._recent.append(signature)
                # Bound memory: keep a little more than the longest window we read.
                maxlen = max(led.policy.repeat_window * 4, 64)
                while len(led._recent) > maxlen:
                    led._recent.popleft()
            return led

    # -- kill switch ---------------------------------------------------------

    def kill(self, task_id: Optional[str] = None) -> None:
        """Engage the kill switch for one task, or globally if task_id is None."""
        with self._lock:
            if task_id is None:
                self._global_kill = True
            else:
                self._ledger(task_id).killed = True

    def revive(self, task_id: Optional[str] = None) -> None:
        with self._lock:
            if task_id is None:
                self._global_kill = False
            else:
                self._ledger(task_id).killed = False

    # -- introspection -------------------------------------------------------

    def status(self, task_id: str) -> dict:
        with self._lock:
            return self._ledger(task_id).snapshot()

    # -- internal ------------------------------------------------------------

    def _deny(self, enforce, exc_cls, task_id, reason, code, *,
              projected_usd=None, projected_tokens=None, projected_spend=None, detail=None,
              velocity=None) -> Decision:
        anomaly = bool(velocity is not None and velocity["anomaly"])
        if enforce:
            if velocity is not None:
                detail = dict(detail or {})
                detail["velocity"] = velocity
            raise exc_cls(reason, task_id=task_id, detail=detail)
        return Decision(allowed=False, code=code, reason=reason,
                        projected_usd=projected_usd, projected_tokens=projected_tokens,
                        projected_spend=projected_spend, anomaly=anomaly, velocity=velocity)
