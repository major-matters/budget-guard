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
 *
 *  Time (0.2.0): spend-velocity windows need a timestamp. Pass `now` (seconds)
 *  to check() and record(), or give the guard a `clock` at construction. The
 *  wall clock is used only when neither is supplied, so tests and replays stay
 *  deterministic.
 */

import {
  BudgetExceeded,
  KillSwitched,
  LoopDetected,
  UnknownTask,
  BudgetGuardDenied,
  VelocityAnomaly,
  VelocityCallsExceeded,
  VelocitySpendExceeded,
} from "./errors.ts";
import { type AnomalyAction, type BudgetPolicy, type MoneyAmount, type ResolvedPolicy, resolvePolicy, spendCurrency } from "./policy.ts";
import { Pricing } from "./pricing.ts";

export interface TaskSnapshot {
  taskId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  tokens: number;
  usd: number;
  /** Money moved so far, in the policy's unit and currency (0 with no maxSpend). */
  spend: number;
  killed: boolean;
  limits: {
    maxUsd?: number;
    maxTokens?: number;
    maxCalls?: number;
    maxSpend?: MoneyAmount;
    windowSeconds?: number;
    maxSpendPerWindow?: MoneyAmount;
    maxCallsPerWindow?: number;
    anomalyFactor?: number;
  };
  remaining: { usd: number | null; tokens: number | null; calls: number | null; spend: number | null };
}

/** The spend-velocity picture behind a decision. A plain object, so it can ride
 *  along in a WitnessKit trail. windowSpend and windowCalls include the proposed
 *  call; baseline is null while the anomaly check is inactive. */
export interface VelocityDetail {
  windowSeconds: number;
  windowSpend: number;
  windowCalls: number;
  baseline: number | null;
  factor: number | null;
  anomaly: boolean;
  action: AnomalyAction | null;
}

export interface Decision {
  allowed: boolean;
  code?: string;
  reason?: string;
  projectedUsd?: number;
  projectedTokens?: number;
  projectedSpend?: number;
  /** True when the spend-velocity anomaly condition holds for this call, whatever
   *  the verdict (in "flag" mode the call is allowed and marked). */
  anomaly?: boolean;
  /** Present whenever the policy sets windowSeconds. */
  velocity?: VelocityDetail;
}

interface CheckOpts {
  model?: string;
  estInputTokens?: number;
  estOutputTokens?: number;
  /** Money this action would move out. Checked against maxSpend. */
  amount?: MoneyAmount;
  signature?: string;
  /** Time of the call in seconds (int or float), used by the spend-velocity window. */
  now?: number;
  /** true (default) raises on a violation; false returns a Decision. */
  enforce?: boolean;
}

interface RecordOpts {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Money the action actually moved out. */
  amount?: MoneyAmount;
  signature?: string;
  /** When the action happened, in seconds. */
  now?: number;
}

function checkedMoney(name: string, a: MoneyAmount | undefined, policy: ResolvedPolicy): number {
  if (a == null) return 0;
  if (!a || typeof a !== "object" || !Number.isInteger(a.value) || a.value < 0 || a.value > Number.MAX_SAFE_INTEGER || typeof a.currency !== "string" || !a.currency) {
    throw new Error(`${name} must be {value: integer >= 0, currency: string}`);
  }
  const cap = spendCurrency(policy);
  if (cap != null && a.currency !== cap.currency) {
    const label = policy.maxSpend != null ? "maxSpend" : "maxSpendPerWindow";
    throw new Error(`${name} currency ${a.currency} does not match the policy's ${label} currency ${cap.currency}`);
  }
  return a.value;
}

