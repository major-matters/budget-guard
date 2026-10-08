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

// -- Spend velocity (0.2.0). Times are injected; the wall clock is never read. --

const GBP = (value: number) => ({ value, currency: "GBP" });
const velocityCalls = fc.array(
  fc.record({ dt: fc.nat({ max: 30 }), amount: fc.nat({ max: 500 }) }), // dt = seconds since the last call
  { maxLength: 60 },
);

test("window spend cap is never crossed inside the trailing window", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 2000 }), velocityCalls, (cap, seq) => {
      const w = 60;
      const g = new BudgetGuard();
      g.open("p", { windowSeconds: w, maxSpendPerWindow: GBP(cap) });
      const recorded: { at: number; v: number }[] = [];
      let now = 0;
      for (const c of seq) {
        now += c.dt;
        const d = g.check("p", { amount: GBP(c.amount), now, enforce: false });
        if (!d.allowed) {
          if (d.code !== "velocity_spend") return false;
          continue;
        }
        g.record("p", { amount: GBP(c.amount), now });
        recorded.push({ at: now, v: c.amount });
        // Independent recomputation of the money in (now - w, now].
        const inWindow = recorded.filter((r) => now - r.at < w).reduce((a, r) => a + r.v, 0);
        if (inWindow > cap) return false;
      }
      g.close("p");
      return true;
    }),
  );
});

test("window call cap is never crossed inside the trailing window", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 10 }), fc.array(fc.nat({ max: 30 }), { maxLength: 60 }), (cap, dts) => {
      const w = 60;
      const g = new BudgetGuard();
      g.open("p", { windowSeconds: w, maxCallsPerWindow: cap });
      const recorded: number[] = [];
      let now = 0;
      for (const dt of dts) {
        now += dt;
        const d = g.check("p", { now, enforce: false });
        if (!d.allowed) {
          if (d.code !== "velocity_calls") return false;
          continue;
        }
        g.record("p", { now });
        recorded.push(now);
        if (recorded.filter((t) => now - t < w).length > cap) return false;
      }
      g.close("p");
      return true;
    }),
  );
});

test("the anomaly baseline needs history, and flag mode never denies", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 4 }),
      fc.array(fc.record({ dt: fc.nat({ max: 50 }), amount: fc.nat({ max: 1000 }) }), { maxLength: 40 }),
      (n, seq) => {
        const w = 30;
        const g = new BudgetGuard();
        g.open("p", { windowSeconds: w, anomalyFactor: 2, baselineWindows: n, anomalyAction: "flag" });
        let now = 0;
        let first: number | null = null;
        for (const c of seq) {
          now += c.dt;
          const d = g.check("p", { amount: GBP(c.amount), now, enforce: false });
          if (!d.allowed) return false;
          const hasHistory = first != null && now - first >= n * w;
          if (hasHistory) {
            if (d.velocity!.baseline == null) return false;
          } else if (d.velocity!.baseline != null || d.anomaly) {
            return false;
          }
          if (d.anomaly !== d.velocity!.anomaly) return false;
          g.record("p", { amount: GBP(c.amount), now });
          if (first == null) first = now;
        }
        g.close("p");
        return true;
      },
    ),
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
