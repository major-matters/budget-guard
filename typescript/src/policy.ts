/** The budget envelope for a task. Any limit left undefined is not enforced. */

/** An amount of money in a caller-chosen integer unit (pence, cents, whole
 *  units) and a currency, the same convention as MandateKit. */
export interface MoneyAmount {
  value: number;
  currency: string;
}

/** What happens when the current window's spend is an anomaly: refuse the call
 *  (fail closed) or allow it and mark the decision. */
export type AnomalyAction = "deny" | "flag";

export interface BudgetPolicy {
  /** Stop once estimated spend would cross this (needs Pricing). */
  maxUsd?: number;
  /** Cumulative money the task may move out, across every guarded action.
   *  MandateKit caps a single transaction; this caps the running total. */
  maxSpend?: MoneyAmount;
  /** Total input+output tokens. */
  maxTokens?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Number of guarded calls. */
  maxCalls?: number;
  /** Same call signature this many times within the window -> LoopDetected. Default 3. */
  maxRepeats?: number;
  /** How many recent signatures to consider when counting repeats. Default 20. */
  repeatWindow?: number;

  // Spend velocity (0.2.0). A total cap says how much; these say how fast.

  /** Length of the sliding window in seconds (positive integer). Required when
   *  maxSpendPerWindow, maxCallsPerWindow or anomalyFactor is set. */
  windowSeconds?: number;
  /** Money that may move in any one window, in the ledger's currency (must match
   *  maxSpend's currency when both are set) -> VelocitySpendExceeded, code velocity_spend. */
  maxSpendPerWindow?: MoneyAmount;
  /** Guarded calls that fit in any one window -> VelocityCallsExceeded, code velocity_calls. */
  maxCallsPerWindow?: number;
  /** The current window's spend, including the proposed call, is an anomaly when
   *  it exceeds this many times the mean spend of the trailing completed windows.
   *  Greater than 1. */
  anomalyFactor?: number;
  /** How many completed windows feed the baseline, and how many must exist since
   *  the task's first recorded event before the anomaly check is active. Default 3. */
  baselineWindows?: number;
  /** "deny" (default, fail closed -> VelocityAnomaly, code velocity_anomaly) or
   *  "flag" (allow, mark the decision with anomaly: true). */
  anomalyAction?: AnomalyAction;
}

/** Policy with defaults applied. */
export interface ResolvedPolicy extends BudgetPolicy {
  maxRepeats: number | undefined;
  repeatWindow: number;
  baselineWindows: number;
  anomalyAction: AnomalyAction;
}

const POSITIVE_KEYS: (keyof BudgetPolicy)[] = [
  "maxUsd",
  "maxTokens",
  "maxInputTokens",
  "maxOutputTokens",
  "maxCalls",
  "maxRepeats",
];

function checkMoneyShape(name: string, m: unknown): asserts m is MoneyAmount {
  const a = m as MoneyAmount;
  if (!a || typeof a !== "object" || !Number.isInteger(a.value) || a.value < 0 || a.value > Number.MAX_SAFE_INTEGER || typeof a.currency !== "string" || !a.currency) {
    throw new Error(`${name} must be {value: integer >= 0, currency: string}`);
  }
}

function positiveInt(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
}

/** The money cap that fixes the currency every `amount` must carry: maxSpend when
 *  set, else maxSpendPerWindow, else undefined (any currency is counted). */
export function spendCurrency(p: ResolvedPolicy): MoneyAmount | undefined {
  return p.maxSpend ?? p.maxSpendPerWindow;
}

export function resolvePolicy(p: BudgetPolicy = {}): ResolvedPolicy {
  for (const k of POSITIVE_KEYS) {
    const v = p[k];
    if (v != null && (typeof v !== "number" || !(v > 0))) {
      throw new Error(`${k} must be a positive number, got ${JSON.stringify(v)}`);
    }
  }
  if (p.maxSpend != null) checkMoneyShape("maxSpend", p.maxSpend);
  const repeatWindow = p.repeatWindow ?? 20;
  if (typeof repeatWindow !== "number" || !(repeatWindow > 0)) {
    throw new Error("repeatWindow must be positive");
  }

  // Spend velocity: every setting is validated here so a bad policy fails closed
  // before it can guard anything.
  if (p.windowSeconds != null) positiveInt("windowSeconds", p.windowSeconds);
  if (p.maxSpendPerWindow != null) {
    checkMoneyShape("maxSpendPerWindow", p.maxSpendPerWindow);
    if (p.maxSpend != null && p.maxSpend.currency !== p.maxSpendPerWindow.currency) {
      throw new Error(
        `maxSpendPerWindow currency ${p.maxSpendPerWindow.currency} does not match maxSpend currency ${p.maxSpend.currency}`,
      );
    }
  }
  if (p.maxCallsPerWindow != null) positiveInt("maxCallsPerWindow", p.maxCallsPerWindow);
  if (p.anomalyFactor != null && (typeof p.anomalyFactor !== "number" || !Number.isFinite(p.anomalyFactor) || !(p.anomalyFactor > 1))) {
    throw new Error(`anomalyFactor must be a finite number greater than 1, got ${JSON.stringify(p.anomalyFactor)}`);
  }
  const baselineWindows = p.baselineWindows ?? 3;
  positiveInt("baselineWindows", baselineWindows);
  const anomalyAction = p.anomalyAction ?? "deny";
  if (anomalyAction !== "deny" && anomalyAction !== "flag") {
    throw new Error(`anomalyAction must be "deny" or "flag", got ${JSON.stringify(anomalyAction)}`);
  }
  if (p.windowSeconds == null && (p.maxSpendPerWindow != null || p.maxCallsPerWindow != null || p.anomalyFactor != null)) {
    throw new Error("windowSeconds is required when maxSpendPerWindow, maxCallsPerWindow or anomalyFactor is set");
  }

  return {
    ...p,
    maxRepeats: "maxRepeats" in p ? p.maxRepeats : 3,
    repeatWindow,
    baselineWindows,
    anomalyAction,
  };
}
