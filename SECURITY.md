# Security

BudgetGuard is a guardrail. Its job is to refuse a call that would breach a limit, so its central property is that it **fails closed**: any malformed input, unknown state, or internal error must result in a denial or a raised error, never a silent allow.

## Threat model

BudgetGuard assumes the caller is cooperative but the *agent under control* may not be. It defends against:

- an agent that loops, retrying the same call forever;
- an agent (or prompt-injected instruction) that tries to run up spend past a budget;
- an operator needing to halt a task immediately.

It does **not** defend against a malicious *caller* who lies about token counts after the fact, bypasses the guard entirely, or tampers with the in-memory ledger. Pair it with [WitnessKit](https://github.com/major-matters) if you need a tamper-evident record of what actually ran.

## Fail-closed guarantees

- A call is permitted only if `check()` returns a `Decision(allowed=True)`. Every limit breach raises a `BudgetGuardDenied` subclass (or returns `allowed=False` when `enforce=False`).
- Token inputs are validated to be finite, non-negative numbers. `NaN` and `Infinity` are rejected, not allowed through. (Regression-tested: `NaN` once slipped past comparison checks and is now blocked in both runtimes.)
- A USD budget with no usable price for the model raises rather than under-counting the spend.
- Property-based tests assert that no sequence of `check`/`record` calls leaves the ledger above a cap the policy enforces.

## Known limitations

- **Concurrency (check-then-act).** The model call happens between `check` and `record`. Concurrent guarded calls on one task can each pass `check` before either records and overshoot the cap. Treat caps as soft ceilings under concurrency until the planned reserve/commit API lands.
- **Float precision.** USD caps are enforced in floating point and may drift by a fraction of a cent.
- **In-memory state.** Ledger and kill switches do not survive a process restart and are not shared across processes or machines.

## Testing

- Python: `python3 tests/test_budgetguard.py`, `python3 tests/test_properties.py` (hypothesis), `bandit -r budgetguard`.
- TypeScript: `npm test` (node --test, includes fast-check property tests).

## Reporting

This is a v0 research artifact. Open an issue at [github.com/major-matters](https://github.com/major-matters) for anything that looks like a fail-open.

## Audit status (v0)

This is a v0 release. It has been independently hardened — CodeQL, bandit, semgrep, property-based tests, and adversarial tier 1-2 reviews, all passing in CI — but it has **not** had a third-party security audit. Treat it accordingly for anything high-stakes.

## Security review welcome

We actively want researcher eyes on this. If you find a fail-open, a signature bypass, an SSRF path, or any way to defeat a guarantee in this document, please open an issue. Credit given. The fail-closed enforcement (budget, loop, and kill-switch checks) is the highest-value target.

## v0.0.2 hardening (2026-06-10 internal audit)

- **record() fail-open fixed.** Under a USD cap, recording usage for a model with no price now raises (matching `check()`), instead of silently recording $0 and letting spend run unbounded. With no USD cap, an unpriced model is still recorded best-effort.
- **Loop detection (clarification).** Loop detection counts only byte-identical signatures within a sliding window. Supply a *semantic* (normalized) signature for the action, not raw text, or a perturbed/interleaved loop can evade it; the counter is windowed, not cumulative.
