/** BudgetGuard: per-task budget, loop detection, and kill-switch middleware for
 *  agent LLM calls. Deterministic, dependency-free, fail-closed.
 *
 *  Token and call budgets need no configuration. USD budgets require a Pricing
 *  table (prices change; supply your own for anything that bills). */

export {
  BudgetGuardDenied,
  BudgetExceeded,
  LoopDetected,
  KillSwitched,
  UnknownTask,
} from "./errors.ts";
export { BudgetGuard, type Decision, type TaskSnapshot } from "./guard.ts";
export { type BudgetPolicy } from "./policy.ts";
export { Pricing, type ModelPrice, DEFAULT_PRICES } from "./pricing.ts";

export const VERSION = "0.0.1";
