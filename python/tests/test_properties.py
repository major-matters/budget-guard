"""Property-based tests: the guard must never let the ledger cross a cap it
enforces, for any call sequence. Run: python3 -m pytest tests/test_properties.py
(requires hypothesis)."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hypothesis import given, settings  # noqa: E402
from hypothesis import strategies as st  # noqa: E402

from budgetguard import BudgetGuard, BudgetPolicy, ModelPrice, Pricing  # noqa: E402

calls = st.lists(
    st.tuples(st.integers(0, 5000), st.integers(0, 5000)),
    max_size=40,
)


@settings(max_examples=200)
@given(st.integers(1, 50_000), calls)
def test_token_cap_never_crossed(cap, seq):
    g = BudgetGuard()
    g.open("p", BudgetPolicy(max_tokens=cap))
    for est_in, est_out in seq:
        d = g.check("p", est_input_tokens=est_in, est_output_tokens=est_out, enforce=False)
        if not d.allowed:
            continue
        g.record("p", input_tokens=est_in, output_tokens=est_out)
    assert g.status("p")["tokens"] <= cap
    g.close("p")


@settings(max_examples=200)
@given(st.integers(1, 30), st.integers(0, 60))
def test_call_cap_never_crossed(cap, attempts):
    g = BudgetGuard()
    g.open("p", BudgetPolicy(max_calls=cap))
    for _ in range(attempts):
        if g.check("p", enforce=False).allowed:
            g.record("p")
    assert g.status("p")["calls"] <= cap
    g.close("p")


@settings(max_examples=200)
@given(st.integers(1, 100), calls)
def test_usd_cap_never_crossed(cap_cents, seq):
    cap = cap_cents / 100.0
    pricing = Pricing({"m": ModelPrice(2.0, 6.0)}, use_builtin=False)
    g = BudgetGuard(pricing=pricing)
    g.open("p", BudgetPolicy(max_usd=cap))
    for est_in, est_out in seq:
        d = g.check("p", model="m", est_input_tokens=est_in, est_output_tokens=est_out, enforce=False)
        if not d.allowed:
            continue
        g.record("p", model="m", input_tokens=est_in, output_tokens=est_out)
    assert g.status("p")["usd"] <= cap + 1e-9
    g.close("p")


@settings(max_examples=100)
@given(st.integers(1, 10), st.text())
def test_loop_always_denies_past_threshold(max_repeats, sig):
    g = BudgetGuard()
    g.open("p", BudgetPolicy(max_repeats=max_repeats, repeat_window=100))
    for _ in range(max_repeats):
        g.check("p", signature=sig)
        g.record("p", signature=sig)
    d = g.check("p", signature=sig, enforce=False)
    assert d.allowed is False and d.code == "loop_detected"
    g.close("p")


if __name__ == "__main__":
    test_token_cap_never_crossed()
    test_call_cap_never_crossed()
    test_usd_cap_never_crossed()
    test_loop_always_denies_past_threshold()
    print("property tests ok")
