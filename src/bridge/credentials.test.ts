import { describe, expect, it } from 'vitest';
import { CredentialRegistry } from './credentials';

describe('CredentialRegistry', () => {
  it('issues and verifies a credential', () => {
    const registry = new CredentialRegistry();
    const token = registry.issue({
      rootId: 'root-1',
      callerTaskId: 'task-1',
      turnId: 'turn-1',
      allowedActions: new Set(['ask_user']),
      ttlMs: 60_000,
    });
    const ctx = registry.verify(token);
    expect(ctx?.callerTaskId).toBe('task-1');
    expect(ctx?.turnId).toBe('turn-1');
    expect(ctx?.allowedActions.has('ask_user')).toBe(true);
  });

  it('returns null for unknown or revoked tokens', () => {
    const registry = new CredentialRegistry();
    expect(registry.verify('bad')).toBeNull();
    const token = registry.issue({
      rootId: 'r',
      callerTaskId: 't',
      turnId: 'turn-2',
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
    });
    expect(registry.verifyDetailed('bad')).toEqual({ ok: false, reason: 'missing' });
  });

  it('distinguishes expired credentials without exposing their bearer token', () => {
    const registry = new CredentialRegistry();
    const token = registry.issue({
      rootId: 'r',
      callerTaskId: 'expired-task',
      turnId: 'expired-turn',
      allowedActions: new Set(['ask_user']),
      ttlMs: -1,
    });
    const result = registry.verifyDetailed(token);
    expect(result).toMatchObject({
      ok: false,
      reason: 'expired',
      callerTaskId: 'expired-task',
      turnId: 'expired-turn',
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('revoking a parent turn never revokes a child turn credential', () => {
    const registry = new CredentialRegistry();
    const parent = registry.issue({
      rootId: 'root',
      callerTaskId: 'root',
      turnId: 'parent-turn',
      allowedActions: new Set(['wait_for_tasks']),
      ttlMs: 60_000,
    });
    const child = registry.issue({
      rootId: 'root',
      callerTaskId: 'child',
      turnId: 'child-turn',
      allowedActions: new Set(['complete_task']),
      ttlMs: 60_000,
    });
    registry.revoke('parent-turn');
    expect(registry.verify(parent)).toBeNull();
    expect(registry.verify(child)).toMatchObject({
      callerTaskId: 'child',
      turnId: 'child-turn',
    });
  });
});
