/**
 * Phase C webview outbox: track unacked sends for resend with same clientRequestId.
 * Persisted via vscode setState so rehydrate can retry.
 */

export interface OutboxEntry {
  clientRequestId: string;
  taskId?: string;
  text: string;
  llmText?: string;
  /** Display mention token -> agent-facing path, retained so a rejected send can retry safely. */
  mentionBindings?: Array<[string, string]>;
  /** Skill chips attached to a new-task send, restored with the draft on reject. */
  skills?: string[];
  backend?: string;
  model?: string;
  continuationOf?: string;
  createdAt: number;
  /**
   * pending: awaiting host ACK (eligible for resend, not draft restore)
   * rejected: host NACK — restore draft when originating composer is empty
   */
  status: 'pending' | 'rejected';
}

const OUTBOX_KEY = 'muster.sendOutbox.v1';

type VsCodeStateApi = {
  getState?: () => unknown;
  setState?: (state: unknown) => void;
};

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

/** Max persisted skill chips; mirrors Composer's MAX_SKILL_CHIPS. */
const MAX_PERSISTED_SKILLS = 8;

/**
 * Sanitize persisted skill chips: trim, drop blanks, dedupe, and cap at
 * MAX_PERSISTED_SKILLS so a restored draft can never violate the composer's
 * chip invariants (dedup + cap) or collide the keyed `{#each ... (name)}` block.
 */
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

function readState(api: VsCodeStateApi | undefined): OutboxEntry[] {
  try {
    const raw = api?.getState?.() as { sendOutbox?: OutboxEntry[] } | undefined;
    const list = raw?.sendOutbox;
    if (!Array.isArray(list)) return [];
    return list.map((entry) => ({
      ...entry,
      mentionBindings: normalizeMentionBindings(entry?.mentionBindings),
      skills: normalizeSkills(entry?.skills),
    }));
  } catch {
    return [];
  }
}

function writeState(api: VsCodeStateApi | undefined, entries: OutboxEntry[]): void {
  try {
    const prev = (api?.getState?.() as Record<string, unknown> | undefined) ?? {};
    api?.setState?.({ ...prev, sendOutbox: entries });
  } catch {
    // ignore
  }
}

export function outboxAdd(api: VsCodeStateApi | undefined, entry: OutboxEntry): void {
  const list = readState(api).filter((e) => e.clientRequestId !== entry.clientRequestId);
  list.push({ ...entry, status: entry.status ?? 'pending' });
  writeState(api, list);
}

export function outboxMarkRejected(
  api: VsCodeStateApi | undefined,
  clientRequestId: string,
): OutboxEntry | undefined {
  const list = readState(api);
  let found: OutboxEntry | undefined;
  const next = list.map((e) => {
    if (e.clientRequestId !== clientRequestId) return e;
    found = { ...e, status: 'rejected' as const };
    return found;
  });
  if (found) writeState(api, next);
  return found;
}

export function outboxRemove(api: VsCodeStateApi | undefined, clientRequestId: string): void {
  writeState(
    api,
    readState(api).filter((e) => e.clientRequestId !== clientRequestId),
  );
}

export function outboxList(api: VsCodeStateApi | undefined): OutboxEntry[] {
  return readState(api);
}

export function outboxPending(api: VsCodeStateApi | undefined): OutboxEntry[] {
  return readState(api).filter((e) => e.status !== 'rejected');
}

export function outboxRejected(api: VsCodeStateApi | undefined): OutboxEntry[] {
  return readState(api).filter((e) => e.status === 'rejected');
}
