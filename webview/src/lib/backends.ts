// Shared backend display metadata (single source of truth).

/** A selectable ACP backend and its short, sentence-case display label. */
export interface BackendMeta {
  id: string;
  label: string;
}

/** Selectable ACP backends, in display order. Drives the picker and the task chip. */
export const BACKENDS: BackendMeta[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok' },
  { id: 'kiro', label: 'Kiro' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'Open Code' },
];

/**
 * Codicon class for the agent avatar shown in chat headers. All ACP agents use a
 * single robot icon (matching the activity-bar icon) rather than a per-backend
 * initial letter.
 */
export function backendIcon(_backend?: string | null): string {
  return 'codicon-robot';
}

/** Short, sentence-case name for a backend (picker options + the locked-task chip). */
export function backendShortLabel(backend: string | null | undefined): string {
  if (!backend) return 'Assistant';
  const b = backend.toLowerCase();
  const found = BACKENDS.find((meta) => b.includes(meta.id));
  return found ? found.label : backend;
}

/** Full display label for a backend, used in chat message headers. */
export function backendLabel(backend: string | null | undefined): string {
  if (!backend) return 'Assistant';
  const b = backend.toLowerCase();
  if (b.includes('claude')) return 'Claude Code CLI';
  if (b.includes('grok')) return 'Grok';
  if (b.includes('kiro')) return 'Kiro';
  if (b.includes('codex')) return 'Codex';
  if (b.includes('open')) return 'Open Code';
  return backend;
}
