/**
 * Spend-velocity windows and anomaly detection (0.2.0). Mirrors
 * python/tests/test_velocity.py; both suites also replay fixtures/velocity.json
 * so the two implementations are proven to agree verdict for verdict.
 *
 * Every call passes an explicit `now`; nothing here touches the wall clock.
 * Run with: npm test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BudgetGuard,
  BudgetExceeded,
  BudgetGuardDenied,
  KillSwitched,
  VelocityAnomaly,
  VelocityCallsExceeded,
  VelocityDenied,
  VelocitySpendExceeded,
  type BudgetPolicy,
  type VelocityDetail,
} from "../src/index.ts";

const GBP = (value: number) => ({ value, currency: "GBP" });
const DETAIL_KEYS = ["windowSeconds", "windowSpend", "windowCalls", "baseline", "factor", "anomaly", "action"].sort();

/** A task that paid 100 once per minute for three minutes: baseline 100 at t=180. */
function threeQuietWindows(overrides: Partial<BudgetPolicy> = {}): BudgetGuard {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, anomalyFactor: 2, baselineWindows: 3, ...overrides });
  for (const t of [0, 60, 120]) g.record("t", { amount: GBP(100), now: t });
  return g;
}

// -- window caps --------------------------------------------------------------

test("window spend cap denies exactly at the boundary and allows one below", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxSpendPerWindow: GBP(1000) });
  g.record("t", { amount: GBP(600), now: 0 });
  assert.equal(g.check("t", { amount: GBP(400), now: 10 }).allowed, true); // exactly the cap
  const d = g.check("t", { amount: GBP(401), now: 10, enforce: false }); // one over
  assert.equal(d.allowed, false);
  assert.equal(d.code, "velocity_spend");
  assert.equal(d.reason, "window spend cap exceeded (1001 > 1000 GBP in 60s)");
  assert.equal(d.velocity?.windowSpend, 1001);
  assert.equal(d.velocity?.windowCalls, 2);
  assert.throws(() => g.check("t", { amount: GBP(401), now: 10 }), (e: unknown) => {
    assert.ok(e instanceof VelocitySpendExceeded && e instanceof VelocityDenied);
    assert.equal(e.code, "velocity_spend");
    assert.deepStrictEqual(e.detail.velocity, d.velocity);
    return true;
  });
});

test("window call cap", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 10, maxCallsPerWindow: 2 });
  g.record("t", { now: 0 });
  g.record("t", { now: 5 });
  const d = g.check("t", { now: 9, enforce: false });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "velocity_calls");
  assert.equal(d.reason, "window call cap exceeded (3 > 2 in 10s)");
  assert.throws(() => g.check("t", { now: 9 }), VelocityCallsExceeded);
  assert.equal(g.check("t", { now: 10 }).allowed, true); // the call at 0 has aged out
});

test("sliding window expiry", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxSpendPerWindow: GBP(1000) });
  g.record("t", { amount: GBP(600), now: 0 });
  assert.equal(g.check("t", { amount: GBP(500), now: 59, enforce: false }).allowed, false); // 59s old still counts
  assert.equal(g.check("t", { amount: GBP(500), now: 60 }).allowed, true); // 60s old has aged out
  assert.equal(g.check("t", { amount: GBP(1000), now: 61 }).velocity?.windowSpend, 1000);
});

// -- anomaly detection --------------------------------------------------------

test("anomaly is inactive before baselineWindows completed buckets exist", () => {
  const g = threeQuietWindows();
  let d = g.check("t", { amount: GBP(10000), now: 179, enforce: false }); // 179 < 3 x 60 of history
  assert.equal(d.allowed, true);
  assert.equal(d.anomaly, false);
  assert.equal(d.velocity?.baseline, null);
  d = g.check("t", { amount: GBP(10000), now: 180, enforce: false }); // history complete: active
  assert.equal(d.allowed, false);
  assert.equal(d.code, "velocity_anomaly");
  assert.equal(d.velocity?.baseline, 100);
});

test("a cold start never trips", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, anomalyFactor: 2 });
  let d = g.check("t", { amount: GBP(1e9), now: 0, enforce: false });
  assert.equal(d.allowed, true);
  assert.equal(d.velocity?.baseline, null);
  g.record("t", { amount: GBP(1e9), now: 0 });
  d = g.check("t", { amount: GBP(1e9), now: 170, enforce: false });
  assert.equal(d.allowed, true);
  assert.equal(d.velocity?.baseline, null);
});

