/**
 * Machine-checkable M014 S02 visual matrix manifest.
 * Source of truth: visual-cases.manifest.json (also consumed by
 * scripts/verify-visual-baselines.test.mjs).
 */
import manifest from './visual-cases.manifest.json';

export type VisualThemeKind = 'dark' | 'light' | 'high-contrast';
export type VisualEntrypoint = 'webview' | 'presentation';
export type VisualLayout = 'compact' | 'narrow' | 'standard';

export interface VisualMatrixCase {
  id: string;
  owner: string;
  entrypoint: VisualEntrypoint;
  state: string;
  layout: VisualLayout;
  viewport: { width: number; height: number };
  theme: VisualThemeKind;
  requirements: string[];
  snapshotPath: string;
  fixtureFactory: string;
}

/** Hard cap for the initial committed matrix (S02). */
export const VISUAL_MATRIX_MAX_CASES: number = manifest.maxCases;

/**
 * Stable independently executable M014/S02 proof title.
 * Must match the Playwright test title exactly.
 */
export const M014_S02_FLOW_TITLE: string = manifest.flowTitle;

/** Bounded representative visual matrix (≤ VISUAL_MATRIX_MAX_CASES). */
export const VISUAL_MATRIX_CASES: readonly VisualMatrixCase[] =
  manifest.cases as VisualMatrixCase[];

export const VISUAL_MATRIX_CASE_IDS = VISUAL_MATRIX_CASES.map((c) => c.id);

export function getVisualCase(id: string): VisualMatrixCase {
  const found = VISUAL_MATRIX_CASES.find((c) => c.id === id);
  if (!found) {
    throw new Error(`Unknown visual matrix case id: ${id}`);
  }
  return found;
}

/** Cases belonging to one entrypoint. */
export function visualCasesForEntrypoint(
  entrypoint: VisualEntrypoint,
): VisualMatrixCase[] {
  return VISUAL_MATRIX_CASES.filter((c) => c.entrypoint === entrypoint);
}
