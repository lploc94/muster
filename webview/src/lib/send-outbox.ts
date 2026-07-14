/**
 * Phase C webview outbox: track unacked sends for resend with same clientRequestId.
 * Persisted via vscode setState so rehydrate can retry.
 */

export interface OutboxEntry {
  clientRequestId: string;
  taskId?: string;
  text: string;
  llmText?: string;
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

function readState(api: VsCodeStateApi | undefined): OutboxEntry[] {
  try {
    const raw = api?.getState?.() as { sendOutbox?: OutboxEntry[] } | undefined;
    const list = raw?.sendOutbox;
    return Array.isArray(list) ? list : [];
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
