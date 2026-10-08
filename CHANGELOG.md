# Changelog

Notable changes to this repository.

## 0.2.0 (2026-10-08)

Spend-velocity windows and anomaly detection, in Python and TypeScript with
identical semantics, reason strings and detail objects: both suites replay the
same `fixtures/velocity.json` (8 cases, 33 verdicts).

- New policy settings `window_seconds` / `windowSeconds` (positive integer,
  required when any limit below is set), `max_spend_per_window` (money in the
  ledger's currency), `max_calls_per_window`, `anomaly_factor` (greater than 1),
  `baseline_windows` (default 3) and `anomaly_action` ("deny" by default, or
  "flag"). The window caps refuse the call that would cross them
  (`VelocitySpendExceeded`, code `velocity_spend`; `VelocityCallsExceeded`,
  code `velocity_calls`). A recorded call counts while it is less than
  `window_seconds` old.
- Anomaly check: the current window's spend, including the proposed call, is an
  anomaly when it is strictly greater than `anomaly_factor` times the mean spend
  of the trailing `baseline_windows` completed windows. Inactive until that many
  completed windows exist since the task's first recorded call (a cold start
  never fires); empty windows inside the history count as zero, so an active
  zero baseline makes any positive spend an anomaly. Deny mode refuses
  (`VelocityAnomaly`, code `velocity_anomaly`); flag mode allows and sets
  `anomaly: true`. All three exceptions subclass `VelocityDenied`.
- Injected time. `check()` and `record()` take `now` (seconds, int or float);
  the guard takes a `clock` callable at construction; the wall clock is read
  only when neither is given. Every test uses injected times.
- Every decision from a policy with a window carries a plain, serializable
  `velocity` detail (`window_seconds`, `window_spend`, `window_calls`,
  `baseline`, `factor`, `anomaly`, `action`) plus a top-level `anomaly` flag;
  when `check` raises, the detail is in `detail["velocity"]` /
  `detail.velocity`. Snapshots list the velocity limits under `limits`.
- The kill switch and every existing cap are evaluated first, unchanged; the
  velocity checks follow; the first failing check wins. Misconfiguration
  (non-positive or non-integer window, factor of 1 or less, a limit without a
  window, unknown action, currency mismatch with `max_spend`) raises at policy
  construction. Money stays in integer units; no float drift.
- README: new section with examples in both languages; the TypeScript import
  now reads `budget-guard-agents`. Demos gain a fourth scene.
- Tests: Python 51 (was 27), TypeScript 60 (was 28), including three new
  property tests per language. CI now also runs `test_spend.py` and
  `test_velocity.py` standalone.
- Versions aligned at 0.2.0: pyproject.toml, `__version__`, package.json,
  `VERSION`, and the package-lock root entry (which still read 0.0.1 under the
  pre-rename name).

## 0.1.1 (2026-10-07)

TypeScript package only; no change to the ledger or its verdicts. From a
reviewer's run of the sibling MandateKit repository on Node 22.14, the same
fault applied here.

- `npm test`, `npm run test:build` and `npm run demo` now pass
  `--experimental-strip-types`, so they work on Node 22.6 to 22.17 as the
  README promised (type stripping is unflagged only from 22.18).
- README: the Node version note.
- Published to npm as 0.1.1 (0.1.0 was tagged but never published; npm had
  0.0.2 until this release).

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
