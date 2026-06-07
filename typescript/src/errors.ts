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
