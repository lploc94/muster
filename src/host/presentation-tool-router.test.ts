import { describe, expect, it, vi } from 'vitest';
import type { CredentialContext } from '../bridge/credentials';
import type { ToolCommand } from '../task/coordinator-tools';
import { PresentationToolRouter } from './presentation-tool-router';

const context: CredentialContext = {
  credentialId: 'credential-secret',
  rootId: 'root-1',
  callerTaskId: 'task-1',
  turnId: 'turn-1',
  attemptId: 'attempt-1',
  allowedActions: new Set(['upsert_presentation']),
  expiry: Date.now() + 60_000,
};

const command: ToolCommand = {
  kind: 'upsert_presentation',
  presentationId: 'release-notes',
  ownerTaskId: 'task-1',
  opId: 'op-1',
  revision: 1,
  requireExisting: true,
  title: 'Release notes',
  markdown: '# Ready',
};

describe('PresentationToolRouter', () => {
  it('routes an authenticated presentation upsert with credential-derived ownership context', async () => {
    const delegate = { handleToolCall: vi.fn() };
    const manager = { upsert: vi.fn().mockResolvedValue({ ok: true, code: 'opened' }) };
    const router = new PresentationToolRouter(delegate, manager);

    const result = await router.handleToolCall(context, 'upsert_presentation', command);

    expect(result).toEqual({
      ok: true,
      result: { code: 'opened', presentationId: 'release-notes' },
    });
    expect(manager.upsert).toHaveBeenCalledWith(
      { rootId: 'root-1', callerTaskId: 'task-1', turnId: 'turn-1' },
      {
        presentationId: 'release-notes',
        ownerTaskId: 'task-1',
        opId: 'op-1',
        revision: 1,
        requireExisting: true,
        title: 'Release notes',
        markdown: '# Ready',
      },
    );
    expect(delegate.handleToolCall).not.toHaveBeenCalled();
  });

  it('fails closed when the authenticated context lacks presentation capability', async () => {
    const delegate = { handleToolCall: vi.fn() };
    const manager = { upsert: vi.fn() };
    const router = new PresentationToolRouter(delegate, manager);

    const result = await router.handleToolCall(
      { ...context, allowedActions: new Set() },
      'upsert_presentation',
      command,
    );

    expect(result).toEqual({ ok: false, error: 'unauthorized' });
    expect(manager.upsert).not.toHaveBeenCalled();
    expect(delegate.handleToolCall).not.toHaveBeenCalled();
  });

  it('delegates non-presentation commands without changing their result', async () => {
    const delegatedResult = { ok: true as const, result: { runId: 'run-1', runStatus: 'running' } };
    const delegate = { handleToolCall: vi.fn().mockResolvedValue(delegatedResult) };
    const manager = { upsert: vi.fn() };
    const router = new PresentationToolRouter(delegate, manager);
    const inspectionCommand: ToolCommand = { kind: 'inspect_workflow_run', runId: 'run-1' };

    const result = await router.handleToolCall(context, 'inspect_workflow_run', inspectionCommand);

    expect(result).toBe(delegatedResult);
    expect(delegate.handleToolCall).toHaveBeenCalledWith(
      context,
      'inspect_workflow_run',
      inspectionCommand,
    );
    expect(manager.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_arguments', 'invalid_arguments'],
    ['owner_mismatch', 'owner_mismatch'],
    ['payload_too_large', 'payload_too_large'],
    ['op_conflict', 'op_conflict'],
    ['panel_open_failed', 'panel_open_failed'],
  ] as const)('preserves the stable manager failure code %s', async (_label, code) => {
    const delegate = { handleToolCall: vi.fn() };
    const manager = { upsert: vi.fn().mockResolvedValue({ ok: false, code }) };
    const router = new PresentationToolRouter(delegate, manager);

    await expect(router.handleToolCall(context, 'upsert_presentation', command)).resolves.toEqual({
      ok: false,
      error: code,
    });
  });

  it('redacts unexpected presentation host failures', async () => {
    const delegate = { handleToolCall: vi.fn() };
    const manager = {
      upsert: vi.fn().mockRejectedValue(new Error('Release notes # Ready credential-secret')),
    };
    const router = new PresentationToolRouter(delegate, manager);

    const result = await router.handleToolCall(context, 'upsert_presentation', command);

    expect(result).toEqual({ ok: false, error: 'panel_open_failed' });
  });
});