function checkedTime(name: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${name} must be a finite number of seconds`);
  }
  return v;
}

/** Number formatting shared with the Python implementation: String() prints an
 *  integral value without a trailing .0, which is what Python's side mirrors. */
const fmt = (x: number): string => String(x);

class Ledger {
  taskId: string;
  policy: ResolvedPolicy;
  inputTokens = 0;
  outputTokens = 0;
  usd = 0;
  spend = 0;
  calls = 0;
  killed = false;
  recent: string[] = [];
  /** (recordedAt, spend) per recorded call, kept only while a velocity window
   *  can still see it. Empty unless the policy sets windowSeconds. */
  events: { at: number; spend: number }[] = [];
  firstAt: number | null = null;
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
      spend: this.spend,
      killed: this.killed,
      limits: {
        maxUsd: p.maxUsd,
        maxTokens: p.maxTokens,
        maxCalls: p.maxCalls,
        maxSpend: p.maxSpend,
        windowSeconds: p.windowSeconds,
        maxSpendPerWindow: p.maxSpendPerWindow,
        maxCallsPerWindow: p.maxCallsPerWindow,
        anomalyFactor: p.anomalyFactor,
      },
      remaining: {
        usd: p.maxUsd == null ? null : round6(p.maxUsd - this.usd),
        tokens: p.maxTokens == null ? null : p.maxTokens - this.tokens,
        calls: p.maxCalls == null ? null : p.maxCalls - this.calls,
        spend: p.maxSpend == null ? null : p.maxSpend.value - this.spend,
      },
    };
  }
}

/** The spend-velocity picture for a call proposed at `now`.
 *
 *  The current window is the sliding window (now - W, now]: a recorded event
 *  counts while it is less than windowSeconds old, so at exactly W seconds it has
 *  aged out. For the anomaly baseline, the W seconds before the current window
 *  form completed bucket 1, the W before that bucket 2, and so on. The baseline
 *  is the mean spend of buckets 1..N (N = baselineWindows). It is active only
 *  once the task's first recorded event is at least N*W seconds old, so every
 *  one of those buckets lies inside the task's history; empty buckets inside the
 *  history count as zero, and with an active baseline of zero any positive spend
 *  in the current window is an anomaly. Before that, baseline is null and
 *  nothing trips (a cold start never fires). Mirrors budgetguard/guard.py
 *  operation for operation so both implementations agree bit for bit. */
function velocity(led: Ledger, now: number, amountValue: number): VelocityDetail {
  const p = led.policy;
  const w = p.windowSeconds as number;
  const n = p.baselineWindows;
  let windowSpend = amountValue;
  let windowCalls = 1;
  let baselineTotal = 0;
  const horizon = (n + 1) * w;
  for (const ev of led.events) {
    const age = now - ev.at;
    if (age < w) {
      windowSpend += ev.spend;
      windowCalls += 1;
    } else if (age < horizon) {
      baselineTotal += ev.spend;
    }
  }
  const factor = p.anomalyFactor ?? null;
  const active = factor != null && led.firstAt != null && now - led.firstAt >= n * w;
  let baseline: number | null = null;
  let anomaly = false;
  if (active) {
    baseline = baselineTotal / n;
    anomaly = windowSpend > (factor as number) * baseline;
  }
  return {
    windowSeconds: w,
    windowSpend,
    windowCalls,
    baseline,
    factor,
    anomaly,
    action: anomaly ? p.anomalyAction : null,
  };
}

export class BudgetGuard {
  private tasks = new Map<string, Ledger>();
  private globalKill = false;
  private pricing?: Pricing;
  private clock?: () => number;
  /** `clock` returns the current time in seconds; it is consulted only when a
   *  call omits `now`. Without a clock the wall clock is used. */
  constructor(pricing?: Pricing, opts: { clock?: () => number } = {}) {
    if (opts.clock != null && typeof opts.clock !== "function") throw new Error("clock must be a function returning seconds");
    this.pricing = pricing;
    this.clock = opts.clock;
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

  /** Resolve the timestamp for this call: the explicit `now`, else the clock given
   *  at construction, else the wall clock. */
  private now(now: number | undefined): number {
    const t = now ?? (this.clock ? this.clock() : Date.now() / 1000);
    return checkedTime("now", t);
  }

  // -- enforcement ---------------------------------------------------------

  check(taskId: string, opts: CheckOpts = {}): Decision {
    const estIn = opts.estInputTokens ?? 0;
    const estOut = opts.estOutputTokens ?? 0;
    if (!Number.isFinite(estIn) || !Number.isFinite(estOut) || estIn < 0 || estOut < 0) {
      throw new Error("token estimates must be non-negative finite numbers");
    }
    if (opts.now != null) checkedTime("now", opts.now);
    const enforce = opts.enforce ?? true;
    const led = this.ledger(taskId);
    const p = led.policy;
    // Validated up front so a malformed amount can never slip past the cap.
    const amount = checkedMoney("amount", opts.amount, p);
    // The velocity picture is computed first so every decision carries it,
    // whichever check settles the verdict.
    const vel = p.windowSeconds != null ? velocity(led, this.now(opts.now), amount) : undefined;

    if (this.globalKill || led.killed) {
      return this.deny(enforce, KillSwitched, taskId, "kill switch engaged", "kill_switched", { velocity: vel });
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
          { detail: { repeats, signature: opts.signature }, velocity: vel },
        );
      }
    }

    if (p.maxCalls != null && led.calls + 1 > p.maxCalls) {
      return this.deny(enforce, BudgetExceeded, taskId, `call cap reached (${p.maxCalls})`, "budget_exceeded", { velocity: vel });
    }

    const projIn = led.inputTokens + estIn;
    const projOut = led.outputTokens + estOut;
    const projTokens = projIn + projOut;

    if (p.maxInputTokens != null && projIn > p.maxInputTokens) {
      return this.deny(enforce, BudgetExceeded, taskId, `input-token cap exceeded (${projIn} > ${p.maxInputTokens})`, "budget_exceeded", { projectedTokens: projTokens, velocity: vel });
    }
    if (p.maxOutputTokens != null && projOut > p.maxOutputTokens) {
      return this.deny(enforce, BudgetExceeded, taskId, `output-token cap exceeded (${projOut} > ${p.maxOutputTokens})`, "budget_exceeded", { projectedTokens: projTokens, velocity: vel });
    }
    if (p.maxTokens != null && projTokens > p.maxTokens) {
      return this.deny(enforce, BudgetExceeded, taskId, `token cap exceeded (${projTokens} > ${p.maxTokens})`, "budget_exceeded", { projectedTokens: projTokens, velocity: vel });
    }

    const projSpend = led.spend + amount;
    if (p.maxSpend != null && projSpend > p.maxSpend.value) {
      return this.deny(enforce, BudgetExceeded, taskId,
        `spend cap exceeded (${projSpend} > ${p.maxSpend.value} ${p.maxSpend.currency})`, "budget_exceeded",
        { projectedSpend: projSpend, projectedTokens: projTokens, velocity: vel });
    }

    let projUsd = led.usd;
    if (p.maxUsd != null) {
      if (!this.pricing) throw new Error("policy sets maxUsd but BudgetGuard was created without Pricing");
      projUsd = led.usd + this.pricing.cost(opts.model, estIn, estOut);
      if (projUsd > p.maxUsd) {
        return this.deny(enforce, BudgetExceeded, taskId, `USD cap exceeded ($${projUsd.toFixed(4)} > $${p.maxUsd.toFixed(4)})`, "budget_exceeded", { projectedUsd: projUsd, projectedTokens: projTokens, velocity: vel });
      }
    }

    // Spend velocity: window caps first, then the anomaly check. These run after
    // every existing control, so a total cap or the kill switch always reports
    // its own reason.
    if (vel) {
      const w = p.windowSeconds as number;
      const projected = { projectedUsd: projUsd, projectedTokens: projTokens, projectedSpend: projSpend, velocity: vel };
      const cap = p.maxSpendPerWindow;
      if (cap != null && vel.windowSpend > cap.value) {
        return this.deny(enforce, VelocitySpendExceeded, taskId,
          `window spend cap exceeded (${vel.windowSpend} > ${cap.value} ${cap.currency} in ${w}s)`, "velocity_spend", projected);
      }
      if (p.maxCallsPerWindow != null && vel.windowCalls > p.maxCallsPerWindow) {
        return this.deny(enforce, VelocityCallsExceeded, taskId,
          `window call cap exceeded (${vel.windowCalls} > ${p.maxCallsPerWindow} in ${w}s)`, "velocity_calls", projected);
      }
      if (vel.anomaly && p.anomalyAction === "deny") {
        return this.deny(enforce, VelocityAnomaly, taskId,
          `spend velocity anomaly (${vel.windowSpend} > ${fmt(vel.factor as number)} x baseline ${fmt(vel.baseline as number)} over ${w}s)`,
          "velocity_anomaly", projected);
      }
    }

    return { allowed: true, projectedUsd: projUsd, projectedTokens: projTokens, projectedSpend: projSpend, anomaly: vel?.anomaly ?? false, velocity: vel };
  }

  record(taskId: string, opts: RecordOpts = {}): TaskSnapshot {
    const inTok = opts.inputTokens ?? 0;
    const outTok = opts.outputTokens ?? 0;
    if (!Number.isFinite(inTok) || !Number.isFinite(outTok) || inTok < 0 || outTok < 0) {
      throw new Error("token counts must be non-negative finite numbers");
    }
    if (opts.now != null) checkedTime("now", opts.now);
    const led = this.ledger(taskId);
    const p = led.policy;
    const amount = checkedMoney("amount", opts.amount, p);
    const recordedAt = p.windowSeconds != null ? this.now(opts.now) : undefined;
    led.inputTokens += inTok;
    led.outputTokens += outTok;
    led.spend += amount;
    led.calls += 1;
    if (recordedAt != null) {
      led.events.push({ at: recordedAt, spend: amount });
      led.firstAt = led.firstAt == null ? recordedAt : Math.min(led.firstAt, recordedAt);
      // Bound memory: an event older than every bucket the policy can look at
      // never matters again (time is expected not to go backwards).
      const horizon = (p.baselineWindows + 1) * (p.windowSeconds as number);
      let drop = 0;
      while (drop < led.events.length && recordedAt - led.events[drop].at >= horizon) drop++;
      if (drop > 0) led.events.splice(0, drop);
    }
    if (this.pricing) {
      if (led.policy.maxUsd != null) {
        // Fail closed: under a USD cap, an unpriced model must not be silently
        // recorded as $0 (audit 2026-06-10 finding #5). cost() throws on a
        // missing price, matching check().
        led.usd += this.pricing.cost(opts.model, inTok, outTok);
      } else if (this.pricing.has(opts.model)) {
        led.usd += this.pricing.cost(opts.model, inTok, outTok);
      }
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
    extra: { detail?: Record<string, unknown>; projectedUsd?: number; projectedTokens?: number; projectedSpend?: number; velocity?: VelocityDetail } = {},
  ): Decision {
    const anomaly = extra.velocity?.anomaly ?? false;
    if (enforce) {
      const detail = extra.velocity ? { ...(extra.detail ?? {}), velocity: extra.velocity } : extra.detail;
      throw new Cls(reason, { taskId, detail });
    }
    return {
      allowed: false,
      code,
      reason,
      projectedUsd: extra.projectedUsd,
      projectedTokens: extra.projectedTokens,
      projectedSpend: extra.projectedSpend,
      anomaly,
      velocity: extra.velocity,
    };
  }
}
