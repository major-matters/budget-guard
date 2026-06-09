# BudgetGuard

**Per-task budget, loop detection, and kill-switch middleware for agent LLM calls.** Deterministic, dependency-free, fail-closed. v0.

An agent with a payment credential and a vague instruction is a budget incident waiting to happen. BudgetGuard sits between your agent and its model calls and refuses the next call the moment it would cross a limit you set, before the spend happens, not after.

It is one of three small primitives from [Major Labs](https://majorlabs.co):

> **MandateKit** says what an agent *may* do. **BudgetGuard** caps what it *spends*. **WitnessKit** proves what it *did*.

---

## What it does

Three controls, all enforced before the call runs:

- **Budgets** — cap a task by USD, total tokens, input/output tokens, or call count. The next call is refused if it would cross the cap.
- **Loop detection** — catch runaway agents that repeat the same call. If one signature repeats past a threshold within a sliding window, the call is denied.
- **Kill switch** — halt a single task, or everything, immediately.

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
import { BudgetGuard, Pricing } from "budget-guard";

const guard = new BudgetGuard(new Pricing());
guard.open("research-job", { maxUsd: 0.5, maxCalls: 20, maxRepeats: 3 });

guard.check("research-job", { model: "claude-sonnet-4-6", estInputTokens: 1200, estOutputTokens: 600, signature: sig });
const res = await callYourModel();
guard.record("research-job", { model: "claude-sonnet-4-6", inputTokens: res.usage.input, outputTokens: res.usage.output, signature: sig });
guard.close("research-job");
```

Run the demo: `python3 demo.py` (Python) or `npm run demo` (TypeScript).

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
- **In-memory only.** State lives in the process. A kill switch or ledger does not survive a restart and is not shared across machines. A pluggable store is planned.

---

## License

MIT. Built by [Major Labs](https://majorlabs.co) · [github.com/major-matters](https://github.com/major-matters)
