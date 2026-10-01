# Changelog

Notable changes to this repository.

## 0.1.0 (2026-10-01)

Built for the Mandate Sandbox, the bank-facing demo of the five-kit suite.

- New policy limit `max_spend` / `maxSpend`: `{value: integer, currency}`,
  a cumulative cap on the money a task moves out across every guarded action.
  `check(amount=...)` refuses the action that would cross it
  (`BudgetExceeded`, code `budget_exceeded`, with `projected_spend`);
  `record(amount=...)` commits what actually moved. Snapshots gain `spend`,
  `limits.max_spend` and `remaining.spend`.
- A currency that does not match the policy's, or a malformed amount, raises
  before any comparison (fail closed). Money is counted even without a cap.
- Tests: 9 new per language (`test_spend.py`, `spend.test.ts`).

## 2026-09-08

- README: suite reference corrected to five kits.
- README: added "The accountability stack, September 2026" positioning section
  linking the suite to the MM Control Stack Compact.