test("anomaly fires at the factor boundary", () => {
  const g = threeQuietWindows();
  assert.equal(g.check("t", { amount: GBP(200), now: 180 }).allowed, true); // 200 > 2 x 100 is false
  const d = g.check("t", { amount: GBP(201), now: 180, enforce: false }); // 201 > 200
  assert.equal(d.allowed, false);
  assert.equal(d.code, "velocity_anomaly");
  assert.equal(d.anomaly, true);
  assert.equal(d.reason, "spend velocity anomaly (201 > 2 x baseline 100 over 60s)");
});

test("fractional baseline", () => {
  const g = threeQuietWindows();
  // At t=250 the buckets hold 100, 100 and nothing: baseline 200 / 3.
  let d = g.check("t", { amount: GBP(133), now: 250, enforce: false });
  assert.equal(d.allowed, true);
  assert.equal(d.velocity?.baseline, 200 / 3);
  d = g.check("t", { amount: GBP(134), now: 250, enforce: false });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "spend velocity anomaly (134 > 2 x baseline 66.66666666666667 over 60s)");
});

test("a zero baseline with history is an anomaly for any positive spend", () => {
  const g = threeQuietWindows();
  let d = g.check("t", { amount: GBP(1), now: 1000, enforce: false });
  assert.equal(d.allowed, false);
  assert.equal(d.velocity?.baseline, 0);
  assert.equal(d.anomaly, true);
  assert.equal(d.reason, "spend velocity anomaly (1 > 2 x baseline 0 over 60s)");
  d = g.check("t", { now: 1000, enforce: false }); // zero spend is not
  assert.equal(d.allowed, true);
  assert.equal(d.anomaly, false);
  assert.equal(d.velocity?.baseline, 0);
});

test("flag mode allows and marks", () => {
  const g = threeQuietWindows({ anomalyAction: "flag" });
  let d = g.check("t", { amount: GBP(201), now: 180 }); // enforce=true does not throw
  assert.equal(d.allowed, true);
  assert.equal(d.anomaly, true);
  assert.equal(d.code, undefined);
  assert.equal(d.reason, undefined);
  assert.equal(d.velocity?.anomaly, true);
  assert.equal(d.velocity?.action, "flag");
  d = g.check("t", { amount: GBP(200), now: 180 });
  assert.equal(d.anomaly, false);
  assert.equal(d.velocity?.action, null);
});

test("deny mode denies with velocity_anomaly", () => {
  const g = threeQuietWindows({ anomalyAction: "deny" });
  assert.throws(() => g.check("t", { amount: GBP(201), now: 180 }), (e: unknown) => {
    assert.ok(e instanceof VelocityAnomaly && e instanceof VelocityDenied && e instanceof BudgetGuardDenied);
    assert.equal(e.code, "velocity_anomaly");
    assert.equal(e.taskId, "t");
    const v = e.detail.velocity as VelocityDetail;
    assert.equal(v.anomaly, true);
    assert.equal(v.action, "deny");
    return true;
  });
});

// -- interplay with the existing controls ---------------------------------------

test("the kill switch still wins", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxCallsPerWindow: 1 });
  g.record("t", { now: 0 });
  g.kill("t");
  const d = g.check("t", { now: 1, enforce: false });
  assert.equal(d.code, "kill_switched");
  assert.equal(d.velocity?.windowCalls, 2);
  assert.throws(() => g.check("t", { now: 1 }), (e: unknown) => {
    assert.ok(e instanceof KillSwitched);
    assert.equal((e.detail.velocity as VelocityDetail).windowCalls, 2);
    return true;
  });
  g.revive("t");
  assert.equal(g.check("t", { now: 1, enforce: false }).code, "velocity_calls");
  g.kill(); // global
  assert.equal(g.check("t", { now: 1, enforce: false }).code, "kill_switched");
});

