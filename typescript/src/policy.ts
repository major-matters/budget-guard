/** The budget envelope for a task. Any limit left undefined is not enforced. */

/** An amount of money in a caller-chosen integer unit (pence, cents, whole
 *  units) and a currency, the same convention as MandateKit. */
export interface MoneyAmount {
  value: number;
  currency: string;
}

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
}

/** Policy with defaults applied. */
export interface ResolvedPolicy extends BudgetPolicy {
  maxRepeats: number | undefined;
  repeatWindow: number;
}

const POSITIVE_KEYS: (keyof BudgetPolicy)[] = [
  "maxUsd",
  "maxTokens",
  "maxInputTokens",
  "maxOutputTokens",
  "maxCalls",
  "maxRepeats",
];

export function resolvePolicy(p: BudgetPolicy = {}): ResolvedPolicy {
  for (const k of POSITIVE_KEYS) {
    const v = p[k];
    if (v != null && (typeof v !== "number" || !(v > 0))) {
      throw new Error(`${k} must be a positive number, got ${JSON.stringify(v)}`);
    }
  }
  if (p.maxSpend != null) {
    const m = p.maxSpend;
    if (!m || typeof m !== "object" || !Number.isInteger(m.value) || m.value < 0 || m.value > Number.MAX_SAFE_INTEGER || typeof m.currency !== "string" || !m.currency) {
      throw new Error("maxSpend must be {value: integer >= 0, currency: string}");
    }
  }
  const repeatWindow = p.repeatWindow ?? 20;
  if (typeof repeatWindow !== "number" || !(repeatWindow > 0)) {
    throw new Error("repeatWindow must be positive");
  }
  return {
    ...p,
    maxRepeats: "maxRepeats" in p ? p.maxRepeats : 3,
    repeatWindow,
  };
}
