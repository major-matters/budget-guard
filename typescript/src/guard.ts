/** BudgetGuard: runtime spend, token, loop, and kill-switch enforcement for
 *  agent LLM calls. Deterministic, fail-closed. The guard never makes the model
 *  call; it only decides whether the next call is permitted and keeps the ledger.
 *
 *    const guard = new BudgetGuard(new Pricing());
 *    guard.open("task-1", { maxUsd: 0.5, maxCalls: 20 });
 *    guard.check("task-1", { model: "claude-sonnet-4-6", estInputTokens: 1200, estOutputTokens: 600, signature: sig });
 *    const out = await callModel(...);
 *    guard.record("task-1", { model: "claude-sonnet-4-6", inputTokens: out.usage.input, outputTokens: out.usage.output, signature: sig });
 *    guard.close("task-1");
 */

import { BudgetExceeded, KillSwitched, LoopDetected, UnknownTask, BudgetGuardDenied } from "./errors.ts";
import { type BudgetPolicy, type ResolvedPolicy, resolvePolicy } from "./policy.ts";
import { Pricing } from "./pricing.ts";

export interface TaskSnapshot {
  taskId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  usd: number;
  killed: boolean;
  limits: { maxUsd?: number; maxTokens?: number; maxCalls?: number };
  remaining: { usd: number | null; tokens: number | null; calls: number | null };
}

export interface Decision {
  allowed: boolean;
  code?: string;
  reason?: string;
  projectedUsd?: number;
  projectedTokens?: number;
}

interface CheckOpts {
  model?: string;
  estInputTokens?: number;
  estOutputTokens?: number;
  signature?: string;
  /** true (default) raises on a violation; false returns a Decision. */
  enforce?: boolean;
}

interface RecordOpts {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  signature?: string;
}

class Ledger {
  taskId: string;
  policy: ResolvedPolicy;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;
  calls = 0;
  killed = false;
  recent: string[] = [];
  constructor(taskId: string, policy: ResolvedPolicy) {
    this.taskId = taskId;
    this.policy = policy;
  }

  get tokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  snapshot(): TaskSnapshot {
    const p = this.policy;
    const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
    return {
      taskId: this.taskId,
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      tokens: this.tokens,
      usd: round6(this.usd),
      killed: this.killed,
      limits: { maxUsd: p.maxUsd, maxTokens: p.maxTokens, maxCalls: p.maxCalls },
      remaining: {
        usd: p.maxUsd == null ? null : round6(p.maxUsd - this.usd),
        tokens: p.maxTokens == null ? null : p.maxTokens - this.tokens,
        calls: p.maxCalls == null ? null : p.maxCalls - this.calls,
      },
    };
  }
}

export class BudgetGuard {
  private tasks = new Map<string, Ledger>();
  private globalKill = false;
  private pricing?: Pricing;
  constructor(pricing?: Pricing) {
    this.pricing = pricing;
  }

  // -- task lifecycle ------------------------------------------------------

  open(taskId: string, policy: BudgetPolicy = {}): void {
    if (!taskId) throw new Error("taskId is required");
    if (this.tasks.has(taskId)) throw new Error(`task ${JSON.stringify(taskId)} is already open`);
    this.tasks.set(taskId, new Ledger(taskId, resolvePolicy(policy)));
  }

  close(taskId: string): TaskSnapshot | null {
    const led = this.tasks.get(taskId);
    if (!led) return null;
    this.tasks.delete(taskId);
    return led.snapshot();
  }

  /** Open a task, run fn, and always close it. For synchronous callbacks. */
  withTask<T>(taskId: string, policy: BudgetPolicy, fn: () => T): T {
    this.open(taskId, policy);
    try {
      return fn();
    } finally {
      this.close(taskId);
    }
  }

  private ledger(taskId: string): Ledger {
    const led = this.tasks.get(taskId);
    if (!led) throw new UnknownTask(`no open task ${JSON.stringify(taskId)}`, { taskId });
    return led;
  }

  // -- enforcement ---------------------------------------------------------