test("existing caps still win and carry the detail", () => {
  const g = new BudgetGuard();
  g.open("t", { maxSpend: GBP(500), windowSeconds: 60, maxSpendPerWindow: GBP(1000) });
  const d = g.check("t", { amount: GBP(600), now: 0, enforce: false });
  assert.equal(d.code, "budget_exceeded");
  assert.equal(d.reason, "spend cap exceeded (600 > 500 GBP)");
  assert.equal(d.velocity?.windowSpend, 600);
  assert.throws(() => g.check("t", { amount: GBP(600), now: 0 }), (e: unknown) => {
    assert.ok(e instanceof BudgetExceeded);
    assert.equal((e.detail.velocity as VelocityDetail).windowSpend, 600);
    return true;
  });
});

test("the window cap runs before the anomaly check and the detail still reports the anomaly", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxSpendPerWindow: GBP(300), anomalyFactor: 2, baselineWindows: 1 });
  g.record("t", { amount: GBP(100), now: 0 });
  const d = g.check("t", { amount: GBP(301), now: 60, enforce: false });
  assert.equal(d.code, "velocity_spend");
  assert.equal(d.anomaly, true);
  assert.equal(d.velocity?.action, "deny");
});

// -- decision shape, time, configuration -----------------------------------------

test("decision detail object shape, plain and serializable", () => {
  const g = threeQuietWindows();
  const d = g.check("t", { amount: GBP(201), now: 180, enforce: false });
  assert.deepStrictEqual(Object.keys(d.velocity as object).sort(), DETAIL_KEYS);
  assert.deepStrictEqual(d.velocity, {
    windowSeconds: 60, windowSpend: 201, windowCalls: 1, baseline: 100, factor: 2, anomaly: true, action: "deny",
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.velocity)), d.velocity);
  assert.equal(Object.getPrototypeOf(d.velocity), Object.prototype);
  // Without windowSeconds there is no velocity detail at all.
  g.open("plain", { maxCalls: 5 });
  const p = g.check("plain", { enforce: false });
  assert.equal(p.velocity, undefined);
  assert.equal(p.anomaly, false);
});

test("clock injection", () => {
  const ticks = [0, 60, 120, 180, 180];
  const g = new BudgetGuard(undefined, { clock: () => ticks.shift() as number });
  g.open("t", { windowSeconds: 60, anomalyFactor: 2, baselineWindows: 3 });
  for (let i = 0; i < 3; i++) g.record("t", { amount: GBP(100) }); // 0, 60, 120 from the clock
  assert.equal(g.check("t", { amount: GBP(200) }).allowed, true); // 180 from the clock
  assert.equal(g.check("t", { amount: GBP(201), enforce: false }).allowed, false); // 180 from the clock
  assert.equal(g.check("t", { amount: GBP(201), now: 179 }).allowed, true); // explicit now wins, history incomplete
  assert.throws(() => new BudgetGuard(undefined, { clock: 42 as any }), /clock/);
});

test("now is validated even without a window", () => {
  const g = new BudgetGuard();
  g.open("t", { maxCalls: 5 });
  for (const bad of [NaN, Infinity, -Infinity, "0" as any, true as any]) {
    assert.throws(() => g.check("t", { now: bad }), /finite number of seconds/);
    assert.throws(() => g.record("t", { now: bad }), /finite number of seconds/);
  }
  assert.equal(g.status("t").calls, 0);
  assert.equal(g.check("t", { now: 12.5 }).allowed, true); // floats are fine
});

test("misconfiguration throws at open", () => {
  const bad: BudgetPolicy[] = [
    { windowSeconds: -60, maxCallsPerWindow: 1 },
    { windowSeconds: 0, maxCallsPerWindow: 1 },
    { windowSeconds: 1.5, maxCallsPerWindow: 1 },
    { windowSeconds: "60" as any, maxCallsPerWindow: 1 },
    { maxSpendPerWindow: GBP(100) }, // no window
    { maxCallsPerWindow: 3 }, // no window
    { anomalyFactor: 2 }, // no window
    { windowSeconds: 60, anomalyFactor: 1 },
    { windowSeconds: 60, anomalyFactor: 0.5 },
    { windowSeconds: 60, anomalyFactor: Infinity },
    { windowSeconds: 60, anomalyFactor: NaN },
    { windowSeconds: 60, anomalyFactor: true as any },
    { windowSeconds: 60, maxCallsPerWindow: 0 },
    { windowSeconds: 60, maxCallsPerWindow: 2.5 },
    { windowSeconds: 60, maxSpendPerWindow: { value: 1.5, currency: "GBP" } },
    { windowSeconds: 60, maxSpendPerWindow: { value: 10 } as any },
    { windowSeconds: 60, baselineWindows: 0 },
    { windowSeconds: 60, baselineWindows: -1 },
    { windowSeconds: 60, anomalyAction: "block" as any },
    { maxSpend: GBP(100), windowSeconds: 60, maxSpendPerWindow: { value: 10, currency: "USD" } },
  ];
  bad.forEach((policy, i) => {
    const g = new BudgetGuard();
    assert.throws(() => g.open("t", policy), Error, `policy ${i}: ${JSON.stringify(policy)}`);
  });
  // Observe-only: a window with no limits is valid and reports the detail.
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60 });
  assert.equal(g.check("t", { now: 0 }).velocity?.windowCalls, 1);
});

