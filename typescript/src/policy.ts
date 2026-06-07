/** The budget envelope for a task. Any limit left undefined is not enforced. */

export interface BudgetPolicy {
  /** Stop once estimated spend would cross this (needs Pricing). */
  maxUsd?: number;
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
