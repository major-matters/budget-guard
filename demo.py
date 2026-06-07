#!/usr/bin/env python3
"""BudgetGuard demo. Zero install, zero dependencies:

    python3 demo.py

Shows the three controls on a simulated agent run: a USD budget that fails
closed, a runaway loop that gets caught, and a kill switch that halts a task.
No real model is called; token usage is simulated.
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

    banner("Mandate before the action. BudgetGuard during it. Witness after.")
    print("  github.com/major-matters  ·  majorlabs.co\n")


if __name__ == "__main__":
    main()
