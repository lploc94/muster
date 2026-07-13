import { describe, expect, it } from 'vitest';
import { CliAdapter, runCommandText } from './adapter';
import { helpEntries } from '../commands/registry';
import type { CommandDomainPort } from '../commands/types';
import { COMMAND_BEHAVIOR } from '../commands/behavior-matrix';

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

  it('returns JSON for every safe global command', async () => {
    const safeGlobal = COMMAND_BEHAVIOR.filter(
      (command) => command.instantSafe && !command.requiresTask && command.availability === 'implemented',
    );
    expect(safeGlobal.map((command) => command.id).sort()).toEqual(['help', 'mcp', 'tasks']);

    for (const command of safeGlobal) {
      const out: string[] = [];
      const adapter = new CliAdapter({
        domain: mockDomain(),
        stdout: (line) => out.push(line),
      });
      const code = await adapter.run([command.id, '--json']);
      expect(code, command.id).toBe(0);
      expect(JSON.parse(out[0])).toMatchObject({
        ok: true,
        commandId: command.id,
      });
    }
  });

  it('keeps task-scoped CLI commands rejected without focus', async () => {
    const domain = mockDomain();
    domain.getFocusedTaskId = () => undefined;
    for (const command of COMMAND_BEHAVIOR.filter((entry) => entry.requiresTask)) {
      const result = await runCommandText(domain, `/${command.id}`, { yes: true });
      expect(result && 'ok' in result, command.id).toBe(true);
      if (result && 'ok' in result) {
        expect(result.ok, command.id).toBe(false);
      }
    }
  });
});
