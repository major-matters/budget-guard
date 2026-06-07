/** Property-based tests: the guard must never let the ledger cross a cap it
 *  enforces, no matter the call sequence. Run with: npm test. */

import { test } from "node:test";
import fc from "fast-check";

import { BudgetGuard, Pricing, type ModelPrice } from "../src/index.ts";

const calls = fc.array(
  fc.record({ in: fc.nat({ max: 5000 }), out: fc.nat({ max: 5000 }) }),
  { maxLength: 40 },
);

test("token cap is never crossed by allowed+recorded calls", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 50000 }), calls, (cap, seq) => {
      const g = new BudgetGuard();
      const id = "p";
      g.open(id, { maxTokens: cap });
      for (const c of seq) {
        const d = g.check(id, { estInputTokens: c.in, estOutputTokens: c.out, enforce: false });
        if (!d.allowed) continue; // respect the guard's refusal
        g.record(id, { inputTokens: c.in, outputTokens: c.out });
      }
      const s = g.status(id);
      g.close(id);
      return s.tokens <= cap;
    }),
  );
});

test("call cap is never crossed", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 30 }), fc.nat({ max: 60 }), (cap, attempts) => {
      const g = new BudgetGuard();
      g.open("p", { maxCalls: cap });
      for (let i = 0; i < attempts; i++) {
        const d = g.check("p", { enforce: false });
        if (d.allowed) g.record("p");
      }
      const s = g.status("p");
      g.close("p");
      return s.calls <= cap;
    }),
  );
});

test("usd cap is never crossed", () => {
  const pricing = new Pricing({ m: { inputPer1k: 2.0, outputPer1k: 6.0 } as ModelPrice }, { useBuiltin: false });
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100 }), calls, (capCents, seq) => {
      const cap = capCents / 100;
      const g = new BudgetGuard(pricing);
      g.open("p", { maxUsd: cap });
      for (const c of seq) {
        const d = g.check("p", { model: "m", estInputTokens: c.in, estOutputTokens: c.out, enforce: false });
        if (!d.allowed) continue;
        g.record("p", { model: "m", inputTokens: c.in, outputTokens: c.out });
      }
      const s = g.status("p");
      g.close("p");
      // allow tiny float slack
      return s.usd <= cap + 1e-9;
    }),
  );
});

test("exceeding maxRepeats identical signatures always denies", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10 }), fc.string(), (maxRepeats, sig) => {
      const g = new BudgetGuard();
      g.open("p", { maxRepeats, repeatWindow: 100 });
      for (let i = 0; i < maxRepeats; i++) {
        g.check("p", { signature: sig });
        g.record("p", { signature: sig });
      }
      const d = g.check("p", { signature: sig, enforce: false });
      g.close("p");
      return d.allowed === false && d.code === "loop_detected";
    }),
  );
});
