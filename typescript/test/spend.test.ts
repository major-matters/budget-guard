/**
 * The money ledger: maxSpend caps the running total a task moves out, in the
 * same integer-unit-plus-currency convention as MandateKit. Added for the
 * Mandate Sandbox (2026-10-01). Run with: npm test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BudgetGuard } from "../src/guard.ts";
import { BudgetExceeded, LoopDetected, KillSwitched } from "../src/errors.ts";

const GBP = (value: number) => ({ value, currency: "GBP" });

test("maxSpend lets a task spend up to the cap and refuses the step that would cross it", () => {
  const g = new BudgetGuard();
  g.open("kettle", { maxSpend: GBP(9000) });
  assert.equal(g.check("kettle", { amount: GBP(8400) }).allowed, true);
  g.record("kettle", { amount: GBP(8400) });
  assert.equal(g.status("kettle").spend, 8400);
  assert.equal(g.status("kettle").remaining.spend, 600);
  const d = g.check("kettle", { amount: GBP(2400), enforce: false });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "budget_exceeded");
  assert.match(d.reason ?? "", /spend cap exceeded \(10800 > 9000 GBP\)/);
  assert.equal(d.projectedSpend, 10800);
  assert.throws(() => g.check("kettle", { amount: GBP(2400) }), BudgetExceeded);
  // Spending exactly the remainder is fine.
  assert.equal(g.check("kettle", { amount: GBP(600) }).allowed, true);
});

test("a check with no amount does not touch the money ledger", () => {
  const g = new BudgetGuard();
  g.open("t", { maxSpend: GBP(100) });
  assert.equal(g.check("t", {}).allowed, true);
  g.record("t", {});
  assert.equal(g.status("t").spend, 0);
});

test("a currency that does not match the policy is refused before any comparison", () => {
  const g = new BudgetGuard();
  g.open("t", { maxSpend: GBP(100) });
  assert.throws(() => g.check("t", { amount: { value: 1, currency: "USD" } }), /currency USD does not match/);
  assert.throws(() => g.record("t", { amount: { value: 1, currency: "USD" } }), /currency USD does not match/);
});

test("non-integer, negative or malformed amounts are refused", () => {
  const g = new BudgetGuard();
  g.open("t", { maxSpend: GBP(100) });
  for (const bad of [{ value: 1.5, currency: "GBP" }, { value: -1, currency: "GBP" }, { value: 1 } as any, { value: "1", currency: "GBP" } as any, "x" as any, 5 as any]) {
    assert.throws(() => g.check("t", { amount: bad }), Error, JSON.stringify(bad));
  }
});

test("a malformed maxSpend policy is refused at open", () => {
  const g = new BudgetGuard();
  for (const bad of [{ value: 1.5, currency: "GBP" }, { value: -1, currency: "GBP" }, { value: 1 } as any, "x" as any]) {
    assert.throws(() => g.open("t-" + JSON.stringify(bad), { maxSpend: bad }), Error);
  }
});

test("without maxSpend the ledger still counts money, for the record", () => {
  const g = new BudgetGuard();
  g.open("t", { maxCalls: 10 });
  g.record("t", { amount: GBP(500) });
  g.record("t", { amount: GBP(250) });
  const s = g.status("t");
  assert.equal(s.spend, 750);
  assert.equal(s.remaining.spend, null);
  assert.equal(s.limits.maxSpend, undefined);
});

test("loop detection catches the same payment made twice when maxRepeats is 1", () => {
  const g = new BudgetGuard();
  g.open("bill", { maxSpend: GBP(100000), maxRepeats: 1 });
  const sig = "pay:MID-10231:11840";
  assert.equal(g.check("bill", { amount: GBP(11840), signature: sig }).allowed, true);
  g.record("bill", { amount: GBP(11840), signature: sig });
  assert.throws(() => g.check("bill", { amount: GBP(11840), signature: sig }), LoopDetected);
  assert.equal(g.status("bill").spend, 11840);
});

test("the kill switch stops money moving mid-task", () => {
  const g = new BudgetGuard();
  g.open("t", { maxSpend: GBP(100000) });
  g.kill("t");
  assert.throws(() => g.check("t", { amount: GBP(1) }), KillSwitched);
  g.revive("t");
  assert.equal(g.check("t", { amount: GBP(1) }).allowed, true);
});

test("money and token limits are independent", () => {
  const g = new BudgetGuard();
  g.open("t", { maxSpend: GBP(100), maxTokens: 10 });
  assert.equal(g.check("t", { amount: GBP(100), estInputTokens: 5, estOutputTokens: 5 }).allowed, true);
  const d = g.check("t", { amount: GBP(1), estInputTokens: 50, enforce: false });
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /token cap/);
});
