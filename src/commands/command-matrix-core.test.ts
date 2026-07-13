import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskEngine } from '../task/engine';
import { TaskStore } from '../task/store';
import type { Backend, BackendCapabilities, NormalizedEvent } from '../types';
import { NATIVE_COMMAND_SPECS } from '../workflow/contracts';
import { getWorkflowRunForRoot } from '../workflow/store';
import { COMMAND_BEHAVIOR } from './behavior-matrix';
import { createEngineDomainPort } from './domain-adapter';
import { CommandService } from './service';

const tempDirs: string[] = [];

const MCP_CAPS: BackendCapabilities = {
  supportsMCP: true,
  supportsReasoning: false,
  supportsDetailedToolEvents: false,
};

function makeBackend(): Backend {
  return {
    name: 'fake',
    capabilities: MCP_CAPS,
    async *run(): AsyncIterable<NormalizedEvent> {
      yield { type: 'sessionStarted', sessionId: 'fake-session' };
      yield { type: 'assistantDelta', messageId: 'fake-response', content: 'ok' };
      yield { type: 'turnCompleted' };
    },
    extractSessionId: (_raw, last) => last,
  };
}

function makeHarness(): {
  store: TaskStore;
  engine: TaskEngine;
  service: CommandService;
  focused: () => string | undefined;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-command-matrix-'));
  tempDirs.push(dir);
  const store = TaskStore.load({ filePath: path.join(dir, 'tasks.json') });
  const engine = TaskEngine.load({
    store,
    makeBackend,
    clock: () => '2026-07-13T03:00:00.000Z',
  });
  let focusedTaskId: string | undefined;
  const service = new CommandService({
    domain: createEngineDomainPort({
      engine,
      store,
      defaultBackend: 'fake',
      cwd: dir,
      getFocusedTaskId: () => focusedTaskId,
      setFocusedTaskId: (id) => {
        focusedTaskId = id;
      },
    }),
    interaction: {
      confirm: async () => true,
      choose: async (_message, options) => options[0],
      ask: async () => undefined,
    },
  });
  return { store, engine, service, focused: () => focusedTaskId };
}

