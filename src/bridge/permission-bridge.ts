import { randomUUID } from 'crypto';
import type {
  PermissionAuditEntry,
  PermissionClass,
  PermissionOption,
} from '../backends/permission-policy';

/**
 * A pending tool-permission prompt awaiting a webview decision. Mirrors the
 * request shape the ACP gate hands to {@link PermissionBridge.register}.
 */
export interface PermissionRequest {
  sessionId: string;
  title: string;
  kind: string;
  classification: PermissionClass;
  options: PermissionOption[];
}

/**
 * The resolved decision for a permission prompt.
 * `timedOut` lets the caller audit a safe-deny as `timeout-deny` vs an explicit
 * `user` deny — both carry `allow:false`, so they are otherwise indistinguishable.
 */
export interface PermissionDecision {
  allow: boolean;
  remember: boolean;
  timedOut: boolean;
}

interface PendingPermission {
  id: string;
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  createdAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Bridges an ACP `session/request_permission` prompt to a webview approval card.
 *
 * Also owns two pieces of gate state that outlive a single prompt:
 * - a per-session allow-list (`Map<sessionId, Set<key>>`) so "remember for this
 *   session" can skip repeat prompts, and
 * - an append-only audit log of every decision the gate made.
 *
 * On timeout the pending promise resolves to a safe DENY (never allow).
 */
export class PermissionBridge {
  private readonly pending = new Map<string, PendingPermission>();
  private readonly allowlist = new Map<string, Set<string>>();
  private readonly auditLog: PermissionAuditEntry[] = [];
  private readonly onRegister?: (id: string, request: PermissionRequest) => void;
  private readonly onResolve?: (id: string) => void;

  constructor(options?: {
    onRegister?: (id: string, request: PermissionRequest) => void;
    onResolve?: (id: string) => void;
  }) {
    this.onRegister = options?.onRegister;
    this.onResolve = options?.onResolve;
  }

  generatePermissionId(): string {
    return randomUUID();
  }

  /**
   * Register a pending prompt. Returns a promise that resolves when the user
   * submits/cancels, or on timeout (safe DENY). Re-registering an in-flight id
   * returns the existing promise.
   */
  register(id: string, request: PermissionRequest, deadlineMs: number): Promise<PermissionDecision> {
    const existing = this.pending.get(id);
    if (existing) {
      return new Promise<PermissionDecision>((resolve) => {
        // Chain onto the existing entry's resolution.
        const prev = existing.resolve;
        existing.resolve = (decision) => {
          prev(decision);
          resolve(decision);
        };
      });
    }

    let resolve!: (decision: PermissionDecision) => void;
    const promise = new Promise<PermissionDecision>((res) => {
      resolve = res;
    });

    const entry: PendingPermission = {
      id,
      request,
      resolve,
      createdAt: Date.now(),
    };
    this.pending.set(id, entry);
    this.onRegister?.(id, request);

    if (deadlineMs > 0) {
      entry.timer = setTimeout(() => {
        const current = this.pending.get(id);
        if (current === entry) {
          this.clear(id);
          entry.resolve({ allow: false, remember: false, timedOut: true });
        }
      }, deadlineMs);
    }

    return promise;
  }

  hasPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** Read the pending request (used by the host to validate inbound optionIds). */
  peek(id: string): PermissionRequest | undefined {
    return this.pending.get(id)?.request;
  }

  /**
   * Resolve a pending prompt from a webview submission. Maps the chosen
   * `optionId` to allow/deny using the request's offered options (a reject/deny
   * kind → deny). Returns false when the id is unknown or the option was not
   * offered (caller should have validated already).
   */
  submit(id: string, choice: { optionId: string; remember: boolean }): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    const option = entry.request.options.find((o) => o.optionId === choice.optionId);
    if (!option) {
      return false;
    }
    const allow = !/reject|deny/i.test(option.kind);
    this.clear(id);
    entry.resolve({ allow, remember: allow && choice.remember, timedOut: false });
    return true;
  }

  /** Explicitly deny/dismiss a pending prompt (user pressed Deny / closed it). */
  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.clear(id);
    entry.resolve({ allow: false, remember: false, timedOut: false });
  }

  /** Deny every pending prompt (called on deactivate). Also clears session state. */
  cancelAll(): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve({ allow: false, remember: false, timedOut: false });
    }
    this.pending.clear();
    this.allowlist.clear();
  }

  private clear(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
    this.onResolve?.(id);
  }

  // --- Per-session allow-list ------------------------------------------------

  isAllowlisted(sessionId: string, key: string): boolean {
    return this.allowlist.get(sessionId)?.has(key) ?? false;
  }

  remember(sessionId: string, key: string): void {
    let set = this.allowlist.get(sessionId);
    if (!set) {
      set = new Set();
      this.allowlist.set(sessionId, set);
    }
    set.add(key);
  }

  clearSession(sessionId: string): void {
    this.allowlist.delete(sessionId);
  }

  // --- Append-only audit log -------------------------------------------------

  recordAudit(entry: PermissionAuditEntry): void {
    this.auditLog.push(entry);
  }

  getAuditLog(): readonly PermissionAuditEntry[] {
    return this.auditLog;
  }
}
