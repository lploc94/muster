import { describe, expect, it } from 'vitest';
import { CliAdapter, runCommandText } from './adapter';
import { helpEntries } from '../commands/registry';
import type { CommandDomainPort } from '../commands/types';

function mockDomain(): CommandDomainPort {
  return {
    getFocusedTaskId: () => 'root-1',
    getWorkflowPhase: () => 'awaiting_plan_approval',
    listTasks: () => [{ id: 'root-1', goal: 'Ship', lifecycle: 'open', parentId: null }],
    createDraft: () => ({ taskId: 'd1' }),
    createRootWithGoal: () => ({ taskId: 'r1', turnId: 't1' }),
    focusTask: () => ({ ok: true }),
    cancelTask: () => ({ ok: true }),
    getStatus: () => ({ id: 'root-1' }),
    approvePlan: () => ({
      ok: true,
      commandId: 'approve',
      effectClass: 'mutate_execution',
      presenter: 'approval',
      message: 'approved',
    }),
    replan: () => ({
      ok: true,
      commandId: 'replan',
      effectClass: 'mutate_plan',
      presenter: 'plan_card',
      message: 'replanning',
    }),
    runWorkflowCommand: (req) => ({
      ok: true,
      commandId: req.commandId,
      effectClass: 'read',
      presenter: 'message',
      message: `ok ${req.commandId}`,
    }),
    getHelpEntries: () => helpEntries(),
  };
}

describe('CLI adapter', () => {
  it('requires --yes for approve', async () => {
    const lines: string[] = [];
    const adapter = new CliAdapter({
      domain: mockDomain(),
      stderr: (l) => lines.push(l),
    });
    const code = await adapter.run(['approve']);
    expect(code).toBe(2);
    expect(lines.join(' ')).toMatch(/--yes/);
  });

  it('runs help without --yes', async () => {
    const out: string[] = [];
    const adapter = new CliAdapter({
      domain: mockDomain(),
      json: true,
      stdout: (l) => out.push(l),
    });
    const code = await adapter.run(['help', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.commandId).toBe('help');
  });

  it('preserves command-specific flags for the shared parser', async () => {
    const seen: string[] = [];
    const adapter = new CliAdapter({
      domain: {
        ...mockDomain(),
        createRootWithGoal: (params) => {
          seen.push(`${params.goal}:${params.backend}`);
          return { taskId: 'r2', turnId: 't2' };
        },
      },
    });
    await adapter.run(['new', 'goal', '--backend', 'codex']);
    expect(seen).toEqual(['goal:codex']);
  });

  it('parity: runCommandText matches domain approve', async () => {
    const result = await runCommandText(mockDomain(), '/approve', { yes: true });
    expect(result).toMatchObject({ ok: true, commandId: 'approve' });
  });
});
