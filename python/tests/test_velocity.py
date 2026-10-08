"""Spend-velocity windows and anomaly detection (0.2.0). Mirrors
typescript/test/velocity.test.ts; both suites also replay fixtures/velocity.json
so the two implementations are proven to agree verdict for verdict.

Every call passes an explicit `now`; nothing here touches the wall clock.

Runs under pytest, or standalone: `PYTHONPATH=. python3 tests/test_velocity.py`."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from budgetguard import (  # noqa: E402
    BudgetExceeded,
    BudgetGuard,
    BudgetGuardDenied,
    BudgetPolicy,
    KillSwitched,
    VelocityAnomaly,
    VelocityCallsExceeded,
    VelocityDenied,
    VelocitySpendExceeded,
)

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "fixtures", "velocity.json")

DETAIL_KEYS = {"window_seconds", "window_spend", "window_calls", "baseline", "factor", "anomaly", "action"}


def GBP(value):
    return {"value": value, "currency": "GBP"}


def _raises(exc, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc as e:
        return e
    raise AssertionError(f"expected {exc.__name__}")


# -- window caps --------------------------------------------------------------

def test_window_spend_cap_denies_at_boundary_and_allows_one_below():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_spend_per_window=GBP(1000)))
    g.record("t", amount=GBP(600), now=0)
    assert g.check("t", amount=GBP(400), now=10).allowed          # exactly the cap
    d = g.check("t", amount=GBP(401), now=10, enforce=False)     # one over
    assert not d.allowed and d.code == "velocity_spend"
    assert d.reason == "window spend cap exceeded (1001 > 1000 GBP in 60s)"
    assert d.velocity["window_spend"] == 1001 and d.velocity["window_calls"] == 2
    e = _raises(VelocitySpendExceeded, g.check, "t", amount=GBP(401), now=10)
    assert isinstance(e, VelocityDenied) and e.code == "velocity_spend"
    assert e.detail["velocity"] == d.velocity


def test_window_call_cap():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=10, max_calls_per_window=2))
    g.record("t", now=0)
    g.record("t", now=5)
    d = g.check("t", now=9, enforce=False)
    assert not d.allowed and d.code == "velocity_calls"
    assert d.reason == "window call cap exceeded (3 > 2 in 10s)"
    _raises(VelocityCallsExceeded, g.check, "t", now=9)
    assert g.check("t", now=10).allowed                          # the call at 0 has aged out


def test_sliding_window_expiry():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_spend_per_window=GBP(1000)))
    g.record("t", amount=GBP(600), now=0)
    assert not g.check("t", amount=GBP(500), now=59, enforce=False).allowed   # 59s old still counts
    assert g.check("t", amount=GBP(500), now=60).allowed                     # 60s old has aged out
    assert g.check("t", amount=GBP(1000), now=61).velocity["window_spend"] == 1000


# -- anomaly detection --------------------------------------------------------

def _three_quiet_windows(**overrides):
    """A task that paid 100 once per minute for three minutes: baseline 100 at t=180."""
    policy = dict(window_seconds=60, anomaly_factor=2, baseline_windows=3)
    policy.update(overrides)
    g = BudgetGuard()
    g.open("t", BudgetPolicy(**policy))
    for t in (0, 60, 120):
        g.record("t", amount=GBP(100), now=t)
    return g


def test_anomaly_inactive_before_baseline_windows_completed():
    g = _three_quiet_windows()
    d = g.check("t", amount=GBP(10000), now=179, enforce=False)   # 179 < 3 x 60 of history
    assert d.allowed and not d.anomaly and d.velocity["baseline"] is None
    d = g.check("t", amount=GBP(10000), now=180, enforce=False)   # history complete: active
    assert not d.allowed and d.code == "velocity_anomaly" and d.velocity["baseline"] == 100


def test_cold_start_never_trips():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, anomaly_factor=2))
    d = g.check("t", amount=GBP(10 ** 9), now=0, enforce=False)
    assert d.allowed and not d.anomaly and d.velocity["baseline"] is None
    g.record("t", amount=GBP(10 ** 9), now=0)
    d = g.check("t", amount=GBP(10 ** 9), now=170, enforce=False)
    assert d.allowed and d.velocity["baseline"] is None


def test_anomaly_fires_at_factor_boundary():
    g = _three_quiet_windows()
    assert g.check("t", amount=GBP(200), now=180).allowed          # 200 > 2 x 100 is false
    d = g.check("t", amount=GBP(201), now=180, enforce=False)     # 201 > 200
    assert not d.allowed and d.code == "velocity_anomaly" and d.anomaly
    assert d.reason == "spend velocity anomaly (201 > 2 x baseline 100 over 60s)"


def test_fractional_baseline():
    g = _three_quiet_windows()
    # At t=250 the buckets hold 100, 100 and nothing: baseline 200 / 3.
    d = g.check("t", amount=GBP(133), now=250, enforce=False)
    assert d.allowed and d.velocity["baseline"] == 200 / 3
    d = g.check("t", amount=GBP(134), now=250, enforce=False)
    assert not d.allowed
    assert d.reason == "spend velocity anomaly (134 > 2 x baseline 66.66666666666667 over 60s)"


def test_zero_baseline_with_history_is_an_anomaly_for_any_positive_spend():
    g = _three_quiet_windows()
    d = g.check("t", amount=GBP(1), now=1000, enforce=False)
    assert not d.allowed and d.velocity["baseline"] == 0 and d.anomaly
    assert d.reason == "spend velocity anomaly (1 > 2 x baseline 0 over 60s)"
    d = g.check("t", now=1000, enforce=False)                      # zero spend is not
    assert d.allowed and not d.anomaly and d.velocity["baseline"] == 0


def test_flag_mode_allows_and_marks():
    g = _three_quiet_windows(anomaly_action="flag")
    d = g.check("t", amount=GBP(201), now=180)                     # enforce=True does not raise
    assert d.allowed and d.anomaly and d.code is None and d.reason is None
    assert d.velocity["anomaly"] is True and d.velocity["action"] == "flag"
    d = g.check("t", amount=GBP(200), now=180)
    assert d.allowed and not d.anomaly and d.velocity["action"] is None


def test_deny_mode_denies_with_velocity_anomaly():
    g = _three_quiet_windows(anomaly_action="deny")
    e = _raises(VelocityAnomaly, g.check, "t", amount=GBP(201), now=180)
    assert isinstance(e, VelocityDenied) and isinstance(e, BudgetGuardDenied)
    assert e.code == "velocity_anomaly" and e.task_id == "t"
    assert e.detail["velocity"]["anomaly"] is True and e.detail["velocity"]["action"] == "deny"


# -- interplay with the existing controls ---------------------------------------

def test_kill_switch_still_wins():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_calls_per_window=1))
    g.record("t", now=0)
    g.kill("t")
    d = g.check("t", now=1, enforce=False)
    assert d.code == "kill_switched" and d.velocity["window_calls"] == 2
    e = _raises(KillSwitched, g.check, "t", now=1)
    assert e.detail["velocity"]["window_calls"] == 2
    g.revive("t")
    assert g.check("t", now=1, enforce=False).code == "velocity_calls"
    g.kill()                                                       # global
    assert g.check("t", now=1, enforce=False).code == "kill_switched"


def test_existing_caps_still_win_and_carry_the_detail():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_spend=GBP(500), window_seconds=60, max_spend_per_window=GBP(1000)))
    d = g.check("t", amount=GBP(600), now=0, enforce=False)
    assert d.code == "budget_exceeded" and d.reason == "spend cap exceeded (600 > 500 GBP)"
    assert d.velocity["window_spend"] == 600
    e = _raises(BudgetExceeded, g.check, "t", amount=GBP(600), now=0)
    assert e.detail["velocity"]["window_spend"] == 600


def test_window_cap_before_anomaly_and_detail_still_reports_anomaly():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_spend_per_window=GBP(300), anomaly_factor=2, baseline_windows=1))
    g.record("t", amount=GBP(100), now=0)
    d = g.check("t", amount=GBP(301), now=60, enforce=False)
    assert d.code == "velocity_spend" and d.anomaly and d.velocity["action"] == "deny"


# -- decision shape, time, configuration -----------------------------------------

def test_decision_detail_shape_and_serializable():
    g = _three_quiet_windows()
    d = g.check("t", amount=GBP(201), now=180, enforce=False)
    assert set(d.velocity) == DETAIL_KEYS
    assert d.velocity == {"window_seconds": 60, "window_spend": 201, "window_calls": 1,
                          "baseline": 100, "factor": 2, "anomaly": True, "action": "deny"}
    assert json.loads(json.dumps(d.velocity)) == d.velocity          # plain, serializable
    # Without window_seconds there is no velocity detail at all.
    g.open("plain", BudgetPolicy(max_calls=5))
    d = g.check("plain", enforce=False)
    assert d.velocity is None and d.anomaly is False


def test_clock_injection():
    ticks = iter([0, 60, 120, 180, 180])
    g = BudgetGuard(clock=lambda: next(ticks))
    g.open("t", BudgetPolicy(window_seconds=60, anomaly_factor=2, baseline_windows=3))
    for _ in range(3):
        g.record("t", amount=GBP(100))                              # 0, 60, 120 from the clock
    assert g.check("t", amount=GBP(200)).allowed                     # 180 from the clock
    assert not g.check("t", amount=GBP(201), enforce=False).allowed  # 180 from the clock
    assert g.check("t", amount=GBP(201), now=179).allowed            # explicit now wins, history incomplete
    _raises(ValueError, BudgetGuard, clock=42)


def test_now_is_validated_even_without_a_window():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_calls=5))
    for bad in (float("nan"), float("inf"), "0", True):
        _raises(ValueError, g.check, "t", now=bad)
        _raises(ValueError, g.record, "t", now=bad)
    assert g.status("t")["calls"] == 0
    assert g.check("t", now=12.5).allowed                           # floats are fine


def test_misconfiguration_raises():
    bad = [
        dict(window_seconds=-60, max_calls_per_window=1),
        dict(window_seconds=0, max_calls_per_window=1),
        dict(window_seconds=1.5, max_calls_per_window=1),
        dict(window_seconds="60", max_calls_per_window=1),
        dict(max_spend_per_window=GBP(100)),                        # no window
        dict(max_calls_per_window=3),                               # no window
        dict(anomaly_factor=2),                                     # no window
        dict(window_seconds=60, anomaly_factor=1),
        dict(window_seconds=60, anomaly_factor=0.5),
        dict(window_seconds=60, anomaly_factor=float("inf")),
        dict(window_seconds=60, anomaly_factor=float("nan")),
        dict(window_seconds=60, anomaly_factor=True),
        dict(window_seconds=60, max_calls_per_window=0),
        dict(window_seconds=60, max_calls_per_window=2.5),
        dict(window_seconds=60, max_spend_per_window={"value": 1.5, "currency": "GBP"}),
        dict(window_seconds=60, max_spend_per_window={"value": 10}),
        dict(window_seconds=60, baseline_windows=0),
        dict(window_seconds=60, baseline_windows=-1),
        dict(window_seconds=60, anomaly_action="block"),
        dict(max_spend=GBP(100), window_seconds=60, max_spend_per_window={"value": 10, "currency": "USD"}),
    ]
    for kwargs in bad:
        _raises(ValueError, BudgetPolicy, **kwargs)
    # Observe-only: a window with no limits is valid and reports the detail.
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60))
    assert g.check("t", now=0).velocity["window_calls"] == 1


def test_window_cap_fixes_the_currency():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_spend_per_window=GBP(100)))
    _raises(ValueError, g.check, "t", amount={"value": 1, "currency": "USD"}, now=0)
    _raises(ValueError, g.record, "t", amount={"value": 1, "currency": "USD"}, now=0)
    assert g.status("t")["calls"] == 0
    assert g.check("t", amount=GBP(100), now=0).allowed


def test_status_limits_include_velocity():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_spend_per_window=GBP(100), max_calls_per_window=4, anomaly_factor=3))
    lim = g.status("t")["limits"]
    assert lim["window_seconds"] == 60 and lim["max_spend_per_window"] == GBP(100)
    assert lim["max_calls_per_window"] == 4 and lim["anomaly_factor"] == 3


def test_check_does_not_mutate_the_window():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(window_seconds=60, max_calls_per_window=1))
    for _ in range(5):
        assert g.check("t", now=0).allowed
    g.record("t", now=0)
    assert not g.check("t", now=1, enforce=False).allowed


# -- cross-language fixture ---------------------------------------------------------

def test_cross_language_fixture():
    with open(FIXTURE) as fh:
        fixture = json.load(fh)
    assert fixture["cases"], "fixture has no cases"
    checks = 0
    for case in fixture["cases"]:
        g = BudgetGuard()
        g.open("t", BudgetPolicy(**case["policy"]))
        for i, step in enumerate(case["steps"]):
            where = f"{case['name']} / step {i}"
            op = step["op"]
            if op == "record":
                g.record("t", amount=step.get("amount"), now=step["now"])
            elif op == "kill":
                g.kill("t")
            elif op == "revive":
                g.revive("t")
            elif op == "check":
                exp = step["expect"]
                d = g.check("t", amount=step.get("amount"), now=step["now"], enforce=False)
                assert d.allowed == exp["allowed"], where
                assert d.code == exp["code"], where
                assert d.reason == exp["reason"], where
                assert d.anomaly == exp["anomaly"], where
                assert d.velocity == exp["velocity"], f"{where}: {d.velocity} != {exp['velocity']}"
                if not exp["allowed"]:
                    e = _raises(BudgetGuardDenied, g.check, "t", amount=step.get("amount"), now=step["now"])
                    assert e.code == exp["code"], where
                    assert e.detail["velocity"] == exp["velocity"], where
                checks += 1
            else:
                raise AssertionError(f"{where}: unknown op {op!r}")
    assert checks >= 30, f"only {checks} fixture checks ran"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"  FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