test("the window cap fixes the currency", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxSpendPerWindow: GBP(100) });
  assert.throws(() => g.check("t", { amount: { value: 1, currency: "USD" }, now: 0 }), /currency USD does not match/);
  assert.throws(() => g.record("t", { amount: { value: 1, currency: "USD" }, now: 0 }), /currency USD does not match/);
  assert.equal(g.status("t").calls, 0);
  assert.equal(g.check("t", { amount: GBP(100), now: 0 }).allowed, true);
});

test("status limits include velocity", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxSpendPerWindow: GBP(100), maxCallsPerWindow: 4, anomalyFactor: 3 });
  const lim = g.status("t").limits;
  assert.equal(lim.windowSeconds, 60);
  assert.deepStrictEqual(lim.maxSpendPerWindow, GBP(100));
  assert.equal(lim.maxCallsPerWindow, 4);
  assert.equal(lim.anomalyFactor, 3);
});

test("check does not mutate the window", () => {
  const g = new BudgetGuard();
  g.open("t", { windowSeconds: 60, maxCallsPerWindow: 1 });
  for (let i = 0; i < 5; i++) assert.equal(g.check("t", { now: 0 }).allowed, true);
  g.record("t", { now: 0 });
  assert.equal(g.check("t", { now: 1, enforce: false }).allowed, false);
});

// -- cross-language fixture ---------------------------------------------------------

interface FixtureStep {
  op: "record" | "check" | "kill" | "revive";
  now?: number;
  amount?: { value: number; currency: string };
  expect?: { allowed: boolean; code: string | null; reason: string | null; anomaly: boolean; velocity: Record<string, unknown> };
}
interface FixtureCase { name: string; policy: Record<string, unknown>; steps: FixtureStep[] }

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const camelKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/velocity.json", import.meta.url), "utf8")) as { cases: FixtureCase[] };
assert.ok(fixture.cases.length > 0, "fixture has no cases");
let fixtureChecks = 0;

for (const c of fixture.cases) {
  test(`fixture: ${c.name}`, () => {
    const g = new BudgetGuard();
    g.open("t", camelKeys(c.policy) as BudgetPolicy);
    c.steps.forEach((step, i) => {
      const where = `${c.name} / step ${i}`;
      if (step.op === "record") {
        g.record("t", { amount: step.amount, now: step.now });
      } else if (step.op === "kill") {
        g.kill("t");
      } else if (step.op === "revive") {
        g.revive("t");
      } else if (step.op === "check") {
        const exp = step.expect!;
        const d = g.check("t", { amount: step.amount, now: step.now, enforce: false });
        assert.equal(d.allowed, exp.allowed, where);
        assert.equal(d.code ?? null, exp.code, where);
        assert.equal(d.reason ?? null, exp.reason, where);
        assert.equal(d.anomaly, exp.anomaly, where);
        assert.deepStrictEqual(d.velocity, camelKeys(exp.velocity), where);
        if (!exp.allowed) {
          assert.throws(() => g.check("t", { amount: step.amount, now: step.now }), (e: unknown) => {
            assert.ok(e instanceof BudgetGuardDenied, where);
            assert.equal(e.code, exp.code, where);
            assert.deepStrictEqual(e.detail.velocity, camelKeys(exp.velocity), where);
            return true;
          });
        }
        fixtureChecks++;
      } else {
        throw new Error(`${where}: unknown op ${JSON.stringify((step as FixtureStep).op)}`);
      }
    });
  });
}

test("the fixture exercised enough verdicts", () => {
  assert.ok(fixtureChecks >= 30, `only ${fixtureChecks} fixture checks ran`);
});
