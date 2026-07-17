/**
 * In-memory send outbox for the active webview session.
 * Durable pending/rejected sends live in SQLite (host). Webview setState must
 * never store user message text.
 */

export interface OutboxEntry {
  clientRequestId: string;
  taskId?: string;
  text: string;
  llmText?: string;
  mentionBindings?: Array<[string, string]>;
  skills?: string[];
  backend?: string;
  model?: string;
  continuationOf?: string;
  createdAt: number;
  status: 'pending' | 'rejected';
}

/** Session-scoped memory only — never vscode.setState. */
const memory = new Map<string, OutboxEntry>();

const MAX_PERSISTED_SKILLS = 8;

function normalizeMentionBindings(value: unknown): Array<[string, string]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const bindings = value.filter(
    (entry): entry is [string, string] =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      entry[0].length > 0 &&
      typeof entry[1] === 'string' &&
      entry[1].length > 0,
  );
  return bindings.length > 0 ? bindings : undefined;
}

function normalizeSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of value) {
    if (typeof s !== 'string') continue;
    const trimmed = s.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_PERSISTED_SKILLS) break;
  }
  return out.length > 0 ? out : undefined;
}

function normalizeEntry(entry: OutboxEntry): OutboxEntry {
  return {
    ...entry,
    mentionBindings: normalizeMentionBindings(entry.mentionBindings),
    skills: normalizeSkills(entry.skills),
    status: entry.status ?? 'pending',
  };
}

/** Replace in-memory outbox from host SQLite snapshot (reload restore). */
export function outboxReplaceAll(entries: readonly OutboxEntry[]): void {
  memory.clear();
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    memory.set(normalized.clientRequestId, normalized);
  }
}

export function outboxAdd(_api: unknown, entry: OutboxEntry): void {
  const normalized = normalizeEntry(entry);
  memory.set(normalized.clientRequestId, normalized);
}

export function outboxMarkRejected(
  _api: unknown,
  clientRequestId: string,
): OutboxEntry | undefined {
  const existing = memory.get(clientRequestId);
  if (!existing) return undefined;
  const next = { ...existing, status: 'rejected' as const };
  memory.set(clientRequestId, next);
  return next;
}

export function outboxRemove(_api: unknown, clientRequestId: string): void {
  memory.delete(clientRequestId);
}

export function outboxList(_api?: unknown): OutboxEntry[] {
  return [...memory.values()];
}

export function outboxPending(_api?: unknown): OutboxEntry[] {
  return outboxList().filter((e) => e.status !== 'rejected');
}

export function outboxRejected(_api?: unknown): OutboxEntry[] {
  return outboxList().filter((e) => e.status === 'rejected');
}
