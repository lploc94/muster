/**
 * Named M020 S01 flow (R024): ACP wire → ClaudeBackend → TaskEngine →
 * SQLite tool_calls.payload_json → host projection contract.
 *
 * Proves one diff block survives end-to-end and content-only tools stay free
 * of empty fileChanges evidence. Independently executable via `npm run test:m020-s01`.
 *
 * Protocol guard coverage for fileChanges lives in webview/src/lib/protocol.test.ts
 * (T03); this flow stays in the extension host test graph and does not import
 * webview modules (avoids cross-package transform failures).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent, RunOptions } from '../types';
import { TaskEngine } from '../task/engine';
import { SqliteTaskRepository } from '../task/repository';
import { DbClient } from '../task/sqlite/client';
import type { MusterTask, PersistedToolCall } from '../task/types';
import { makeFakeAcpClient, runTurn, type FakeAcpHarness } from './acp-test-harness.testkit';

const H = vi.hoisted(() => ({ current: null as FakeAcpHarness | null }));

vi.mock('./acp-client', () => ({
  getSharedAcpClient: () => H.current?.client,
  disposeSharedAcpClient: () => {},
}));

import { ClaudeBackend } from './claude';

const WORKER_TS = path.join(__dirname, '../task/sqlite/worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const tempDirs: string[] = [];
const clients: DbClient[] = [];

afterEach(async () => {
  H.current = null;
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function options(over: Partial<RunOptions> = {}): RunOptions {
  return { input: { kind: 'agent', prompt: 'edit the file' }, ...over };
}

function task(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'released',
    goal: id,
    parentId: null,
    prerequisites: [],
    backend: 'claude',
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

async function openRepo(label: string): Promise<SqliteTaskRepository> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-m020-s01-flow-${label}-`));
  tempDirs.push(dir);
  const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
  clients.push(client);
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'ws');
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: `m020-s01-flow-${label}`,
    displayName: 'M020 S01 flow',
    createdAt: 'now',
    lastOpenedAt: 'now',
  });
  return repository;
}

function toolByCallId(tools: readonly PersistedToolCall[], toolCallId: string): PersistedToolCall {
  const match = tools.find((tool) => tool.toolCallId === toolCallId);
  if (!match) throw new Error(`missing tool call ${toolCallId}`);
  return match;
}

/**
 * Host projection rule mirrored from src/host/snapshot.ts + workspace-patch.ts:
 * omit fileChanges when absent or empty so content-only tools stay free of chrome.
 */
function projectHostToolContent(tool: PersistedToolCall) {
  return {
    name: tool.name,
    toolKind: tool.kind,
    status: tool.status,
    ...(tool.input !== undefined ? { input: tool.input } : {}),
    ...(tool.output !== undefined ? { output: tool.output } : {}),
    ...(tool.error !== undefined ? { error: tool.error } : {}),
    ...(tool.fileChanges !== undefined && tool.fileChanges.length > 0
      ? { fileChanges: tool.fileChanges }
      : {}),
  };
}

/**
 * Drive real ClaudeBackend (runAcpTurn) with scripted ACP updates, then replay
 * the normalized events through TaskEngine into SQLite — the production path
 * without a live agent process.
 */
async function driveAcpThroughEngine(
  repository: SqliteTaskRepository,
  taskId: string,
  turnId: string,
  updates: unknown[],
): Promise<{ events: NormalizedEvent[]; tools: PersistedToolCall[] }> {
  const fake = makeFakeAcpClient();
  H.current = fake;

  const events = await runTurn(new ClaudeBackend(), options(), fake, { updates });

  const engine = await TaskEngine.loadAsync({
    workspaceId: 'ws',
    repository,
    makeBackend: () => new ClaudeBackend(),
    // Replay adapter events so persistence uses the real engine path without
    // a second live ACP prompt loop (already exercised above).
    runTurn: async function* () {
      for (const event of events) {
        if (
          event.type === 'toolStarted' ||
          event.type === 'toolUpdated' ||
          event.type === 'toolCompleted' ||
          event.type === 'turnCompleted' ||
          event.type === 'error'
        ) {
          yield event;
        }
      }
      if (!events.some((e) => e.type === 'turnCompleted' || e.type === 'error')) {
        yield { type: 'turnCompleted' };
      }
    },
    clock: () => '2026-07-16T00:00:02.000Z',
  });

  await engine.resumeQueuedTurnAsync(taskId, turnId);
  await engine.whenIdle().catch(() => undefined);

  const tools = await repository.listToolCalls(taskId);
  return { events, tools };
}

let fake: FakeAcpHarness;

beforeEach(() => {
  fake = makeFakeAcpClient();
  H.current = fake;
});

