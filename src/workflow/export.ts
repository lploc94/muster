/**
 * Deterministic Markdown/JSON export of a workflow (redacted).
 */

import type { TaskStoreFile } from '../task/types';
import { buildContextReport } from './context';
import { getWorkflowRunForRoot, listArtifactsForRun, projectWorkflowSummaryForRoot } from './store';

const REDACT_KEYS = new Set([
  'token',
  'bearer',
  'password',
  'secret',
  'authorization',
  'apiKey',
  'api_key',
  'credential',
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase()) || /token|secret|password|credential/i.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

export function exportWorkflowJson(file: TaskStoreFile, rootTaskId: string): string {
  const summary = projectWorkflowSummaryForRoot(file, rootTaskId);
  const run = getWorkflowRunForRoot(file, rootTaskId);
  const artifacts = run
    ? listArtifactsForRun(file, run.id).map((a) => redact(a))
    : [];
  const context = buildContextReport(file, rootTaskId);
  const payload = {
    exportedAt: new Date().toISOString(),
    rootTaskId,
    summary,
    context: redact(context),
    artifacts,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function exportWorkflowMarkdown(file: TaskStoreFile, rootTaskId: string): string {
  const summary = projectWorkflowSummaryForRoot(file, rootTaskId);
  const context = buildContextReport(file, rootTaskId);
  const root = file.tasks[rootTaskId];
  const lines: string[] = [
    `# Muster workflow export`,
    '',
    `- Root: \`${rootTaskId}\``,
    `- Goal: ${root?.goal ?? '(unknown)'}`,
    `- Phase: ${summary?.phase ?? 'n/a'}`,
    `- Plan revision: ${summary?.planRevision ?? 0}`,
    `- Approval: ${summary?.approvalStatus ?? 'n/a'}`,
    '',
    '## Decisions',
    ...context.decisions.map((d) => `- ${d.summary} (\`${d.id}\`)`),
    '',
    '## Open questions',
    ...(context.openQuestions.length
      ? context.openQuestions.map((q) => `- ${q}`)
      : ['- (none)']),
    '',
    '## Evidence',
    ...(context.evidence.length
      ? context.evidence.map((e) => `- [${e.kind}] ${e.summary ?? e.id}`)
      : ['- (none)']),
    '',
    '## Usage',
    `- inputTokens: ${context.usage.inputTokens}`,
    `- outputTokens: ${context.usage.outputTokens}`,
    '',
    '_Secrets and provider tokens are redacted._',
    '',
  ];
  return lines.join('\n');
}
