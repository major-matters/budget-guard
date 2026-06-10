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
"""

from __future__ import annotations

import math
import threading
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Deque, Dict, Iterator, Optional


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

from .errors import BudgetExceeded, KillSwitched, LoopDetected, UnknownTask
from .policy import BudgetPolicy
from .pricing import Pricing


@dataclass
class TaskLedger:
    """Running totals for one task."""

    task_id: str
    policy: BudgetPolicy
    input_tokens: int = 0
    output_tokens: int = 0
    usd: float = 0.0
    calls: int = 0
    killed: bool = False
    _recent: Deque[str] = field(default_factory=deque)

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
            "killed": self.killed,
            "limits": {
                "max_usd": p.max_usd,
                "max_tokens": p.max_tokens,
                "max_calls": p.max_calls,
            },
            "remaining": {
                "usd": None if p.max_usd is None else round(p.max_usd - self.usd, 6),
                "tokens": None if p.max_tokens is None else p.max_tokens - self.tokens,
                "calls": None if p.max_calls is None else p.max_calls - self.calls,
            },
        }


@dataclass(frozen=True)
class Decision:
    """Result of a non-enforcing check()."""

    allowed: bool
    code: Optional[str] = None
    reason: Optional[str] = None
    projected_usd: Optional[float] = None
    projected_tokens: Optional[int] = None


class BudgetGuard:
    def __init__(self, pricing: Optional[Pricing] = None):
        self._pricing = pricing
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

    # -- enforcement ---------------------------------------------------------

    def check(
        self,
        task_id: str,
        *,
        model: Optional[str] = None,
        est_input_tokens: int = 0,
        est_output_tokens: int = 0,
        signature: Optional[str] = None,
        enforce: bool = True,
    ) -> Decision:
        """Decide whether the next call may proceed. With enforce=True (default)
        a violation raises a BudgetGuardDenied subclass; otherwise it returns a
        Decision(allowed=False, ...)."""
        est_input_tokens = _toknum("est_input_tokens", est_input_tokens)
        est_output_tokens = _toknum("est_output_tokens", est_output_tokens)

        with self._lock:
            led = self._ledger(task_id)
            p = led.policy

            if self._global_kill or led.killed:
                return self._deny(
                    enforce, KillSwitched, task_id,
                    "kill switch engaged", "kill_switched",
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
                        detail={"repeats": repeats, "signature": signature},
                    )

            # Call-count cap.
            if p.max_calls is not None and led.calls + 1 > p.max_calls:
                return self._deny(
                    enforce, BudgetExceeded, task_id,
                    f"call cap reached ({p.max_calls})", "budget_exceeded",
                )

            proj_in = led.input_tokens + est_input_tokens
            proj_out = led.output_tokens + est_output_tokens
            proj_tokens = proj_in + proj_out

            if p.max_input_tokens is not None and proj_in > p.max_input_tokens:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"input-token cap exceeded ({proj_in} > {p.max_input_tokens})",
                                  "budget_exceeded", projected_tokens=proj_tokens)
            if p.max_output_tokens is not None and proj_out > p.max_output_tokens:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"output-token cap exceeded ({proj_out} > {p.max_output_tokens})",
                                  "budget_exceeded", projected_tokens=proj_tokens)
            if p.max_tokens is not None and proj_tokens > p.max_tokens:
                return self._deny(enforce, BudgetExceeded, task_id,
                                  f"token cap exceeded ({proj_tokens} > {p.max_tokens})",
                                  "budget_exceeded", projected_tokens=proj_tokens)

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
                                      projected_tokens=proj_tokens)

            return Decision(allowed=True, projected_usd=proj_usd, projected_tokens=proj_tokens)

    def record(
        self,
        task_id: str,
        *,
        model: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0,
        signature: Optional[str] = None,
    ) -> TaskLedger:
        """Commit actual usage after a call completed."""
        input_tokens = _toknum("input_tokens", input_tokens)
        output_tokens = _toknum("output_tokens", output_tokens)
        with self._lock:
            led = self._ledger(task_id)
            led.input_tokens += input_tokens
            led.output_tokens += output_tokens
            led.calls += 1
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
              projected_usd=None, projected_tokens=None, detail=None) -> Decision:
        if enforce:
            raise exc_cls(reason, task_id=task_id, detail=detail)
        return Decision(allowed=False, code=code, reason=reason,
                        projected_usd=projected_usd, projected_tokens=projected_tokens)
