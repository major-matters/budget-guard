/** BudgetGuard v0 (TypeScript) test suite. Run with: npm test  (node --test). */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BudgetGuard,
  BudgetExceeded,
  LoopDetected,
  KillSwitched,
  UnknownTask,
  Pricing,
  type ModelPrice,
} from "../src/index.ts";

const PRICING = new Pricing({ m: { inputPer1k: 1.0, outputPer1k: 2.0 } as ModelPrice }, { useBuiltin: false });

test("token budget allows under cap", () => {
  const g = new BudgetGuard();
  g.open("t", { maxTokens: 1000 });
  assert.equal(g.check("t", { estInputTokens: 300, estOutputTokens: 200 }).allowed, true);
  g.record("t", { inputTokens: 300, outputTokens: 200 });
  assert.equal(g.status("t").tokens, 500);
  g.close("t");
});

test("token budget fails closed over cap", () => {
  const g = new BudgetGuard();
  g.open("t", { maxTokens: 500 });
  g.record("t", { inputTokens: 400 });
  assert.throws(() => g.check("t", { estInputTokens: 200 }), BudgetExceeded);
  const d = g.check("t", { estInputTokens: 200, enforce: false });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "budget_exceeded");
  g.close("t");
});

test("usd budget uses pricing", () => {
  const g = new BudgetGuard(PRICING);
  g.open("t", { maxUsd: 5.0 });
  g.record("t", { model: "m", inputTokens: 1000, outputTokens: 1000 }); // $3.00
  assert.ok(Math.abs(g.status("t").usd - 3.0) < 1e-9);
  assert.throws(() => g.check("t", { model: "m", estInputTokens: 1000, estOutputTokens: 1000 }), BudgetExceeded);
  g.close("t");
});

test("usd budget without pricing throws", () => {
  const g = new BudgetGuard();
  g.open("t", { maxUsd: 1.0 });
  assert.throws(() => g.check("t", { model: "m", estInputTokens: 10, estOutputTokens: 10 }), /without Pricing/);
  g.close("t");
});

test("call cap", () => {
  const g = new BudgetGuard();
  g.open("t", { maxCalls: 2 });
  g.check("t"); g.record("t");
  g.check("t"); g.record("t");
  assert.throws(() => g.check("t"), BudgetExceeded);
  g.close("t");
});

test("loop detection", () => {
  const g = new BudgetGuard();
  g.open("t", { maxRepeats: 3, repeatWindow: 10 });
  for (let i = 0; i < 3; i++) {
    g.check("t", { signature: "same" });
    g.record("t", { signature: "same" });
  }
  assert.throws(() => g.check("t", { signature: "same" }), LoopDetected);
  assert.equal(g.check("t", { signature: "other" }).allowed, true);
  g.close("t");
});

test("loop window forgets old repeats", () => {
  const g = new BudgetGuard();
  g.open("t", { maxRepeats: 2, repeatWindow: 3 });
  g.check("t", { signature: "a" }); g.record("t", { signature: "a" });
  for (const s of ["b", "c", "d"]) g.record("t", { signature: s });
  assert.equal(g.check("t", { signature: "a" }).allowed, true);
  g.close("t");
});

test("kill switch task and global", () => {
  const g = new BudgetGuard();
  g.open("t", {});
  g.kill("t");
  assert.throws(() => g.check("t"), KillSwitched);
  g.revive("t");
  assert.equal(g.check("t").allowed, true);
  g.kill(); // global
  assert.throws(() => g.check("t"), KillSwitched);
  g.close("t");
});

test("unknown task", () => {
  const g = new BudgetGuard();
  assert.throws(() => g.check("nope"), UnknownTask);
});

test("negative inputs rejected", () => {
  const g = new BudgetGuard();
  g.open("t", {});
  assert.throws(() => g.check("t", { estInputTokens: -1 }), /non-negative/);
  assert.throws(() => g.record("t", { inputTokens: -5 }), /non-negative/);
  g.close("t");
});

test("NaN/Infinity tokens fail closed", () => {
  const g = new BudgetGuard();
  g.open("t", { maxTokens: 100 });
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => g.check("t", { estInputTokens: bad }), /non-negative finite/);
    assert.throws(() => g.record("t", { inputTokens: bad }), /non-negative finite/);
  }
  assert.equal(g.status("t").tokens, 0);
  g.close("t");
});

test("double open rejected", () => {
  const g = new BudgetGuard();
  g.open("t", {});
  assert.throws(() => g.open("t", {}), /already open/);
  g.close("t");
});

test("withTask closes automatically", () => {
  const g = new BudgetGuard();
  g.withTask("t", { maxCalls: 1 }, () => {
    assert.equal(g.check("t").allowed, true);
  });
  assert.throws(() => g.status("t"), UnknownTask); // closed after
});

// -- Audit 2026-06-10 finding #5: record() must fail closed on unpriced models --

test("record throws on an unpriced model under a USD cap", () => {
  const g = new BudgetGuard(new Pricing({ m: { inputPer1k: 1.0, outputPer1k: 2.0 } as ModelPrice }, { useBuiltin: false }));
  g.open("t", { maxUsd: 0.5 });
  g.check("t", { model: "m", estInputTokens: 10, estOutputTokens: 10 });
  assert.throws(() => g.record("t", { model: "unpriced", inputTokens: 10_000_000, outputTokens: 10_000_000 }));
  g.close("t");
});

test("record allows an unpriced model when there is no USD cap", () => {
  const g = new BudgetGuard(new Pricing({ m: { inputPer1k: 1.0, outputPer1k: 2.0 } as ModelPrice }, { useBuiltin: false }));
  g.open("t", { maxCalls: 5 });
  const snap = g.record("t", { model: "unpriced", inputTokens: 100, outputTokens: 100 });
  assert.equal(snap.usd, 0);
  assert.equal(snap.calls, 1);
  g.close("t");
});
