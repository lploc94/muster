import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TOOL_FILE_CHANGE_TEXT_MAX,
  TOOL_FILE_CHANGES_MAX_FILES,
} from '../shared/tool-file-changes';
import { TaskEngine, type EngineEvent } from './engine';
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
  dbPath: string;
  client: DbClient;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-engine-tool-evidence-${label}-`));
  tempDirs.push(dir);
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  const dbPath = path.join(dir, 'muster.sqlite3');
  await client.open(dbPath);
  const repository = new SqliteTaskRepository(client, 'ws');
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: `tool-evidence-${label}`,
    displayName: 'Tool evidence',
    createdAt: 'now',
    lastOpenedAt: 'now',
  });
  return { repository, dir, dbPath, client };
}

async function reopenRepo(dbPath: string): Promise<{
  repository: SqliteTaskRepository;
  client: DbClient;
}> {
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  await client.open(dbPath);
  return { repository: new SqliteTaskRepository(client, 'ws'), client };
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

  it('persists initial toolStarted evidence when completion does not repeat it', async () => {
    const { repository } = await openRepo('start-then-complete');
    const t = await seedTurn(repository, 'start-task', 'start-turn');
    const fileChanges = [
      { path: 'src/initial.ts', oldText: 'before\n', newText: 'after\n' },
    ];

    const engine = await TaskEngine.loadAsync({
      workspaceId: 'ws',
      repository,
      makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
      runTurn: async function* () {
        yield {
          type: 'toolStarted',
          toolCallId: 'initial-1',
          name: 'Edit',
          kind: 'builtin',
          fileChanges,
        };
        yield {
          type: 'toolCompleted',
          toolCallId: 'initial-1',
          outcome: 'success',
          output: 'edited',
        };
        yield { type: 'turnCompleted' };
      },
      clock: () => '2026-07-16T00:00:02.000Z',
    });

    await engine.resumeQueuedTurnAsync(t.id, 'start-turn');
    await engine.whenIdle().catch(() => undefined);

    const tool = toolByCallId(await repository.listToolCalls(t.id), 'initial-1');
    expect(tool.status).toBe('success');
    expect(tool.fileChanges).toEqual(fileChanges);
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
    expect(tool.fileChangesOmitted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(tool, 'fileChangesOmitted')).toBe(false);
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

describe('TaskEngine tool evidence bounding (M020 S02 T02)', () => {
  it('persists three fileChanges entries from one toolCompleted',
    async () => {
      const { repository } = await openRepo('three-files');
      const t = await seedTurn(repository, 'three-task', 'three-turn');

      const fileChanges = [
        { path: 'a.ts', oldText: 'a1', newText: 'a2' },
        { path: 'b.ts', oldText: 'b1', newText: 'b2' },
        { path: 'c.ts', oldText: null, newText: 'c-new' },
      ];

      const engine = await TaskEngine.loadAsync({
        workspaceId: 'ws',
        repository,
        makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
        runTurn: async function* () {
          yield {
            type: 'toolStarted',
            toolCallId: 'multi-1',
            name: 'MultiEdit',
            kind: 'builtin',
          };
          yield {
            type: 'toolCompleted',
            toolCallId: 'multi-1',
            outcome: 'success',
            output: 'edited-3',
            fileChanges,
          };
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      await engine.resumeQueuedTurnAsync(t.id, 'three-turn');
      await engine.whenIdle().catch(() => undefined);

      const tool = toolByCallId(await repository.listToolCalls(t.id), 'multi-1');
      expect(tool.fileChanges).toEqual(fileChanges);
      expect(tool.fileChangesOmitted).toBeUndefined();
    },
    60_000,
  );

  it('clips oversized newText, sets truncated: true, and stays within the bound',
    async () => {
      const { repository } = await openRepo('truncate');
      const t = await seedTurn(repository, 'trunc-task', 'trunc-turn');
      const huge = 'x'.repeat(TOOL_FILE_CHANGE_TEXT_MAX + 50);

      const engine = await TaskEngine.loadAsync({
        workspaceId: 'ws',
        repository,
        makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
        runTurn: async function* () {
          yield {
            type: 'toolStarted',
            toolCallId: 'big-1',
            name: 'Edit',
            kind: 'builtin',
          };
          yield {
            type: 'toolCompleted',
            toolCallId: 'big-1',
            outcome: 'success',
            output: 'big',
            fileChanges: [{ path: 'big.ts', oldText: 'old', newText: huge }],
          };
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      await engine.resumeQueuedTurnAsync(t.id, 'trunc-turn');
      await engine.whenIdle().catch(() => undefined);

      const tool = toolByCallId(await repository.listToolCalls(t.id), 'big-1');
      const entry = tool.fileChanges?.[0];
      expect(entry).toBeDefined();
      expect(entry!.truncated).toBe(true);
      expect(Buffer.byteLength(entry!.newText, 'utf8')).toBeLessThanOrEqual(
        TOOL_FILE_CHANGE_TEXT_MAX,
      );
      expect(entry!.newText).not.toContain('… truncated');
      expect(entry!.oldText).toBe('old');
      expect(tool.fileChangesOmitted).toBeUndefined();
    },
    60_000,
  );

  it('keeps the first 32 of 40 entries and reports fileChangesOmitted: 8',
    async () => {
      const { repository } = await openRepo('omitted');
      const t = await seedTurn(repository, 'omit-task', 'omit-turn');
      const fileChanges = Array.from({ length: 40 }, (_, i) => ({
        path: `f${i}.ts`,
        oldText: 'o',
        newText: 'n',
      }));

      const emitted: EngineEvent[] = [];
      const engine = await TaskEngine.loadAsync({
        workspaceId: 'ws',
        repository,
        makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
        runTurn: async function* () {
          yield {
            type: 'toolStarted',
            toolCallId: 'many-1',
            name: 'Edit',
            kind: 'builtin',
          };
          yield {
            type: 'toolCompleted',
            toolCallId: 'many-1',
            outcome: 'success',
            output: 'many',
            fileChanges,
          };
          yield { type: 'turnCompleted' };
        },
        emit: (event) => emitted.push(event),
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      await engine.resumeQueuedTurnAsync(t.id, 'omit-turn');
      await engine.whenIdle().catch(() => undefined);

      const tool = toolByCallId(await repository.listToolCalls(t.id), 'many-1');
      expect(tool.fileChanges).toHaveLength(TOOL_FILE_CHANGES_MAX_FILES);
      expect(tool.fileChanges?.[0]?.path).toBe('f0.ts');
      expect(tool.fileChanges?.[31]?.path).toBe('f31.ts');
      expect(tool.fileChangesOmitted).toBe(8);

      const live = emitted.find(
        (candidate): candidate is Extract<EngineEvent, { type: 'event' }> =>
          candidate.type === 'event' &&
          candidate.event.type === 'toolCompleted' &&
          candidate.event.toolCallId === 'many-1',
      );
      expect(live?.event.fileChanges).toEqual(tool.fileChanges);
      expect(live?.event.fileChangesOmitted).toBe(8);
    },
    60_000,
  );

  it('relativizes absolute in-cwd paths and basenames outside-cwd / drive paths',
    async () => {
      const cwd = path.join(os.tmpdir(), 'muster-evidence-cwd');
      fs.mkdirSync(cwd, { recursive: true });
      tempDirs.push(cwd);
      const { repository } = await openRepo('sanitize');
      // Persist cwd on the task so the stream loop can relativize under it.
      const t = await seedTurn(repository, 'sanitize-task', 'sanitize-turn');
      await repository.execute({
        kind: 'updateTask',
        workspaceId: 'ws',
        taskId: t.id,
        patch: { cwd },
      } as never).catch(async () => {
        // Fallback: rewrite via create-style update if updateTask shape differs.
        const existing = (await repository.listTasks()).find((row) => row.id === t.id);
        if (!existing) throw new Error('missing task for cwd patch');
        await repository.execute({
          kind: 'upsertTask',
          workspaceId: 'ws',
          task: { ...existing, cwd },
        } as never);
      });

      // Re-read so the engine projection has cwd if needed after reload path.
      const absInCwd = path.join(cwd, 'src', 'main.ts');
      const absOutside = path.join(os.tmpdir(), 'outside-secret.ts');

      const engine = await TaskEngine.loadAsync({
        workspaceId: 'ws',
        repository,
        workspaceFolder: cwd,
        makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
        runTurn: async function* () {
          yield {
            type: 'toolStarted',
            toolCallId: 'path-1',
            name: 'Edit',
            kind: 'builtin',
          };
          yield {
            type: 'toolCompleted',
            toolCallId: 'path-1',
            outcome: 'success',
            output: 'paths',
            fileChanges: [
              { path: absInCwd, oldText: 'a', newText: 'b' },
              { path: absOutside, oldText: 'c', newText: 'd' },
              {
                path: 'C:\\Users\\alice\\AppData\\Local\\secret.ts',
                oldText: 'e',
                newText: 'f',
              },
            ],
          };
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      await engine.resumeQueuedTurnAsync(t.id, 'sanitize-turn');
      await engine.whenIdle().catch(() => undefined);

      const tool = toolByCallId(await repository.listToolCalls(t.id), 'path-1');
      expect(tool.fileChanges).toHaveLength(3);
      expect(tool.fileChanges?.[0]?.path).toBe('src/main.ts');
      expect(tool.fileChanges?.[1]?.path).toBe('outside-secret.ts');
      expect(tool.fileChanges?.[2]?.path).toBe('secret.ts');
      for (const entry of tool.fileChanges ?? []) {
        expect(entry.path).not.toMatch(/^[A-Za-z]:/);
        expect(entry.path).not.toContain('Users');
        expect(entry.path).not.toContain('\\');
      }
    },
    60_000,
  );

  it('survives SQLite close/reopen with the same bounded sanitized evidence',
    async () => {
      const cwd = path.join(os.tmpdir(), 'muster-evidence-reopen-cwd');
      fs.mkdirSync(cwd, { recursive: true });
      tempDirs.push(cwd);
      const { repository, dbPath, client } = await openRepo('reopen');
      const t = await seedTurn(repository, 'reopen-task', 'reopen-turn');

      const huge = 'z'.repeat(TOOL_FILE_CHANGE_TEXT_MAX + 20);
      const many = Array.from({ length: 35 }, (_, i) => ({
        path: path.join(cwd, `file${i}.ts`),
        oldText: 'o',
        newText: i === 0 ? huge : 'n',
      }));

      const engine = await TaskEngine.loadAsync({
        workspaceId: 'ws',
        repository,
        workspaceFolder: cwd,
        makeBackend: () => ({ name: 'fake', run: async function* () {} }) as never,
        runTurn: async function* () {
          yield {
            type: 'toolStarted',
            toolCallId: 'reopen-1',
            name: 'Edit',
            kind: 'builtin',
          };
          yield {
            type: 'toolCompleted',
            toolCallId: 'reopen-1',
            outcome: 'success',
            output: 'reopen',
            fileChanges: many,
          };
          yield { type: 'turnCompleted' };
        },
        clock: () => '2026-07-16T00:00:02.000Z',
      });

      await engine.resumeQueuedTurnAsync(t.id, 'reopen-turn');
      await engine.whenIdle().catch(() => undefined);

      const before = toolByCallId(await repository.listToolCalls(t.id), 'reopen-1');
      expect(before.fileChanges).toHaveLength(TOOL_FILE_CHANGES_MAX_FILES);
      expect(before.fileChangesOmitted).toBe(3);
      expect(before.fileChanges?.[0]?.path).toBe('file0.ts');
      expect(before.fileChanges?.[0]?.truncated).toBe(true);
      expect(before.fileChanges?.[0]?.newText).not.toContain('… truncated');

      // Close the original client, then reopen a fresh repository on the same db.
      await client.close().catch(() => undefined);
      const idx = clients.indexOf(client);
      if (idx >= 0) clients.splice(idx, 1);

      const reopened = await reopenRepo(dbPath);
      const after = toolByCallId(await reopened.repository.listToolCalls(t.id), 'reopen-1');
      expect(after.fileChanges).toEqual(before.fileChanges);
      expect(after.fileChangesOmitted).toBe(before.fileChangesOmitted);
      expect(after.output).toBe('reopen');
    },
    60_000,
  );
});
