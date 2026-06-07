/** Token-to-USD pricing. Only needed when a policy sets maxUsd; token and call
 *  budgets work with no pricing at all.
 *
 *  The built-in table is ILLUSTRATIVE and will drift. Supply your own verified
 *  prices (per 1,000 tokens) for anything that bills. */

export interface ModelPrice {
  /** USD per 1,000 input tokens. */
  inputPer1k: number;
  /** USD per 1,000 output tokens. */
  outputPer1k: number;
}

/** Illustrative only. Verify against the provider's current pricing. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPer1k: 15 / 1000, outputPer1k: 75 / 1000 },
  "claude-sonnet-4-6": { inputPer1k: 3 / 1000, outputPer1k: 15 / 1000 },
  "claude-haiku-4-5": { inputPer1k: 1 / 1000, outputPer1k: 5 / 1000 },
};

export class Pricing {
  private prices: Record<string, ModelPrice>;
  private fallback?: ModelPrice;

  constructor(
    prices?: Record<string, ModelPrice>,
    opts: { default?: ModelPrice; useBuiltin?: boolean } = {},
  ) {
    const useBuiltin = opts.useBuiltin ?? true;
    this.prices = useBuiltin ? { ...DEFAULT_PRICES } : {};
    if (prices) Object.assign(this.prices, prices);
    this.fallback = opts.default;
    for (const [k, v] of Object.entries(this.prices)) {
      if (v.inputPer1k < 0 || v.outputPer1k < 0) throw new Error(`prices must be non-negative: ${k}`);
    }
    if (this.fallback && (this.fallback.inputPer1k < 0 || this.fallback.outputPer1k < 0)) {
      throw new Error("default price must be non-negative");
    }
  }

  has(model?: string): boolean {
    return (model != null && model in this.prices) || this.fallback != null;
  }

  cost(model: string | undefined, inputTokens: number, outputTokens: number): number {
    const mp = (model != null ? this.prices[model] : undefined) ?? this.fallback;
    if (!mp) {
      throw new Error(
        `no price for model ${JSON.stringify(model)}. Add it, set a default ModelPrice, ` +
          `or use a token budget instead of maxUsd.`,
      );
    }
    return (inputTokens / 1000) * mp.inputPer1k + (outputTokens / 1000) * mp.outputPer1k;
  }
}
