# BudgetGuard

[![MCP Surface Check: low surface](https://img.shields.io/badge/MCP_Surface_Check-low-4FA86A)](https://majorlabs.co/security)

**Per-task budget, loop detection, and kill-switch middleware for agent LLM calls.** Deterministic, dependency-free, fail-closed. v0.

An agent with a payment credential and a vague instruction is a budget incident waiting to happen. BudgetGuard sits between your agent and its model calls and refuses the next call the moment it would cross a limit you set, before the spend happens, not after.

It is part of the five-kit agent-safety suite from [Major Labs](https://majorlabs.co):

> **[IdentityKit](https://github.com/major-matters/identitykit)** says who the agent is. **[MandateKit](https://github.com/major-matters/mandatekit)** says what it may do. **[BudgetGuard](https://github.com/major-matters/budget-guard)** caps what it spends. **[WitnessKit](https://github.com/major-matters/witnesskit)** proves what it did. **[RememberKit](https://github.com/major-matters/rememberkit)** governs what it remembers.

---

## What it does

Four controls, all enforced before the call runs:

- **Budgets** — cap a task by USD, total tokens, input/output tokens, or call count. The next call is refused if it would cross the cap.
- **Loop detection** — catch runaway agents that repeat the same call. If one signature repeats past a threshold within a sliding window, the call is denied.
- **Kill switch** — halt a single task, or everything, immediately.
- **Spend velocity** (0.2.0): cap how much money, or how many calls, fit in a sliding window, and deny or flag a window that breaks the task's own recent pattern.

BudgetGuard never makes the model call itself. You ask it whether the next call is allowed (`check`), make the call, then tell it what actually happened (`record`).

---

## Install

```bash
pip install budget-guard-agents   # Python 3.8+
npm install budget-guard-agents   # Node 22.6+
```

Token and call budgets work with zero configuration. USD budgets need a pricing table (see below).

---

## Quickstart (Python)

```python
from budgetguard import BudgetGuard, BudgetPolicy, Pricing

guard = BudgetGuard(pricing=Pricing())  # pricing only needed for USD budgets

with guard.task("research-job", BudgetPolicy(max_usd=0.50, max_calls=20, max_repeats=3)):
    sig = "search(query='...')"
    # BEFORE the model call: raises BudgetExceeded / LoopDetected / KillSwitched
    guard.check("research-job", model="claude-sonnet-4-6",
                est_input_tokens=1200, est_output_tokens=600, signature=sig)

    response = call_your_model(...)   # you make the call

    # AFTER: record the real usage
    guard.record("research-job", model="claude-sonnet-4-6",
                 input_tokens=response.usage.input_tokens,
                 output_tokens=response.usage.output_tokens, signature=sig)
```

Prefer not to use exceptions? `guard.check(..., enforce=False)` returns a `Decision(allowed=False, reason=...)` instead of raising.

## Quickstart (TypeScript)

```ts
import { BudgetGuard, Pricing } from "budget-guard-agents";

const guard = new BudgetGuard(new Pricing());
guard.open("research-job", { maxUsd: 0.5, maxCalls: 20, maxRepeats: 3 });

guard.check("research-job", { model: "claude-sonnet-4-6", estInputTokens: 1200, estOutputTokens: 600, signature: sig });
const res = await callYourModel();
guard.record("research-job", { model: "claude-sonnet-4-6", inputTokens: res.usage.input, outputTokens: res.usage.output, signature: sig });
guard.close("research-job");
```

Run the demo: `python3 demo.py` (Python) or `npm run demo` (TypeScript).

---

## Money, not just tokens (0.1.0)

The same ledger caps the money an agent moves out. `maxSpend` / `max_spend`
is a cumulative cap across every guarded action, in an integer unit plus a
currency (the MandateKit convention), checked before the action and recorded
after it. MandateKit caps a single transaction; BudgetGuard caps the running
total, which is the difference between "£90 per item" and "£90 for the job".

```python
guard.open("kettle", BudgetPolicy(max_spend={"value": 9000, "currency": "GBP"}, max_repeats=1))
guard.check("kettle", amount={"value": 8400, "currency": "GBP"}, signature="pay:acme:8400")
guard.record("kettle", amount={"value": 8400, "currency": "GBP"}, signature="pay:acme:8400")
guard.check("kettle", amount={"value": 2400, "currency": "GBP"})   # BudgetExceeded: 10800 > 9000 GBP
```

```ts
guard.open("kettle", { maxSpend: { value: 9000, currency: "GBP" }, maxRepeats: 1 });
guard.check("kettle", { amount: { value: 8400, currency: "GBP" }, signature: "pay:acme:8400" });
```

A currency that does not match the policy is refused before any comparison.
With `maxRepeats` set to 1, loop detection catches the same payment made
twice; the kill switch stops money mid-task the way it stops model calls.

## Spend-velocity windows and anomaly detection (0.2.0)

A total cap says how much a task may spend. A velocity window says how fast.
`window_seconds` / `windowSeconds` opens a sliding window over the task's
recorded calls; `max_spend_per_window` and `max_calls_per_window` cap what fits
in it, and `anomaly_factor` compares the current window with the task's own
recent history. Time is injected: pass `now` (seconds, int or float) to every
`check` and `record`, or give the guard a `clock` at construction. The wall
clock is used only when neither is supplied, so tests and replays are
deterministic.

```python
from budgetguard import BudgetGuard, BudgetPolicy, VelocityDenied

guard = BudgetGuard()   # or BudgetGuard(clock=time.time) and omit now= below
guard.open("payouts", BudgetPolicy(window_seconds=60, max_spend_per_window={"value": 50000, "currency": "GBP"},
                                   max_calls_per_window=20, anomaly_factor=3, baseline_windows=3, anomaly_action="deny"))
guard.check("payouts", amount={"value": 2500, "currency": "GBP"}, now=1_700_000_000)    # raises a VelocityDenied subclass
guard.record("payouts", amount={"value": 2500, "currency": "GBP"}, now=1_700_000_000)
print(guard.check("payouts", amount={"value": 2500, "currency": "GBP"}, now=1_700_000_030, enforce=False).velocity)
```

```ts
import { BudgetGuard, VelocityDenied } from "budget-guard-agents";

const guard = new BudgetGuard(undefined, { clock: () => Date.now() / 1000 });   // or pass now per call
guard.open("payouts", { windowSeconds: 60, maxSpendPerWindow: { value: 50000, currency: "GBP" },
                        maxCallsPerWindow: 20, anomalyFactor: 3, baselineWindows: 3, anomalyAction: "flag" });
const d = guard.check("payouts", { amount: { value: 2500, currency: "GBP" }, now: 1_700_000_000, enforce: false });
guard.record("payouts", { amount: { value: 2500, currency: "GBP" }, now: 1_700_000_000 });
console.log(d.velocity);   // { windowSeconds: 60, windowSpend: 2500, windowCalls: 1, baseline: null, factor: 3, anomaly: false, action: null }
```

The semantics, identical in both languages:

- **Window caps.** `max_spend_per_window` refuses the call when the money
  recorded in the last `window_seconds`, plus the proposed `amount`, exceeds the
  cap (code `velocity_spend`, exception `VelocitySpendExceeded`).
  `max_calls_per_window` refuses when the calls recorded in the last
  `window_seconds`, plus this one, exceed the cap (code `velocity_calls`,
  `VelocityCallsExceeded`). A recorded call counts while it is less than
  `window_seconds` old; at exactly `window_seconds` it has aged out. Money is the
  integer-unit ledger from 0.1.0, so there is no float drift. The window cap's
  currency must match `max_spend` when both are set, and every `amount` must
  match it.
- **Anomaly detection.** The current window is the bucket ending at `now`; the
  `window_seconds` before it is completed bucket 1, the `window_seconds` before
  that bucket 2, and so on. The baseline is the mean spend of the most recent
  `baseline_windows` completed buckets (default 3). It is active only once the
  task's first recorded call is at least `baseline_windows` times
  `window_seconds` old, so every bucket in the mean lies inside the task's
  history; empty buckets inside that history count as zero. The call is an
  anomaly when the current window's spend, including the proposed amount, is
  strictly greater than `anomaly_factor` times the baseline. With an active
  baseline of zero, any positive spend is therefore an anomaly; before the
  baseline is active nothing trips, so a cold start never fires.
  `anomaly_action="deny"` (the default) refuses with code `velocity_anomaly`
  (`VelocityAnomaly`); `"flag"` allows the call and sets `anomaly: true` on the
  decision.
- **Order.** The kill switch, loop detection, call cap, token caps, spend cap
  and USD cap are evaluated first, exactly as before; then the window spend
  cap, the window call cap, and the anomaly check. The first failing check wins
  and reports its own reason.
- **Detail.** Every decision from a policy with `window_seconds` carries
  `velocity`: `window_seconds`, `window_spend` and `window_calls` (both
  including the proposed call), `baseline` (null while inactive), `factor`,
  `anomaly`, and `action` (null, `"deny"` or `"flag"`). It is a plain dict or
  object, so it serializes into a WitnessKit trail unchanged, and when `check`
  raises it travels in `detail["velocity"]` / `detail.velocity`. The two
  implementations produce identical verdicts, reason strings and detail
  objects: both test suites replay `fixtures/velocity.json`.
- **Misconfiguration fails closed.** A non-positive or non-integer window, a
  factor of 1 or less, a velocity limit without `window_seconds`, an unknown
  `anomaly_action`, or a window cap in a different currency from `max_spend`
  raises when the policy is built.
- **Limitation.** Velocity state is in memory, single process, and per guard
  instance: two guards, or two processes, each see only their own calls. `now`
  is expected not to go backwards within a task.

---

## Pricing

USD budgets need to convert tokens to dollars. The built-in price table is **illustrative and will drift** — do not trust it for billing. Supply your own verified prices (per 1,000 tokens):

```python
from budgetguard import Pricing, ModelPrice
pricing = Pricing({"my-model": ModelPrice(input_per_1k=0.003, output_per_1k=0.015)})
```

If you only use token or call budgets, you do not need pricing at all.

---

## Honest limitations (v0)

- **Concurrency is check-then-act.** `check` and `record` are individually safe, but the model call happens between them. Two calls running concurrently under the same task can both pass `check` before either records, and overshoot the cap. For now, run one guarded call per task at a time, or treat the cap as a soft ceiling under concurrency. A reserve/commit API is planned.
- **USD enforcement carries float drift.** Costs are floating point; the cap may be honored to within a fraction of a cent, not exactly.
- **Loop detection is signature-based.** It only catches loops you give it a stable signature for (e.g. a hash of the prompt and tool arguments). It does not infer loops on its own.
- **In-memory only.** State lives in the process. A kill switch or ledger does not survive a restart and is not shared across machines. Spend-velocity windows are per guard instance for the same reason. A pluggable store is planned.

---

---

## The accountability stack, September 2026

This year's frontier launches arrived alongside rogue-agent incidents that investigators struggled to attribute, and a written admission from inside the labs that runtime monitoring is degrading. The accountability primitives those events call for are what this suite implements:

> **[IdentityKit](https://github.com/major-matters/identitykit)** says who the agent is. **[MandateKit](https://github.com/major-matters/mandatekit)** says what it may do. **[BudgetGuard](https://github.com/major-matters/budget-guard)** caps what it spends. **[WitnessKit](https://github.com/major-matters/witnesskit)** proves what it did. **[RememberKit](https://github.com/major-matters/rememberkit)** governs what it remembers.

The [MM Control Stack Compact](https://www.majormatters.co/p/open-letter-control-stack-compact) (September 2026) proposes six verifiable commitments for frontier-AI accountability. Attributable agents and contractually bounded authority need running code, not pledges. This suite is a working v0 of that layer.

## License

MIT. Built by [Major Labs](https://majorlabs.co) · [github.com/major-matters](https://github.com/major-matters)
