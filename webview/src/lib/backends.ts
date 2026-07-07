// Shared backend display metadata (single source of truth).

export function backendIcon(backend: string | null | undefined): string {
  if (!backend) return '?';
  const b = backend.toLowerCase();
  if (b.includes('claude')) return 'C';
  if (b.includes('grok')) return 'G';
  if (b.includes('kiro')) return 'K';
  if (b.includes('codex')) return 'X';
  if (b.includes('open')) return 'O';
  return '?';
}

export function backendLabel(backend: string | null | undefined): string {
  if (!backend) return 'Assistant';
  const b = backend.toLowerCase();
  if (b.includes('claude')) return '[C] Claude Code CLI';
  if (b.includes('grok')) return '[G] Grok';
  if (b.includes('kiro')) return '[K] Kiro';
  if (b.includes('codex')) return '[X] Codex';
  if (b.includes('open')) return '[O] OpenCode';
  return backend;
}
