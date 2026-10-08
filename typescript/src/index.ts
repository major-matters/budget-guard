/** BudgetGuard: per-task budget, loop detection, kill-switch, and spend-velocity
 *  middleware for agent LLM calls. Deterministic, dependency-free, fail-closed.
 *
 *  Token and call budgets need no configuration. USD budgets require a Pricing
 *  table (prices change; supply your own for anything that bills). */

export {
  BudgetGuardDenied,
  BudgetExceeded,
  LoopDetected,
  KillSwitched,
  UnknownTask,
  VelocityDenied,
  VelocitySpendExceeded,
  VelocityCallsExceeded,
  VelocityAnomaly,
} from "./errors.ts";
export { BudgetGuard, type Decision, type TaskSnapshot, type VelocityDetail } from "./guard.ts";
export { type AnomalyAction, type BudgetPolicy, type MoneyAmount } from "./policy.ts";
export { Pricing, type ModelPrice, DEFAULT_PRICES } from "./pricing.ts";

export const VERSION = "0.2.0";
