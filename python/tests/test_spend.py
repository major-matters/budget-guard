"""The money ledger: max_spend caps the running total a task moves out, in the
same integer-unit-plus-currency convention as MandateKit. Added for the Mandate
Sandbox (2026-10-01). Mirrors typescript/test/spend.test.ts.

Runs under pytest, or standalone: `PYTHONPATH=. python3 tests/test_spend.py`."""

from budgetguard import BudgetExceeded, BudgetGuard, BudgetPolicy, KillSwitched, LoopDetected


def GBP(value):
    return {"value": value, "currency": "GBP"}


def _raises(exc, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc:
        return True
    raise AssertionError(f"expected {exc.__name__}")


def test_max_spend_caps_running_total():
    g = BudgetGuard()
    g.open("kettle", BudgetPolicy(max_spend=GBP(9000)))
    assert g.check("kettle", amount=GBP(8400)).allowed
    g.record("kettle", amount=GBP(8400))
    assert g.status("kettle")["spend"] == 8400
    assert g.status("kettle")["remaining"]["spend"] == 600
    d = g.check("kettle", amount=GBP(2400), enforce=False)
    assert not d.allowed and d.code == "budget_exceeded"
    assert "spend cap exceeded (10800 > 9000 GBP)" in d.reason
    assert d.projected_spend == 10800
    _raises(BudgetExceeded, g.check, "kettle", amount=GBP(2400))
    assert g.check("kettle", amount=GBP(600)).allowed


def test_no_amount_leaves_ledger_alone():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_spend=GBP(100)))
    assert g.check("t").allowed
    g.record("t")
    assert g.status("t")["spend"] == 0


def test_currency_mismatch_refused_before_comparison():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_spend=GBP(100)))
    _raises(ValueError, g.check, "t", amount={"value": 1, "currency": "USD"})
    _raises(ValueError, g.record, "t", amount={"value": 1, "currency": "USD"})


def test_malformed_amounts_refused():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_spend=GBP(100)))
    for bad in ({"value": 1.5, "currency": "GBP"}, {"value": -1, "currency": "GBP"}, {"value": 1},
                {"value": "1", "currency": "GBP"}, {"value": True, "currency": "GBP"}, "x", 5):
        _raises(ValueError, g.check, "t", amount=bad)


def test_malformed_policy_refused():
    for bad in ({"value": 1.5, "currency": "GBP"}, {"value": -1, "currency": "GBP"}, {"value": 1}, "x"):
        _raises(ValueError, BudgetPolicy, max_spend=bad)


def test_without_max_spend_money_is_still_counted():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_calls=10))
    g.record("t", amount=GBP(500))
    g.record("t", amount=GBP(250))
    s = g.status("t")
    assert s["spend"] == 750 and s["remaining"]["spend"] is None and s["limits"]["max_spend"] is None


def test_loop_detection_catches_duplicate_payment():
    g = BudgetGuard()
    g.open("bill", BudgetPolicy(max_spend=GBP(100000), max_repeats=1))
    sig = "pay:MID-10231:11840"
    assert g.check("bill", amount=GBP(11840), signature=sig).allowed
    g.record("bill", amount=GBP(11840), signature=sig)
    _raises(LoopDetected, g.check, "bill", amount=GBP(11840), signature=sig)
    assert g.status("bill")["spend"] == 11840


def test_kill_switch_stops_money():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_spend=GBP(100000)))
    g.kill("t")
    _raises(KillSwitched, g.check, "t", amount=GBP(1))
    g.revive("t")
    assert g.check("t", amount=GBP(1)).allowed


def test_money_and_token_limits_independent():
    g = BudgetGuard()
    g.open("t", BudgetPolicy(max_spend=GBP(100), max_tokens=10))
    assert g.check("t", amount=GBP(100), est_input_tokens=5, est_output_tokens=5).allowed
    d = g.check("t", amount=GBP(1), est_input_tokens=50, enforce=False)
    assert not d.allowed and "token cap" in d.reason


if __name__ == "__main__":
    import sys

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failures = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:
            failures += 1
            print(f"  FAIL  {t.__name__}: {e}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
