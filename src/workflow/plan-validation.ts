/**
 * Re-export plan validators with backend defaults for host use.
 */

import { BACKEND_IDS } from '../backends';
import {
  validatePlanArtifact,
  validatePlanArtifactShape,
  validatePlanSemantics,
  type PlanArtifact,
  type PlanSemanticContext,
  type ValidationResult,
} from './contracts';

export function defaultPlanContext(
  extra?: Partial<PlanSemanticContext>,
): PlanSemanticContext {
  return {
    knownBackends: extra?.knownBackends ?? BACKEND_IDS,
    reservedTaskIds: extra?.reservedTaskIds,
  };
}

export function validatePlan(
  raw: unknown,
  ctx?: Partial<PlanSemanticContext>,
): ValidationResult<PlanArtifact> {
  return validatePlanArtifact(raw, defaultPlanContext(ctx));
}

export { validatePlanArtifactShape, validatePlanSemantics, validatePlanArtifact };
export type { PlanArtifact, PlanSemanticContext, ValidationResult };
