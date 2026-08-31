/**
 * Display name for the agent running a task.
 *
 * The footer names the agent, not the runtime: which backend/model serves it is
 * configuration (conversation menu -> Change model), so it must not leak here.
 * `briefKind` is the host's per-task job identity; `role` is the fallback when a
 * task predates structured briefs.
 */

const BRIEF_KIND_LABELS: Readonly<Record<string, string>> = {
  coordinate: 'Coordinator',
  plan: 'Planner',
  breakdown: 'Breakdown',
  implement: 'Implementer',
  test: 'Tester',
  verify: 'Verifier',
  research: 'Researcher',
};

export interface AgentLabelInput {
  role: 'coordinator' | 'worker';
  /** Host brief kind; free-form on the wire, so unknown values fall back to role. */
  briefKind?: string;
}

/**
 * Never empty: an unknown or generic `briefKind` falls back to the role, so the
 * footer always names something rather than collapsing to blank chrome.
 */
export function resolveAgentLabel(input: AgentLabelInput): string {
  const kind = input.briefKind?.trim();
  if (kind) {
    const label = BRIEF_KIND_LABELS[kind];
    if (label) return label;
  }
  return input.role === 'coordinator' ? 'Coordinator' : 'Agent';
}