describe('M020 S01 named diff-evidence flow', () => {
  it('carries one ACP diff from wire through engine persistence and host projection; content-only stays clean', async () => {
    // ── Phase 1: single-file Edit with diff evidence ─────────────────────────
    const repository = await openRepo('diff');
    const t = await seedTurn(repository, 'flow-edit-task', 'flow-edit-turn');

    const expectedChanges = [
      {
        path: 'src/hello.ts',
        oldText: 'const x = 1;\n',
        newText: 'const x = 2;\n',
      },
    ];

    const { events, tools } = await driveAcpThroughEngine(repository, t.id, 'flow-edit-turn', [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-1',
        title: 'Edit',
        rawInput: { path: 'src/hello.ts' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'edited' } },
          {
            type: 'diff',
            path: 'src/hello.ts',
            oldText: 'const x = 1;\n',
            newText: 'const x = 2;\n',
          },
        ],
      },
    ]);

    // Adapter surface: structured evidence on toolCompleted.
    const completed = events.find((e) => e.type === 'toolCompleted') as Extract<
      NormalizedEvent,
      { type: 'toolCompleted' }
    >;
    expect(completed).toBeDefined();
    expect(completed.toolCallId).toBe('claude:edit-1');
    expect(completed.outcome).toBe('success');
    expect(completed.output).toBe('edited');
    expect(completed.fileChanges).toEqual(expectedChanges);

    // Persistence surface: tool_calls.payload_json remainder (no schema change).
    const tool = toolByCallId(tools, 'claude:edit-1');
    expect(tool.status).toBe('success');
    expect(tool.output).toBe('edited');
    expect(tool.fileChanges).toEqual(expectedChanges);

    // Host projection shape that ToolCard/protocol consume.
    const projected = projectHostToolContent(tool);
    expect(projected.fileChanges).toEqual(expectedChanges);
    expect(projected.name).toBe(tool.name);
    expect(projected.status).toBe('success');

    // Wire-safe JSON round-trip of projected content (host → webview postMessage).
    const reparsed = JSON.parse(JSON.stringify(projected));
    expect(reparsed.fileChanges).toEqual(expectedChanges);
    expect(reparsed.fileChanges[0].oldText).toBe('const x = 1;\n');
    expect(reparsed.fileChanges[0].newText).toBe('const x = 2;\n');

    // ── Phase 2: content-only Read must omit fileChanges end-to-end ──────────
    const repo2 = await openRepo('content-only');
    const t2 = await seedTurn(repo2, 'flow-read-task', 'flow-read-turn');

    const plain = await driveAcpThroughEngine(repo2, t2.id, 'flow-read-turn', [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read',
        rawInput: { path: 'src/a.ts' },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
      },
    ]);

    const plainDone = plain.events.find((e) => e.type === 'toolCompleted') as Extract<
      NormalizedEvent,
      { type: 'toolCompleted' }
    >;
    expect(plainDone).toBeDefined();
    expect(plainDone).not.toHaveProperty('fileChanges');
    expect(plainDone.output).toBe('file body');

    const plainTool = toolByCallId(plain.tools, 'claude:read-1');
    expect(plainTool.status).toBe('success');
    expect(plainTool.output).toBe('file body');
    expect(plainTool.fileChanges).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(plainTool, 'fileChanges')).toBe(false);

    const plainProjected = projectHostToolContent(plainTool);
    expect(Object.prototype.hasOwnProperty.call(plainProjected, 'fileChanges')).toBe(false);
    expect(plainProjected.output).toBe('file body');
  }, 60_000);

  it('degrades malformed ACP content to rawOutput without inventing fileChanges', async () => {
    // Negative: wire-format drift stays diagnosable (no silent swallow of evidence path).
    const repository = await openRepo('malformed');
    const t = await seedTurn(repository, 'flow-bad-task', 'flow-bad-turn');

    const { events, tools } = await driveAcpThroughEngine(repository, t.id, 'flow-bad-turn', [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'edit-bad',
        title: 'Edit',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-bad',
        status: 'completed',
        rawOutput: 'fallback-body',
        content: [
          { type: 'diff', path: 'x.ts' }, // missing newText → malformed
          { type: 'unknown' },
        ],
      },
    ]);

    const done = events.find((e) => e.type === 'toolCompleted') as Extract<
      NormalizedEvent,
      { type: 'toolCompleted' }
    >;
    expect(done).toBeDefined();
    expect(done.output).toBe('fallback-body');
    expect(done).not.toHaveProperty('fileChanges');

    const tool = toolByCallId(tools, 'claude:edit-bad');
    expect(tool.output).toBe('fallback-body');
    expect(tool.fileChanges).toBeUndefined();
  }, 60_000);
});
