"""BudgetGuard core tests. Run: python3 -m pytest  (or python3 tests/test_budgetguard.py)"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from budgetguard import (  # noqa: E402
    BudgetExceeded,
    BudgetGuard,
    BudgetPolicy,
    KillSwitched,
    LoopDetected,
    ModelPrice,
    Pricing,
    UnknownTask,
)

PRICING = Pricing({"m": ModelPrice(input_per_1k=1.0, output_per_1k=2.0)}, use_builtin=False)


def test_token_budget_allows_under_cap():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy(max_tokens=1000)):
        d = g.check("t", est_input_tokens=300, est_output_tokens=200)
        assert d.allowed
        g.record("t", input_tokens=300, output_tokens=200)
        assert g.status("t")["tokens"] == 500


def test_token_budget_fails_closed_over_cap():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy(max_tokens=500)):
        g.record("t", input_tokens=400, output_tokens=0)
        try:
            g.check("t", est_input_tokens=200, est_output_tokens=0)
            assert False, "expected BudgetExceeded"
        except BudgetExceeded:
            pass
        # non-enforcing form returns a Decision instead of raising
        d = g.check("t", est_input_tokens=200, est_output_tokens=0, enforce=False)
        assert not d.allowed and d.code == "budget_exceeded"


def test_usd_budget_uses_pricing():
    g = BudgetGuard(pricing=PRICING)
    # input 1000 tok @ $1/1k + output 1000 @ $2/1k = $3.00 per call
    with g.task("t", BudgetPolicy(max_usd=5.0)):
        g.record("t", model="m", input_tokens=1000, output_tokens=1000)
        assert abs(g.status("t")["usd"] - 3.0) < 1e-9
        # next identical call would project to $6 > $5 -> deny
        try:
            g.check("t", model="m", est_input_tokens=1000, est_output_tokens=1000)
            assert False, "expected BudgetExceeded"
        except BudgetExceeded:
            pass


def test_usd_budget_without_pricing_raises():
    g = BudgetGuard()  # no pricing
    with g.task("t", BudgetPolicy(max_usd=1.0)):
        try:
            g.check("t", model="m", est_input_tokens=10, est_output_tokens=10)
            assert False, "expected ValueError"
        except ValueError:
            pass


def test_call_cap():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy(max_calls=2)):
        g.check("t"); g.record("t")
        g.check("t"); g.record("t")
        try:
            g.check("t")
            assert False, "expected BudgetExceeded on 3rd call"
        except BudgetExceeded:
            pass


def test_loop_detection():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy(max_repeats=3, repeat_window=10)):
        for _ in range(3):
            g.check("t", signature="same")
            g.record("t", signature="same")
        # 4th identical signature exceeds max_repeats=3
        try:
            g.check("t", signature="same")
            assert False, "expected LoopDetected"
        except LoopDetected:
            pass
        # a different signature is fine
        assert g.check("t", signature="other").allowed


def test_loop_window_forgets_old_repeats():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy(max_repeats=2, repeat_window=3)):
        g.check("t", signature="a"); g.record("t", signature="a")
        # push 'a' out of the 3-wide window with other signatures
        for s in ("b", "c", "d"):
            g.record("t", signature=s)
        # 'a' no longer in the recent window -> allowed again
        assert g.check("t", signature="a").allowed


def test_kill_switch_task_and_global():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy()):
        g.kill("t")
        try:
            g.check("t")
            assert False, "expected KillSwitched"
        except KillSwitched:
            pass
        g.revive("t")
        assert g.check("t").allowed
        g.kill()  # global
        try:
            g.check("t")
            assert False, "expected KillSwitched (global)"
        except KillSwitched:
            pass


def test_unknown_task():
    g = BudgetGuard()
    try:
        g.check("nope")
        assert False, "expected UnknownTask"
    except UnknownTask:
        pass


def test_negative_inputs_rejected():
    g = BudgetGuard()
    with g.task("t", BudgetPolicy()):
        for bad in (lambda: g.check("t", est_input_tokens=-1),
                    lambda: g.record("t", input_tokens=-5)):
            try:
                bad()
                assert False, "expected ValueError"
            except ValueError:
                pass


def test_nan_inf_tokens_fail_closed():
    # Regression: NaN/inf must be rejected, not slip past comparison checks.
    g = BudgetGuard()
    with g.task("t", BudgetPolicy(max_tokens=100)):
        for bad in (float("nan"), float("inf"), float("-inf")):
            try:
                g.check("t", est_input_tokens=bad)
                assert False, f"expected ValueError for {bad}"
            except ValueError:
                pass
            try:
                g.record("t", input_tokens=bad)
                assert False, f"expected ValueError for {bad}"
            except ValueError:
                pass
        # ledger stays clean after the rejected calls
        assert g.status("t")["tokens"] == 0


def test_double_open_rejected():
    g = BudgetGuard()
    g.open("t", BudgetPolicy())
    try:
        g.open("t", BudgetPolicy())
        assert False, "expected ValueError on double open"
    except ValueError:
        pass
    g.close("t")


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        fn()
        passed += 1
        print(f"  ok  {fn.__name__}")
    print(f"\n{passed}/{len(fns)} passed")