  check(taskId: string, opts: CheckOpts = {}): Decision {
    const estIn = opts.estInputTokens ?? 0;
    const estOut = opts.estOutputTokens ?? 0;
    if (!Number.isFinite(estIn) || !Number.isFinite(estOut) || estIn < 0 || estOut < 0) {
      throw new Error("token estimates must be non-negative finite numbers");
    }
    const enforce = opts.enforce ?? true;
    const led = this.ledger(taskId);
    const p = led.policy;

    if (this.globalKill || led.killed) {
      return this.deny(enforce, KillSwitched, taskId, "kill switch engaged", "kill_switched");
    }

    if (opts.signature != null && p.maxRepeats != null) {
      const window = led.recent.slice(-p.repeatWindow);
      const repeats = window.filter((s) => s === opts.signature).length + 1;
      if (repeats > p.maxRepeats) {
        return this.deny(
          enforce,
          LoopDetected,
          taskId,
          `signature repeated ${repeats}x within window of ${p.repeatWindow} (max ${p.maxRepeats})`,
          "loop_detected",
          { detail: { repeats, signature: opts.signature } },
        );
      }
    }

    if (p.maxCalls != null && led.calls + 1 > p.maxCalls) {
      return this.deny(enforce, BudgetExceeded, taskId, `call cap reached (${p.maxCalls})`, "budget_exceeded");
    }

    const projIn = led.inputTokens + estIn;
    const projOut = led.outputTokens + estOut;
    const projTokens = projIn + projOut;

    if (p.maxInputTokens != null && projIn > p.maxInputTokens) {
      return this.deny(enforce, BudgetExceeded, taskId, `input-token cap exceeded (${projIn} > ${p.maxInputTokens})`, "budget_exceeded", { projectedTokens: projTokens });
    }
    if (p.maxOutputTokens != null && projOut > p.maxOutputTokens) {
      return this.deny(enforce, BudgetExceeded, taskId, `output-token cap exceeded (${projOut} > ${p.maxOutputTokens})`, "budget_exceeded", { projectedTokens: projTokens });
    }
    if (p.maxTokens != null && projTokens > p.maxTokens) {
      return this.deny(enforce, BudgetExceeded, taskId, `token cap exceeded (${projTokens} > ${p.maxTokens})`, "budget_exceeded", { projectedTokens: projTokens });
    }

    let projUsd = led.usd;
    if (p.maxUsd != null) {
      if (!this.pricing) throw new Error("policy sets maxUsd but BudgetGuard was created without Pricing");
      projUsd = led.usd + this.pricing.cost(opts.model, estIn, estOut);
      if (projUsd > p.maxUsd) {
        return this.deny(enforce, BudgetExceeded, taskId, `USD cap exceeded ($${projUsd.toFixed(4)} > $${p.maxUsd.toFixed(4)})`, "budget_exceeded", { projectedUsd: projUsd, projectedTokens: projTokens });
      }
    }

    return { allowed: true, projectedUsd: projUsd, projectedTokens: projTokens };
  }

  record(taskId: string, opts: RecordOpts = {}): TaskSnapshot {
    const inTok = opts.inputTokens ?? 0;
    const outTok = opts.outputTokens ?? 0;
    if (!Number.isFinite(inTok) || !Number.isFinite(outTok) || inTok < 0 || outTok < 0) {
      throw new Error("token counts must be non-negative finite numbers");
    }
    const led = this.ledger(taskId);
    led.inputTokens += inTok;
    led.outputTokens += outTok;
    led.calls += 1;
    if (this.pricing && this.pricing.has(opts.model)) {
      led.usd += this.pricing.cost(opts.model, inTok, outTok);
    }
    if (opts.signature != null) {
      led.recent.push(opts.signature);
      const maxLen = Math.max(led.policy.repeatWindow * 4, 64);
      if (led.recent.length > maxLen) led.recent.splice(0, led.recent.length - maxLen);
    }
    return led.snapshot();
  }

  // -- kill switch ---------------------------------------------------------

  kill(taskId?: string): void {
    if (taskId == null) this.globalKill = true;
    else this.ledger(taskId).killed = true;
  }

  revive(taskId?: string): void {
    if (taskId == null) this.globalKill = false;
    else this.ledger(taskId).killed = false;
  }

  // -- introspection -------------------------------------------------------

  status(taskId: string): TaskSnapshot {
    return this.ledger(taskId).snapshot();
  }

  // -- internal ------------------------------------------------------------

  private deny(
    enforce: boolean,
    Cls: new (m: string, o?: { taskId?: string; detail?: Record<string, unknown> }) => BudgetGuardDenied,
    taskId: string,
    reason: string,
    code: string,
    extra: { detail?: Record<string, unknown>; projectedUsd?: number; projectedTokens?: number } = {},
  ): Decision {
    if (enforce) throw new Cls(reason, { taskId, detail: extra.detail });
    return { allowed: false, code, reason, projectedUsd: extra.projectedUsd, projectedTokens: extra.projectedTokens };
  }
}