async function run(service: CommandService, input: string) {
  const result = await service.handleInput(input);
  expect(result && 'ok' in result, `${input} returned ${JSON.stringify(result)}`).toBe(true);
  return result as Awaited<ReturnType<CommandService['execute']>>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('native slash command matrix core behavior', () => {
  it('declares every command as implemented or explicitly unavailable', () => {
    expect(COMMAND_BEHAVIOR).toHaveLength(NATIVE_COMMAND_SPECS.length);
    for (const command of COMMAND_BEHAVIOR) {
      if (command.availability === 'disabled') {
        expect(command.disabledReason).toMatch(/not implemented|unavailable/i);
      } else {
        expect(command.successMessage).toMatch(/.+/);
      }
    }
  });

  it('rejects task-scoped commands without mutating a task when no task is focused', async () => {
    const { service } = makeHarness();
    for (const command of COMMAND_BEHAVIOR.filter((entry) => entry.requiresTask)) {
      const result = await service.handleInput(`/${command.id}`);
      expect(result && 'ok' in result, command.id).toBe(true);
      if (result && 'ok' in result) {
        expect(result.ok, command.id).toBe(false);
        if (!result.ok) expect(result.error.code, command.id).toBe('NOT_FOUND');
      }
    }
  });

  it('drives the workflow commands through real store mutations and queued turns', async () => {
    const { store, engine, service, focused } = makeHarness();

    const created = await run(service, '/new Build a colour-palette page');
    expect(created).toMatchObject({ ok: true, commandId: 'new' });
    const rootTaskId = focused();
    expect(rootTaskId).toBeTruthy();
    await engine.whenIdle();
    expect(getWorkflowRunForRoot(store.getFile(), rootTaskId!)?.phase).toBe('thinking');

    const backend = await run(service, '/backend claude');
    expect(backend).toMatchObject({ ok: true, commandId: 'backend' });

    const model = await run(service, '/model test-model');
    expect(model).toMatchObject({ ok: true, commandId: 'model' });
    expect(store.getTask(rootTaskId!)?.model).toBe('test-model');

    const thought = await run(service, '/think Build a colour-palette page');
    expect(thought).toMatchObject({ ok: true, commandId: 'think', presenter: 'plan_card' });
    expect(getWorkflowRunForRoot(store.getFile(), rootTaskId!)?.phase).toBe('thinking');
    expect(Object.values(store.getFile().workflowArtifacts ?? {}).some((a) => a.kind === 'decision_brief')).toBe(true);

    const plan = await run(service, '/plan Build a colour-palette page');
    expect(plan).toMatchObject({ ok: true, commandId: 'plan', presenter: 'plan_card' });
    const runAfterPlan = getWorkflowRunForRoot(store.getFile(), rootTaskId!);
    expect(runAfterPlan?.phase).toBe('awaiting_plan_approval');
    expect(runAfterPlan?.approval?.status).toBe('pending');
    expect(Object.values(store.getFile().workflowArtifacts ?? {}).some((a) => a.kind === 'plan')).toBe(true);

    const status = await run(service, '/status');
    expect(status).toMatchObject({ ok: true, commandId: 'status', presenter: 'status' });

    const context = await run(service, '/context');
    expect(context).toMatchObject({ ok: true, commandId: 'context', presenter: 'context' });

    const approved = await run(service, '/approve');
    expect(approved).toMatchObject({ ok: true, commandId: 'approve', presenter: 'approval' });
    await engine.whenIdle();
    expect(getWorkflowRunForRoot(store.getFile(), rootTaskId!)?.phase).toBe('implementing');
    expect(Object.values(store.getFile().tasks).filter((task) => task.parentId === rootTaskId)).toHaveLength(1);

    const implemented = await run(service, '/implement');
    expect(implemented).toMatchObject({ ok: true, commandId: 'implement' });

    const tested = await run(service, '/test default');
    expect(tested).toMatchObject({ ok: true, commandId: 'test' });
    expect((tested.data as { turnId?: string }).turnId).toBeTruthy();
    await engine.whenIdle();
    expect(Object.values(store.getFile().workflowArtifacts ?? {}).some((a) => a.kind === 'test_report')).toBe(true);

    const reviewed = await run(service, '/review diff');
    expect(reviewed).toMatchObject({ ok: true, commandId: 'review' });
    await engine.whenIdle();
    expect(Object.values(store.getFile().workflowArtifacts ?? {}).some((a) => a.kind === 'review_report')).toBe(true);

    const debugged = await run(service, '/debug injected contrast assertion failed');
    expect(debugged).toMatchObject({ ok: true, commandId: 'debug' });
    await engine.whenIdle();
    expect(Object.values(store.getFile().workflowArtifacts ?? {}).some((a) => a.kind === 'debug_report')).toBe(true);

    const verified = await run(service, '/verify browser');
    expect(verified).toMatchObject({ ok: true, commandId: 'verify' });
    await engine.whenIdle();
    expect(Object.values(store.getFile().workflowArtifacts ?? {}).some((a) => a.kind === 'verification_report')).toBe(true);

    const finished = await run(service, '/finish');
    expect(finished).toMatchObject({ ok: true, commandId: 'finish' });
    expect(store.getTask(rootTaskId!)?.outcomeProposal?.kind).toBe('complete');

    const exported = await run(service, '/export json');
    expect(exported).toMatchObject({ ok: true, commandId: 'export', presenter: 'export' });
    expect((exported.data as { content?: string }).content).toContain('"workflow"');

    const archived = await run(service, '/archive');
    expect(archived).toMatchObject({ ok: true, commandId: 'archive' });
    expect(getWorkflowRunForRoot(store.getFile(), rootTaskId!)).toBeUndefined();
  });

  it('keeps unimplemented slash commands as explicit errors if invoked directly', async () => {
    const { service } = makeHarness();
    await run(service, '/new');
    for (const command of COMMAND_BEHAVIOR.filter((entry) => entry.availability === 'disabled')) {
      const result = await service.handleInput(`/${command.id}`);
      expect(result && 'ok' in result, command.id).toBe(true);
      if (result && 'ok' in result) {
        expect(result.ok, command.id).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(/not implemented/i);
      }
    }
  });
});
