#!/usr/bin/env python3
"""BudgetGuard demo. Zero install, zero dependencies:

    python3 demo.py

Shows the four controls on a simulated agent run: a USD budget that fails
closed, a runaway loop that gets caught, a kill switch that halts a task, and a
spend-velocity window that catches a burst of payments. No real model is called;
token usage and time are simulated.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "python"))

from budgetguard import (  # noqa: E402
    BudgetExceeded,
    BudgetGuard,
    BudgetPolicy,
    KillSwitched,
    LoopDetected,
    ModelPrice,
    Pricing,
)

LINE = "-" * 64


def banner(title):
    print(f"\n{LINE}\n  {title}\n{LINE}")


def main():
    # $3/1k input, $15/1k output — illustrative numbers for the demo only.
    pricing = Pricing({"demo-model": ModelPrice(3.0 / 1000, 15.0 / 1000)}, use_builtin=False)
    guard = BudgetGuard(pricing=pricing)

    banner("1. USD budget that fails closed")
    print("  Policy: max_usd = $0.10 per task")
    with guard.task("research", BudgetPolicy(max_usd=0.10)):
        call = 0
        while True:
            call += 1
            est_in, est_out = 1500, 800  # ~ $0.0165 per call
            try:
                guard.check("research", model="demo-model",
                            est_input_tokens=est_in, est_output_tokens=est_out)
            except BudgetExceeded as e:
                print(f"  call {call}: DENIED -> {e}")
                break
            guard.record("research", model="demo-model",
                         input_tokens=est_in, output_tokens=est_out)
            s = guard.status("research")
            print(f"  call {call}: allowed   spend=${s['usd']:.4f}  remaining=${s['remaining']['usd']:.4f}")

    banner("2. Runaway loop caught")
    print("  Policy: max_repeats = 3 within a window of 10 calls")
    with guard.task("agent-loop", BudgetPolicy(max_repeats=3, repeat_window=10)):
        sig = "search('weather') -> same args"
        for call in range(1, 6):
            try:
                guard.check("agent-loop", signature=sig)
            except LoopDetected as e:
                print(f"  call {call}: DENIED -> {e}")
                break
            guard.record("agent-loop", signature=sig)
            print(f"  call {call}: allowed   (identical call #{call})")

    banner("3. Kill switch halts a task mid-run")
    with guard.task("long-job", BudgetPolicy(max_calls=100)):
        for call in range(1, 5):
            if call == 3:
                print("  operator pulls the kill switch...")
                guard.kill("long-job")
            try:
                guard.check("long-job")
            except KillSwitched as e:
                print(f"  call {call}: DENIED -> {e}")
                break
            guard.record("long-job")
            print(f"  call {call}: allowed")

    banner("4. Spend velocity: a burst that breaks the task's own pattern")
    print("  Policy: window_seconds = 60, anomaly_factor = 2 over 3 completed windows")

    def gbp(value):
        return {"value": value, "currency": "GBP"}

    # Time is injected (now=), so the demo is deterministic: no wall clock involved.
    with guard.task("payouts", BudgetPolicy(window_seconds=60, anomaly_factor=2, baseline_windows=3)):
        clock = 0
        for amount in (100, 100, 100):  # one payout a minute: the baseline
            guard.check("payouts", amount=gbp(amount), now=clock)
            guard.record("payouts", amount=gbp(amount), now=clock)
            print(f"  t={clock:>3}s  paid {amount} GBP   allowed   (building the baseline)")
            clock += 60
        for amount in (150, 60):
            d = guard.check("payouts", amount=gbp(amount), now=clock, enforce=False)
            v = d.velocity
            verdict = "allowed" if d.allowed else "DENIED "
            print(f"  t={clock:>3}s  pay  {amount} GBP   {verdict}   window={v['window_spend']}  baseline={v['baseline']}")
            if d.allowed:
                guard.record("payouts", amount=gbp(amount), now=clock)
            else:
                print(f"          -> {d.reason}")

    banner("Mandate before the action. BudgetGuard during it. Witness after.")
    print("  github.com/major-matters  ·  majorlabs.co\n")


if __name__ == "__main__":
    main()
