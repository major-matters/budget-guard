/** BudgetGuard errors. Every denial is fail-closed: do not proceed with the
 *  guarded call unless check() returns cleanly. */

export class BudgetGuardDenied extends Error {
  code = "denied";
  taskId?: string;
  detail: Record<string, unknown>;
  constructor(message: string, opts: { taskId?: string; detail?: Record<string, unknown> } = {}) {
    super(message);
    this.name = new.target.name;
    this.taskId = opts.taskId;
    this.detail = opts.detail ?? {};
  }
}

export class BudgetExceeded extends BudgetGuardDenied {
  code = "budget_exceeded";
}

export class LoopDetected extends BudgetGuardDenied {
  code = "loop_detected";
}

export class KillSwitched extends BudgetGuardDenied {
  code = "kill_switched";
}

export class UnknownTask extends BudgetGuardDenied {
  code = "unknown_task";
}

/** Base class for the spend-velocity refusals (0.2.0). Catch this to handle any
 *  velocity denial uniformly. Every instance carries the velocity detail in
 *  `detail.velocity`. */
export class VelocityDenied extends BudgetGuardDenied {
  code = "velocity_denied";
}

/** Money moved in the current window, plus this call, would cross maxSpendPerWindow. */
export class VelocitySpendExceeded extends VelocityDenied {
  code = "velocity_spend";
}

/** Calls made in the current window, plus this one, would cross maxCallsPerWindow. */
export class VelocityCallsExceeded extends VelocityDenied {
  code = "velocity_calls";
}

/** Spend in the current window exceeds anomalyFactor times the trailing baseline,
 *  and the policy's anomalyAction is "deny". */
export class VelocityAnomaly extends VelocityDenied {
  code = "velocity_anomaly";
}
