import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionBridge, type PermissionRequest } from './permission-bridge';

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    sessionId: 's1',
    title: 'Run tests',
    kind: 'execute',
    classification: 'write',
    options: [
      { optionId: 'allow_once', kind: 'allow_once' },
      { optionId: 'reject_once', kind: 'reject_once' },
    ],
    ...overrides,
  };
}

describe('PermissionBridge', () => {
  it('resolves allow when submitting an allow option', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('p1', makeRequest(), 5_000);
    expect(bridge.submit('p1', { optionId: 'allow_once', remember: true })).toBe(true);
    await expect(promise).resolves.toEqual({ allow: true, remember: true, timedOut: false });
  });

  it('maps a reject option to deny and ignores remember', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('p1', makeRequest(), 5_000);
    expect(bridge.submit('p1', { optionId: 'reject_once', remember: true })).toBe(true);
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: false });
  });

  it('denies (safe) on timeout', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('p1', makeRequest(), 5);
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: true });
    // Timed-out prompt is no longer pending.
    expect(bridge.hasPending('p1')).toBe(false);
  });

  it('ignores a submit for an unknown permission id', () => {
    const bridge = new PermissionBridge();
    expect(bridge.submit('nope', { optionId: 'allow_once', remember: false })).toBe(false);
  });

  it('ignores a submit for an option that was not offered', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('p1', makeRequest(), 5_000);
    expect(bridge.submit('p1', { optionId: 'fabricated', remember: false })).toBe(false);
    // Still pending; resolve it so the promise does not dangle.
    bridge.cancel('p1');
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: false });
  });

  it('cancel resolves to a non-timeout deny', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('p1', makeRequest(), 5_000);
    bridge.cancel('p1');
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: false });
  });

  it('fires onRegister and onResolve callbacks', async () => {
    const registered: string[] = [];
    const resolved: string[] = [];
    const bridge = new PermissionBridge({
      onRegister: (id) => registered.push(id),
      onResolve: (id) => resolved.push(id),
    });
    const promise = bridge.register('p1', makeRequest(), 5_000);
    expect(registered).toEqual(['p1']);
    bridge.submit('p1', { optionId: 'allow_once', remember: false });
    await promise;
    expect(resolved).toEqual(['p1']);
  });

  it('tracks a per-session allow-list', () => {
    const bridge = new PermissionBridge();
    expect(bridge.isAllowlisted('s1', 'execute:Run tests')).toBe(false);
    bridge.remember('s1', 'execute:Run tests');
    expect(bridge.isAllowlisted('s1', 'execute:Run tests')).toBe(true);
    // Scoped per session.
    expect(bridge.isAllowlisted('s2', 'execute:Run tests')).toBe(false);
    bridge.clearSession('s1');
    expect(bridge.isAllowlisted('s1', 'execute:Run tests')).toBe(false);
  });

  it('appends to the audit log', () => {
    const bridge = new PermissionBridge();
    bridge.recordAudit({
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      title: 'Run tests',
      kind: 'execute',
      classification: 'write',
      decision: 'allow',
      source: 'user',
    });
    expect(bridge.getAuditLog()).toHaveLength(1);
    expect(bridge.getAuditLog()[0].decision).toBe('allow');
  });

  it('cancelAll denies pending prompts and clears the allow-list', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('p1', makeRequest(), 5_000);
    bridge.remember('s1', 'execute:Run tests');
    bridge.cancelAll();
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: false });
    expect(bridge.isAllowlisted('s1', 'execute:Run tests')).toBe(false);
  });
});

describe('M012 S03 flow: pending ask-mode bridge prompts stay pending until user/timeout/cancel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a pending prompt open across unrelated config changes until the user resolves it', async () => {
    const bridge = new PermissionBridge();
    const promise = bridge.register('perm-pending', makeRequest(), 5_000);

    // Simulated Settings save while the runtime card is still open — bridge state is independent.
    expect(bridge.hasPending('perm-pending')).toBe(true);
    expect(bridge.peek('perm-pending')?.title).toBe('Run tests');

    // User eventually denies; config changes never auto-resolve the pending prompt.
    expect(bridge.submit('perm-pending', { optionId: 'reject_once', remember: false })).toBe(true);
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: false });
    expect(bridge.hasPending('perm-pending')).toBe(false);
  });

  it('clears pending timers on cancel so no timeout fires after resolution', async () => {
    vi.useFakeTimers();
    const bridge = new PermissionBridge();
    const promise = bridge.register('perm-timer', makeRequest(), 1_000);

    bridge.cancel('perm-timer');
    await expect(promise).resolves.toEqual({ allow: false, remember: false, timedOut: false });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(bridge.hasPending('perm-timer')).toBe(false);
  });

  it('cleans all pending timers and controllers via cancelAll', async () => {
    vi.useFakeTimers();
    const bridge = new PermissionBridge();
    const first = bridge.register('a', makeRequest({ title: 'Write a' }), 2_000);
    const second = bridge.register('b', makeRequest({ title: 'Write b' }), 2_000);

    bridge.cancelAll();
    await expect(first).resolves.toEqual({ allow: false, remember: false, timedOut: false });
    await expect(second).resolves.toEqual({ allow: false, remember: false, timedOut: false });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(bridge.hasPending('a')).toBe(false);
    expect(bridge.hasPending('b')).toBe(false);
  });
});
