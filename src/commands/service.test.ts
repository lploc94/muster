import { describe, expect, it, vi } from 'vitest';
import { CommandService } from './service';
import type { CommandDomainPort } from './types';
import { helpEntries } from './registry';

function mockDomain(overrides: Partial<CommandDomainPort> = {}): CommandDomainPort {
  return {
    getFocusedTaskId: () => 'root-1',
    getWorkflowPhase: () => 'awaiting_plan_approval',
    listTasks: () => [{ id: 'root-1', goal: 'Ship', lifecycle: 'open', parentId: null }],
    createDraft: () => ({ taskId: 'draft-1' }),
    createRootWithGoal: (p) => ({ taskId: 'root-new', turnId: 't1' }),
    focusTask: () => ({ ok: true }),
    cancelTask: () => ({ ok: true }),
    getStatus: (id) => ({ id, phase: 'awaiting_plan_approval' }),
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
      effectClass: 'mutate_execution',
      presenter: 'message',
      message: `stub ${req.commandId}`,
    }),
    getHelpEntries: () => helpEntries(),
    ...overrides,
  };
}

describe('CommandService', () => {
  it('routes /help without vscode', async () => {
    const svc = new CommandService({ domain: mockDomain() });
    const result = await svc.handleInput('/help');
    expect(result).toMatchObject({ ok: true, commandId: 'help', presenter: 'help' });
    if (result && 'ok' in result && result.ok) {
      const data = result.data as { commands: unknown[] };
      expect(data.commands.length).toBeGreaterThan(5);
    }
  });

  it('returns structured error for unknown commands', async () => {
    const svc = new CommandService({ domain: mockDomain() });
    const result = await svc.handleInput('/not-a-real-command');
    expect(result).toMatchObject({
      ok: false,
      presenter: 'error',
    });
    if (result && 'ok' in result && !result.ok) {
      expect(result.error.code).toBe('COMMAND_UNKNOWN');
    }
  });

  it('creates draft for /new without goal', async () => {
    const svc = new CommandService({ domain: mockDomain() });
    const result = await svc.handleInput('/new');
    expect(result).toMatchObject({ ok: true, commandId: 'new' });
    if (result && 'ok' in result && result.ok) {
      expect(result.data).toEqual({ taskId: 'draft-1' });
    }
  });

  it('creates root for /new with goal', async () => {
    const createRootWithGoal = vi.fn(() => ({ taskId: 'r2', turnId: 't2' }));
    const svc = new CommandService({
      domain: mockDomain({ createRootWithGoal }),
    });
    const result = await svc.handleInput('/new implement auth');
    expect(createRootWithGoal).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, commandId: 'new', presenter: 'plan_card' });
  });

  it('passes backend/model flags without including them in the goal', async () => {
    const createRootWithGoal = vi.fn(() => ({ taskId: 'r2', turnId: 't2' }));
    const svc = new CommandService({ domain: mockDomain({ createRootWithGoal }) });
    await svc.handleInput('/new implement auth --backend codex --model gpt-5');
    expect(createRootWithGoal).toHaveBeenCalledWith({
      goal: 'implement auth',
      backend: 'codex',
      model: 'gpt-5',
      message: 'implement auth',
    });
  });

  it('enforces phase precondition for /approve', async () => {
    const svc = new CommandService({
      domain: mockDomain({ getWorkflowPhase: () => 'thinking' }),
    });
    const result = await svc.handleInput('/approve', { focusedTaskId: 'root-1' });
    expect(result).toMatchObject({ ok: false });
    if (result && 'ok' in result && !result.ok) {
      expect(result.error.code).toBe('COMMAND_PHASE');
    }
  });

  it('passes plain text through', async () => {
    const svc = new CommandService({ domain: mockDomain() });
    const result = await svc.handleInput('please implement auth');
    expect(result).toEqual({ kind: 'plain', text: 'please implement auth' });
  });

  it('lists tasks', async () => {
    const svc = new CommandService({ domain: mockDomain() });
    const result = await svc.handleInput('/tasks');
    expect(result).toMatchObject({ ok: true, commandId: 'tasks', presenter: 'task_list' });
  });
});
