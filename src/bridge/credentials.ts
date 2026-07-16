import { randomBytes } from 'crypto';
import type { ToolAction } from '../task/capabilities';

export interface CredentialContext {
  credentialId: string;
  rootId: string;
  callerTaskId: string;
  turnId: string;
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
    };

const MAX_INVALIDATED_CREDENTIALS = 256;

export class CredentialRegistry {
  private readonly byToken = new Map<string, StoredCredential>();
  private readonly byTurnId = new Map<string, string>();
  /** Bounded tombstones make 401 diagnostics useful without ever logging bearer tokens. */
  private readonly invalidated = new Map<
    string,
    Pick<CredentialContext, 'credentialId' | 'callerTaskId' | 'turnId'> & {
      reason: Exclude<CredentialRejectionReason, 'missing'>;
    }
  >();

  issue(params: {
    rootId: string;
    callerTaskId: string;
    turnId: string;
    allowedActions: ReadonlySet<ToolAction>;
    ttlMs: number;
  }): string {
    this.revoke(params.turnId);
    const token = randomBytes(32).toString('hex');
    const credentialId = randomBytes(8).toString('hex');
    const stored: StoredCredential = {
      credentialId,
      rootId: params.rootId,
      callerTaskId: params.callerTaskId,
      turnId: params.turnId,
      allowedActions: params.allowedActions,
      expiry: Date.now() + params.ttlMs,
      token,
    };
    this.byToken.set(token, stored);
    this.byTurnId.set(params.turnId, token);
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
      };
    }
    return {
      ok: true,
      context: {
        credentialId: stored.credentialId,
        rootId: stored.rootId,
        callerTaskId: stored.callerTaskId,
        turnId: stored.turnId,
        allowedActions: stored.allowedActions,
        expiry: stored.expiry,
      },
    };
  }

  revoke(turnId: string): void {
    const token = this.byTurnId.get(turnId);
    if (!token) {
      return;
    }
    const stored = this.byToken.get(token);
    if (!stored) return;
    this.invalidate(token, stored, 'revoked');
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
    this.byTurnId.delete(stored.turnId);
    this.invalidated.set(token, {
      credentialId: stored.credentialId,
      callerTaskId: stored.callerTaskId,
      turnId: stored.turnId,
      reason,
    });
    while (this.invalidated.size > MAX_INVALIDATED_CREDENTIALS) {
      const oldest = this.invalidated.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.invalidated.delete(oldest);
    }
  }
}
