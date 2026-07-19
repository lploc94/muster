/**
 * Deterministic fault-injection seam for Muster DB boundary tests (P5-W1).
 *
 * Production workers never arm this seam. Capability is granted only via
 * workerData.faultCapability from an explicit test/UAT DbClient option — ambient
 * process.env is ignored so a normal production client cannot be injected.
 */

import {
  faultErrorForPlan,
  type SqliteFaultPlan,
  type SqliteOperationClass,
  type SqliteWorkerData,
} from './errors';

let activePlan: SqliteFaultPlan | undefined;
let capabilityEnabled = false;

/** Bootstrap from workerData (called once at worker start). */
export function bootstrapFaultCapability(data: SqliteWorkerData | undefined): void {
  capabilityEnabled = data?.faultCapability === true;
  activePlan =
    capabilityEnabled && data?.faultPlan
      ? { ...data.faultPlan }
      : undefined;
}

/** Test helper: replace the active plan only when capability is enabled. */
export function setFaultPlanForTests(plan: SqliteFaultPlan | undefined): void {
  if (!capabilityEnabled) return;
  activePlan = plan ? { ...plan } : undefined;
}

export function getFaultPlanForTests(): SqliteFaultPlan | undefined {
  return capabilityEnabled && activePlan ? { ...activePlan } : undefined;
}

export function isFaultCapabilityEnabled(): boolean {
  return capabilityEnabled;
}

/**
 * If a fault is armed for `operation`, consume one remaining shot and throw a
 * safe MusterSqliteError. No-op without capability or when exhausted.
 */
export function maybeInjectFault(operation: SqliteOperationClass): void {
  if (!capabilityEnabled || !activePlan) return;
  if (activePlan.operation !== operation && activePlan.operation !== 'unknown') {
    return;
  }
  if (activePlan.remaining < 1) {
    activePlan = undefined;
    return;
  }
  const code = activePlan.code;
  const planOp = activePlan.operation === 'unknown' ? operation : activePlan.operation;
  activePlan = {
    ...activePlan,
    remaining: activePlan.remaining - 1,
  };
  if (activePlan.remaining === 0) {
    activePlan = undefined;
  }
  throw faultErrorForPlan({
    code,
    operation: planOp,
    remaining: 0,
  });
}
