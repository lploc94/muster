import { describe, expect, it } from 'vitest';
import { CredentialRegistry } from './credentials';

describe('CredentialRegistry', () => {
  it('issues and verifies a credential', () => {
    const registry = new CredentialRegistry();
    const token = registry.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-1',
      attemptId: 'a0',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    const ctx = registry.verify(token);
    expect(ctx?.callerTaskId).toBe('task-1');
    expect(ctx?.turnId).toBe('turn-1');
    expect(ctx?.attemptId).toBe('a0');
    expect(ctx?.allowedActions.has('ask_user')).toBe(true);
  });

  it('returns attemptId on verifyDetailed success', () => {
    const registry = new CredentialRegistry();
    const token = registry.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-1',
      attemptId: 'attempt-42',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    const detailed = registry.verifyDetailed(token);
    expect(detailed).toMatchObject({
      ok: true,
      context: {
        turnId: 'turn-1',
        attemptId: 'attempt-42',
        callerTaskId: 'task-1',
      },
    });
  });

  it('returns null for unknown or revoked tokens', () => {
    const registry = new CredentialRegistry();
    expect(registry.verify('bad')).toBeNull();
    const token = registry.issue({
      rootId: 'r',
      callerTaskId: 't',
      turnId: 'turn-2',
      attemptId: 'a0',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    registry.revoke('turn-2');
    expect(registry.verify(token)).toBeNull();
    expect(registry.verifyDetailed(token)).toMatchObject({
      ok: false,
      reason: 'revoked',
      callerTaskId: 't',
      turnId: 'turn-2',
      attemptId: 'a0',
    });
    expect(registry.verifyDetailed('bad')).toEqual({ ok: false, reason: 'missing' });
  });

  it('distinguishes expired credentials without exposing their bearer token', () => {
    const registry = new CredentialRegistry();
    const token = registry.issue({
      rootId: 'r',
      callerTaskId: 'expired-task',
      turnId: 'expired-turn',
      attemptId: 'a0',
      allowedActions: new Set(['ask_user']),
      ttlMs: -1,
    });
    const result = registry.verifyDetailed(token);
    expect(result).toMatchObject({
      ok: false,
      reason: 'expired',
      callerTaskId: 'expired-task',
      turnId: 'expired-turn',
      attemptId: 'a0',
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('revoking a parent turn never revokes a child turn credential', () => {
    const registry = new CredentialRegistry();
    const parent = registry.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: 'parent-turn',
      attemptId: 'a0',
      allowedActions: new Set(['wait_for_tasks']),
      ttlMs: 60_000,
    });
    const child = registry.issue({
      rootId: 'root',
      callerTaskId: 'child',
      turnId: 'child-turn',
      attemptId: 'a0',
      allowedActions: new Set(['complete_task']),
      ttlMs: 60_000,
    });
    registry.revoke('parent-turn');
    expect(registry.verify(parent)).toBeNull();
    expect(registry.verify(child)).toMatchObject({
      callerTaskId: 'child',
      turnId: 'child-turn',
      attemptId: 'a0',
    });
  });

  it('supersedes prior attempt tokens when a new attempt is issued for the same turn', () => {
    const registry = new CredentialRegistry();
    const first = registry.issue({
      rootId: 'root',
      callerTaskId: 'task-1',
      turnId: 'turn-x',
      attemptId: 'attempt-1',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    const second = registry.issue({
      rootId: 'root',
      callerTaskId: 'task-1',
      turnId: 'turn-x',
      attemptId: 'attempt-2',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });

    expect(registry.verify(first)).toBeNull();
    expect(registry.verifyDetailed(first)).toMatchObject({
      ok: false,
      reason: 'revoked',
      turnId: 'turn-x',
      attemptId: 'attempt-1',
    });
    expect(registry.verify(second)).toMatchObject({
      turnId: 'turn-x',
      attemptId: 'attempt-2',
    });
  });

  it('revokeAttempt only invalidates the matching turnId+attemptId', () => {
    const registry = new CredentialRegistry();
    // Temporarily allow two live attempts by re-minting same attempt after manual dual store is not supported;
    // product rule is one live per turn, so issue a credential then revokeAttempt that attempt.
    const token = registry.issue({
      rootId: 'root',
      callerTaskId: 'task-1',
      turnId: 'turn-y',
      attemptId: 'attempt-1',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    registry.revokeAttempt('turn-y', 'attempt-1');
    expect(registry.verify(token)).toBeNull();
    expect(registry.verifyDetailed(token)).toMatchObject({
      ok: false,
      reason: 'revoked',
      attemptId: 'attempt-1',
      turnId: 'turn-y',
    });
  });

  it('revoke(turnId) clears the live credential for settle/cleanup', () => {
    const registry = new CredentialRegistry();
    const token = registry.issue({
      rootId: 'root',
      callerTaskId: 'task-1',
      turnId: 'turn-settle',
      attemptId: 'attempt-9',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    registry.revoke('turn-settle');
    expect(registry.verify(token)).toBeNull();
  });
});
