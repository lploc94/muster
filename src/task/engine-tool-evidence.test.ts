import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask, PersistedToolCall } from './types';

const WORKER_TS = path.join(__dirname, 'sqlite/worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const tempDirs: string[] = [];
const clients: DbClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function task(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: id,
    parentId: null,
    prerequisites: [],
    backend: 'fake',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

async function seedTurn(repository: SqliteTaskRepository, taskId: string, turnId: string) {
  const t = task(taskId);
  await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: t });
  await repository.execute({
    kind: 'createTurn',
    workspaceId: 'ws',
    turn: {
      id: turnId,
      taskId: t.id,
      sequence: 1,
      status: 'queued',
      trigger: 'engine',
      inputs: [],
      createdAt: '2026-07-16T00:00:01.000Z',
      runtimeEpoch: 1,
    },
  });
  return t;
}

async function openRepo(label: string): Promise<{
  repository: SqliteTaskRepository;
  dir: string;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-engine-tool-evidence-${label}-`));
  tempDirs.push(dir);
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'ws');
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: `tool-evidence-${label}`,
    displayName: 'Tool evidence',
    createdAt: 'now',
    lastOpenedAt: 'now',
  });
  return { repository, dir };
}

function toolByCallId(tools: readonly PersistedToolCall[], toolCallId: string): PersistedToolCall {
  const match = tools.find((tool) => tool.toolCallId === toolCallId);
  if (!match) throw new Error(`missing tool call ${toolCallId}`);
  return match;
}

describe('TaskEngine tool evidence persistence (M020 S01 T02)', () => {
  it('persists fileChanges from toolCompleted onto the tool_calls payload without schema change', async () => {
    const { repository } = await openRepo('complete');
    const t = await seedTurn(repository, 'evidence-task', 'evidence-turn');

    const fileChanges = [
      {
        path: 'src/example.ts',
        oldText: 'const a = 1;\n',
        newText: 'const a = 2;\n',
      },
    ];

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'toolStarted',
          toolCallId: 'edit-1',
          name: 'Edit',
          kind: 'builtin',
          input: { path: 'src/example.ts' },
        };
        yield {
          type: 'toolCompleted',
          toolCallId: 'edit-1',
          outcome: 'success',
          output: 'edited',
          fileChanges,
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'evidence-turn');
    await engine.whenIdle().catch(() => undefined);

    const tools = await repository.listToolCalls(t.id);
    const tool = toolByCallId(tools, 'edit-1');
    expect(tool.status).toBe('success');
    expect(tool.output).toBe('edited');
    // listToolCalls decodes tool_calls.payload_json remainder — no schema change.
    expect(tool.fileChanges).toEqual(fileChanges);

    // Transcript page still lists the tool row; full evidence is on listToolCalls.
    const page = await repository.getTranscriptPage(t.id, undefined, 20);
    const toolItem = page.items.find((item) => item.kind === 'tool' && item.id === tool.id);
    expect(toolItem).toBeDefined();
    expect(toolItem?.kind).toBe('tool');
  }, 60_000);

  it('merges fileChanges from toolUpdated and keeps them when a later complete omits them', async () => {
    const { repository } = await openRepo('update-then-complete');
    const t = await seedTurn(repository, 'update-task', 'update-turn');

    const fileChanges = [
      {
        path: 'README.md',
        oldText: null,
        newText: '# Created\n',
      },
    ];

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'toolStarted',
          toolCallId: 'write-1',
          name: 'Write',
          kind: 'builtin',
        };
        yield {
          type: 'toolUpdated',
          toolCallId: 'write-1',
          input: { path: 'README.md' },
          fileChanges,
        };
        // Complete carries output only — prior evidence must not be wiped.
        yield {
          type: 'toolCompleted',
          toolCallId: 'write-1',
          outcome: 'success',
          output: 'wrote',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'update-turn');
    await engine.whenIdle().catch(() => undefined);

    const tool = toolByCallId(await repository.listToolCalls(t.id), 'write-1');
    expect(tool.status).toBe('success');
    expect(tool.input).toEqual({ path: 'README.md' });
    expect(tool.output).toBe('wrote');
    expect(tool.fileChanges).toEqual(fileChanges);
  }, 60_000);

  it('omits fileChanges on content-only toolCompleted so payload stays free of empty evidence', async () => {
    const { repository } = await openRepo('content-only');
    const t = await seedTurn(repository, 'plain-task', 'plain-turn');

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'toolStarted',
          toolCallId: 'read-1',
          name: 'Read',
          kind: 'builtin',
          input: { path: 'src/a.ts' },
        };
        yield {
          type: 'toolCompleted',
          toolCallId: 'read-1',
          outcome: 'success',
          output: 'file body',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'plain-turn');
    await engine.whenIdle().catch(() => undefined);

    const tool = toolByCallId(await repository.listToolCalls(t.id), 'read-1');
    expect(tool.status).toBe('success');
    expect(tool.output).toBe('file body');
    expect(tool.fileChanges).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(tool, 'fileChanges')).toBe(false);
  }, 60_000);

  it('persists fileChanges on error outcome without inventing output', async () => {
    const { repository } = await openRepo('error-outcome');
    const t = await seedTurn(repository, 'error-task', 'error-turn');

    const fileChanges = [
      {
        path: 'src/broken.ts',
        oldText: 'x',
        newText: 'y',
      },
    ];

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'toolStarted',
          toolCallId: 'fail-1',
          name: 'Edit',
          kind: 'builtin',
        };
        yield {
          type: 'toolCompleted',
          toolCallId: 'fail-1',
          outcome: 'error',
          error: 'write denied',
          fileChanges,
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'error-turn');
    await engine.whenIdle().catch(() => undefined);

    const tool = toolByCallId(await repository.listToolCalls(t.id), 'fail-1');
    expect(tool.status).toBe('error');
    expect(tool.error).toBe('write denied');
    expect(tool.output).toBeUndefined();
    expect(tool.fileChanges).toEqual(fileChanges);
  }, 60_000);
});
