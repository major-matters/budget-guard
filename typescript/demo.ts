/** BudgetGuard demo. Run: npm run demo  (node demo.ts).
 *  Shows the three controls on a simulated agent run. No real model is called. */

import { BudgetGuard, Pricing, type ModelPrice, BudgetExceeded, LoopDetected, KillSwitched } from "./src/index.ts";

const LINE = "-".repeat(64);
const banner = (t: string) => console.log(`\n${LINE}\n  ${t}\n${LINE}`);

const pricing = new Pricing({ "demo-model": { inputPer1k: 3 / 1000, outputPer1k: 15 / 1000 } as ModelPrice }, { useBuiltin: false });
const guard = new BudgetGuard(pricing);

banner("1. USD budget that fails closed");
console.log("  Policy: maxUsd = $0.10 per task");
guard.open("research", { maxUsd: 0.1 });
for (let call = 1; ; call++) {
  const estIn = 1500, estOut = 800;
  try {
    guard.check("research", { model: "demo-model", estInputTokens: estIn, estOutputTokens: estOut });
  } catch (e) {
    if (e instanceof BudgetExceeded) { console.log(`  call ${call}: DENIED -> ${e.message}`); break; }
    throw e;
  }
  guard.record("research", { model: "demo-model", inputTokens: estIn, outputTokens: estOut });
  const s = guard.status("research");
  console.log(`  call ${call}: allowed   spend=$${s.usd.toFixed(4)}  remaining=$${(s.remaining.usd ?? 0).toFixed(4)}`);
}
guard.close("research");

banner("2. Runaway loop caught");
console.log("  Policy: maxRepeats = 3 within a window of 10 calls");
guard.open("agent-loop", { maxRepeats: 3, repeatWindow: 10 });
const sig = "search('weather') -> same args";
for (let call = 1; call <= 5; call++) {
  try {
    guard.check("agent-loop", { signature: sig });
  } catch (e) {
    if (e instanceof LoopDetected) { console.log(`  call ${call}: DENIED -> ${e.message}`); break; }
    throw e;
  }
  guard.record("agent-loop", { signature: sig });
  console.log(`  call ${call}: allowed   (identical call #${call})`);
}
guard.close("agent-loop");

banner("3. Kill switch halts a task mid-run");
guard.open("long-job", { maxCalls: 100 });
for (let call = 1; call <= 4; call++) {
  if (call === 3) { console.log("  operator pulls the kill switch..."); guard.kill("long-job"); }
  try {
    guard.check("long-job");
  } catch (e) {
    if (e instanceof KillSwitched) { console.log(`  call ${call}: DENIED -> ${e.message}`); break; }
    throw e;
  }
  guard.record("long-job");
  console.log(`  call ${call}: allowed`);
}
guard.close("long-job");

banner("Mandate before the action. BudgetGuard during it. Witness after.");
console.log("  github.com/major-matters  ·  majorlabs.co\n");
