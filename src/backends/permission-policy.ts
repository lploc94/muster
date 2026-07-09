/**
 * Pure permission-policy module for the ACP `session/request_permission` gate.
 *
 * Given an incoming tool-permission request, this module classifies its risk,
 * resolves a decision from the active mode + per-session allow-list, and picks
 * the concrete ACP option to respond with. Everything here is side-effect free
 * so it can be exhaustively unit-tested.
 */

/** How Muster handles agent tool-permission requests. */
export type PermissionMode = 'ask' | 'allow' | 'readonly';

/** Coarse risk classification derived from the ACP `toolCall.kind`. */
export type PermissionClass = 'read' | 'write' | 'unknown';

/** Minimal shape of the ACP `toolCall` payload we read for classification. */
export interface PermissionToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  locations?: unknown;
}

/** An option offered by the agent on a permission request. */
export interface PermissionOption {
  optionId: string;
  kind: string;
  name?: string;
}

/** Outcome of {@link resolvePolicy}: what the gate should do with a request. */
export type PermissionDecision = 'allow' | 'deny' | 'prompt';

/** Why the gate reached its final allow/deny — recorded in the audit log. */
export type PermissionAuditSource =
  | 'read' // read-only auto-allow (ask/readonly modes)
  | 'mode-allow' // allow-mode blanket approval
  | 'allowlist' // matched a per-session allow-list entry
  | 'mode-readonly' // readonly-mode denial of a write/unknown action
  | 'user' // explicit webview decision
  | 'timeout-deny'; // prompt timed out → safe deny

/** One append-only audit record for a resolved permission request. */
export interface PermissionAuditEntry {
  /** ISO timestamp of the decision. */
  at: string;
  sessionId: string;
  title: string;
  kind: string;
  classification: PermissionClass;
  decision: 'allow' | 'deny';
  source: PermissionAuditSource;
}

// ACP `toolCall.kind` values that only read state — safe to auto-allow.
const READ_KINDS = new Set(['read', 'search', 'fetch', 'think']);
// ACP `toolCall.kind` values that mutate state or run code — need consent.
const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

/**
 * Map an ACP tool-permission request to a coarse risk class.
 *
 * Defensive by design: a missing, `other`, or otherwise unrecognized kind is
 * treated as `unknown` so it falls through to a prompt rather than being
 * silently allowed.
 */
export function classifyPermission(
  toolCall: PermissionToolCall | undefined,
  _options: PermissionOption[],
): PermissionClass {
  const kind = toolCall?.kind?.toLowerCase().trim();
  if (kind && READ_KINDS.has(kind)) return 'read';
  if (kind && WRITE_KINDS.has(kind)) return 'write';
  return 'unknown';
}

/**
 * Resolve the gate decision for a request.
 *
 * Matrix:
 * - `allow`   mode → allow everything.
 * - `readonly`mode → allow reads, deny everything else (no prompt).
 * - `ask`     mode → allow reads; for writes/unknown, allow when already
 *                    allow-listed for this session, otherwise prompt.
 */
export function resolvePolicy(
  mode: PermissionMode,
  cls: PermissionClass,
  allowlisted: boolean,
): { decision: PermissionDecision } {
  if (mode === 'allow') {
    return { decision: 'allow' };
  }
  if (mode === 'readonly') {
    return { decision: cls === 'read' ? 'allow' : 'deny' };
  }
  // mode === 'ask'
  if (cls === 'read') {
    return { decision: 'allow' };
  }
  return { decision: allowlisted ? 'allow' : 'prompt' };
}

/**
 * Pick the ACP `optionId` to respond with.
 *
 * When `allow` is true, prefer an explicit allow option (kind matches
 * `/allow/i`), preferring a one-shot `allow_once` when present. When `allow` is
 * false, pick a reject option (kind matches `/reject|deny/i`). Returns `null`
 * when no suitable option is offered — the caller then falls back to a
 * `cancelled` outcome (deny) or the legacy default (allow).
 */
export function pickOption(options: PermissionOption[], allow: boolean): string | null {
  if (allow) {
    const allowOnce = options.find(
      (o) => /allow/i.test(o.kind) && /once/i.test(o.optionId + ' ' + (o.kind ?? '')),
    );
    if (allowOnce) return allowOnce.optionId;
    const anyAllow = options.find((o) => /allow/i.test(o.kind));
    if (anyAllow) return anyAllow.optionId;
    const legacyAllowOnce = options.find((o) => o.optionId === 'allow_once');
    if (legacyAllowOnce) return legacyAllowOnce.optionId;
    return null;
  }
  const reject = options.find((o) => /reject|deny/i.test(o.kind));
  return reject ? reject.optionId : null;
}
