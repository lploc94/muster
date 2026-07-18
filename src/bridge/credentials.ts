import { randomBytes } from 'crypto';
import type { ToolAction } from '../task/capabilities';

export interface CredentialContext {
  credentialId: string;
  rootId: string;
  callerTaskId: string;
  turnId: string;
  /** Opaque engine-allocated attempt id; binds readiness evidence to this mint. */
  attemptId: string;
  allowedActions: ReadonlySet<ToolAction>;
  expiry: number;
}

interface StoredCredential extends CredentialContext {
  token: string;
}

export type CredentialRejectionReason = 'missing' | 'expired' | 'revoked';
export type CredentialVerification =
  | { ok: true; context: CredentialContext }
  | {
      ok: false;
      reason: CredentialRejectionReason;
      credentialId?: string;
      callerTaskId?: string;
      turnId?: string;
      attemptId?: string;
    };

const MAX_INVALIDATED_CREDENTIALS = 256;

function turnAttemptKey(turnId: string, attemptId: string): string {
  return `${turnId}::${attemptId}`;
}

export class CredentialRegistry {
  private readonly byToken = new Map<string, StoredCredential>();
  /** Composite turnId::attemptId → bearer token for the active mint. */
  private readonly byTurnAttempt = new Map<string, string>();
  /** turnId → set of active composite keys (supports revoke(turnId) for all attempts). */
  private readonly attemptsByTurn = new Map<string, Set<string>>();
  /** Bounded tombstones make 401 diagnostics useful without ever logging bearer tokens. */
  private readonly invalidated = new Map<
    string,
    Pick<CredentialContext, 'credentialId' | 'callerTaskId' | 'turnId' | 'attemptId'> & {
      reason: Exclude<CredentialRejectionReason, 'missing'>;
    }
  >();

  issue(params: {
    rootId: string;
    callerTaskId: string;
    turnId: string;
    attemptId: string;
    allowedActions: ReadonlySet<ToolAction>;
    ttlMs: number;
  }): string {
    // One live credential per turn: revoke every prior attempt for this turnId.
    this.revoke(params.turnId);
    const token = randomBytes(32).toString('hex');
    const credentialId = randomBytes(8).toString('hex');
    const stored: StoredCredential = {
      credentialId,
      rootId: params.rootId,
      callerTaskId: params.callerTaskId,
      turnId: params.turnId,
      attemptId: params.attemptId,
      allowedActions: params.allowedActions,
      expiry: Date.now() + params.ttlMs,
      token,
    };
    const key = turnAttemptKey(params.turnId, params.attemptId);
    this.byToken.set(token, stored);
    this.byTurnAttempt.set(key, token);
    let attempts = this.attemptsByTurn.get(params.turnId);
    if (!attempts) {
      attempts = new Set();
      this.attemptsByTurn.set(params.turnId, attempts);
    }
    attempts.add(key);
    return token;
  }

  verify(token: string): CredentialContext | null {
    const verified = this.verifyDetailed(token);
    return verified.ok ? verified.context : null;
  }

  verifyDetailed(token: string): CredentialVerification {
    const stored = this.byToken.get(token);
    if (!stored) {
      const invalidated = this.invalidated.get(token);
      return invalidated
        ? { ok: false, ...invalidated }
        : { ok: false, reason: 'missing' };
    }
    if (Date.now() > stored.expiry) {
      this.invalidate(token, stored, 'expired');
      return {
        ok: false,
        reason: 'expired',
        credentialId: stored.credentialId,
        callerTaskId: stored.callerTaskId,
        turnId: stored.turnId,
        attemptId: stored.attemptId,
      };
    }
    return {
      ok: true,
      context: {
        credentialId: stored.credentialId,
        rootId: stored.rootId,
        callerTaskId: stored.callerTaskId,
        turnId: stored.turnId,
        attemptId: stored.attemptId,
        allowedActions: stored.allowedActions,
        expiry: stored.expiry,
      },
    };
  }

  /**
   * Revoke a single turnId+attemptId mint. Prefer this when superseding one attempt;
   * issue() already revokes all prior attempts for the turn for one-live-credential safety.
   */
  revokeAttempt(turnId: string, attemptId: string): void {
    const key = turnAttemptKey(turnId, attemptId);
    const token = this.byTurnAttempt.get(key);
    if (!token) {
      return;
    }
    const stored = this.byToken.get(token);
    if (!stored) return;
    this.invalidate(token, stored, 'revoked');
  }

  /** Revoke every active attempt for a turn (settle / cleanupTurnResources path). */
  revoke(turnId: string): void {
    const attempts = this.attemptsByTurn.get(turnId);
    if (!attempts || attempts.size === 0) {
      return;
    }
    // Copy keys — invalidate mutates attemptsByTurn.
    for (const key of [...attempts]) {
      const token = this.byTurnAttempt.get(key);
      if (!token) continue;
      const stored = this.byToken.get(token);
      if (!stored) continue;
      this.invalidate(token, stored, 'revoked');
    }
  }

  revokeAll(): void {
    for (const [token, stored] of this.byToken) {
      this.invalidate(token, stored, 'revoked');
    }
  }

  private invalidate(
    token: string,
    stored: StoredCredential,
    reason: Exclude<CredentialRejectionReason, 'missing'>,
  ): void {
    this.byToken.delete(token);
    const key = turnAttemptKey(stored.turnId, stored.attemptId);
    this.byTurnAttempt.delete(key);
    const attempts = this.attemptsByTurn.get(stored.turnId);
    if (attempts) {
      attempts.delete(key);
      if (attempts.size === 0) {
        this.attemptsByTurn.delete(stored.turnId);
      }
    }
    this.invalidated.set(token, {
      credentialId: stored.credentialId,
      callerTaskId: stored.callerTaskId,
      turnId: stored.turnId,
      attemptId: stored.attemptId,
      reason,
    });
    while (this.invalidated.size > MAX_INVALIDATED_CREDENTIALS) {
      const oldest = this.invalidated.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.invalidated.delete(oldest);
    }
  }
}
