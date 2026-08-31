import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteTaskRepository, type TaskRepository } from './repository';
import { compileTaskPrompt, synthesizeBriefFromGoal } from './brief';
import { stageDispositionForSettlement } from './m018-test-helpers';
import type { MusterTask, OperationLedgerEntry, TaskTurn, TurnDisposition } from './types';
import { DbClient } from './sqlite/client';
import { DEFAULT_WORKFLOW_POLICY } from './workflow-codec';
import {
  makeGraphFanInDefinition,
  makeOneNodeDefinition,
  validateDefineWorkflow,
  type WorkflowPolicy,
} from './workflow';

function makeTask(id: string): MusterTask {
  return {
    id,
    role: 'worker',
    lifecycle: 'open',
    releaseState: 'draft',
    goal: id,
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type RetryWorkflowFixture = {
  definitionId: string;
  runId: string;
  entryTaskId: string;
  activationTurnId: string;
};

async function defineAndStartRetryWorkflow(
  repository: SqliteTaskRepository,
  suffix: string,
  createdAt: string,
  policy: WorkflowPolicy = DEFAULT_WORKFLOW_POLICY,
): Promise<RetryWorkflowFixture> {
  const definitionId = `wf-retry-${suffix}`;
  const definition = makeOneNodeDefinition({
    definitionId,
    name: `retry ${suffix}`,
    createdAt,
    policy,
  });
  await expect(repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    name: definition.name,
    topology: definition.topology,
    entryContracts: definition.entryContracts,
    policy: definition.policy,
    createdAt,
  })).resolves.toMatchObject({ ok: true, changed: true });
  const started = await repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: 'ws',
    definitionId,
    version: 1,
    startIdempotencyKey: `retry-${suffix}`,
    createdAt,
    goal: `retry ${suffix}`,
    backend: 'grok',
  });
  expect(started).toMatchObject({ ok: true, changed: true });
  return {
    definitionId,
    ...(started.operation?.result?.data as Omit<RetryWorkflowFixture, 'definitionId'>),
  };
}

async function claimWorkflowRetrySource(
  repository: SqliteTaskRepository,
  fixture: RetryWorkflowFixture,
  startedAt: string,
): Promise<void> {
  await expect(repository.execute({
    kind: 'claimTurn',
    workspaceId: 'ws',
    turnId: fixture.activationTurnId,
    startedAt,
    rootTaskId: fixture.entryTaskId,
    maxConcurrentTurns: 10,
    maxConcurrentPerRoot: 10,
    maxConcurrentPerBackend: 10,
    resourceKeys: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
}

function workflowRetryTurn(
  source: TaskTurn,
  turnId: string,
  createdAt: string,
  reuseOriginalInputs: boolean,
): TaskTurn {
  return {
    id: turnId,
    taskId: source.taskId,
    sequence: source.sequence + 1,
    trigger: 'retry',
    status: 'queued',
    retryOf: source.id,
    inputs: reuseOriginalInputs
      ? [...source.inputs]
      : [{ kind: 'recovery', interruptedTurnId: source.id, instruction: 'Retry the same workflow activation.' }],
    executionEpoch: source.executionEpoch ?? 1,
    runtimeEpoch: source.runtimeEpoch ?? 1,
    ...(source.workflowInstructions !== undefined
      ? { workflowInstructions: source.workflowInstructions }
      : {}),
    createdAt,
  };
}

async function settleWorkflowSourceFailure(
  repository: SqliteTaskRepository,
  fixture: RetryWorkflowFixture,
  finishedAt: string,
  retry?: TaskTurn,
) {
  const task = await repository.getTask(fixture.entryTaskId);
  const source = await repository.getTurn(fixture.activationTurnId);
  expect(task).toBeTruthy();
  expect(source).toBeTruthy();
  return repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, revision: task!.revision + 1, updatedAt: finishedAt },
    turn: {
      ...source!,
      status: 'failed',
      failureClass: 'safe_to_retry',
      dispatchPhase: 'terminal_received',
      error: 'safe pre-dispatch failure',
      finishedAt,
    },
    expectedStatuses: ['running'],
    relatedTurns: retry ? [retry] : [],
    messages: [],
  });
}

async function routeWorkflowRetry(
  repository: SqliteTaskRepository,
  fixture: RetryWorkflowFixture,
  retryTurnId: string,
  startedAt: string,
  finishedAt: string,
): Promise<void> {
  await expect(repository.execute({
    kind: 'claimTurn',
    workspaceId: 'ws',
    turnId: retryTurnId,
    startedAt,
    rootTaskId: fixture.entryTaskId,
    maxConcurrentTurns: 10,
    maxConcurrentPerRoot: 10,
    maxConcurrentPerBackend: 10,
    resourceKeys: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
  const task = await repository.getTask(fixture.entryTaskId);
  const retry = await repository.getTurn(retryTurnId);
  expect(task).toBeTruthy();
  expect(retry).toBeTruthy();
  const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result: 'retry succeeded' };
  await stageDispositionForSettlement(repository, retry!, disposition);
  await expect(repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, revision: task!.revision + 1, updatedAt: finishedAt },
    turn: { ...retry!, status: 'succeeded', disposition, finishedAt },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
}

function canonicalStorageFixture(definitionId = 'wf-canonical-storage') {
  const fileInstructions = 'Use the frozen package instructions, not the display title.';
  const inlineInstructions = 'Publish the right branch result.';
  const topology = {
    kind: 'workflow',
    description: 'Two ordered public inputs and two ordered public outputs.',
    inputs: [
      { name: 'rightRequest', semanticKind: 'request.right', entryNodeId: 'right', inputRef: 'right_request' },
      { name: 'leftRequest', semanticKind: 'request.left', entryNodeId: 'left', inputRef: 'left_request' },
    ],
    outputs: [
      { name: 'publishedResult', semanticKind: 'result.published', terminalNodeId: 'publish' },
      { name: 'checkedResult', semanticKind: 'result.checked', terminalNodeId: 'check' },
    ],
    nodes: [
      {
        nodeId: 'right',
        title: 'Right display title',
        role: 'worker',
        taskType: 'publisher',
        backend: 'grok',
        model: 'gpt-5',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: false,
          next: { when: 'The right branch result is ready.' },
        },
      },
      {
        nodeId: 'left',
        title: 'Left display title',
        instructions: {
          kind: 'file',
          file: 'prompts/left.md',
          content: fileInstructions,
          sha256: sha256(fileInstructions),
        },
        role: 'worker',
        taskType: 'planner',
        backend: 'grok',
        model: 'gpt-5',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The left branch result is ready.' },
          fail: { when: 'The left branch cannot produce a result.' },
        },
      },
      {
        nodeId: 'publish',
        title: 'Publish display title',
        instructions: {
          kind: 'inline',
          content: inlineInstructions,
          sha256: sha256(inlineInstructions),
        },
        role: 'worker',
        taskType: 'publisher',
        backend: 'grok',
        model: 'gpt-5',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'Publication is complete.' },
        },
      },
      {
        nodeId: 'check',
        title: 'Check display title',
        backend: 'script',
        execution: {
          kind: 'script',
          interpreter: 'node',
          file: 'scripts/check.js',
          args: ['--strict', 'left'],
          source: {
            kind: 'predefined',
            scope: 'workspace',
            packageKind: 'bundle',
            catalogRootKind: 'canonical',
            packagePath: 'canonical-storage',
            entryFile: 'workflow.json',
            workflowRef: 'pwf_0123456789abcdef0123456789abcdef',
            packageSha256: 'a'.repeat(64),
            scriptSha256: 'b'.repeat(64),
          },
        },
        outcome: {
          kind: 'exit',
          next: { when: { exitCode: 0 } },
          prev: {
            when: { exitCode: 'nonzero' },
            targets: ['left_result'],
            feedback: 'stdout',
          },
        },
      },
    ],
    edges: [
      {
        fromNodeId: 'right',
        toNodeId: 'publish',
        inputRef: 'right_result',
        expectedArtifactKind: 'next_result',
      },
      {
        fromNodeId: 'left',
        toNodeId: 'check',
        inputRef: 'left_result',
        expectedArtifactKind: 'next_result',
      },
    ],
  } as const;
  return {
    definitionId,
    version: 1,
    name: 'Canonical storage workflow',
    topology,
    entryContracts: topology.inputs.map((input) => ({
      entryNodeId: input.entryNodeId,
      inputRef: input.inputRef,
      expectedArtifactKind: 'workflow_input',
    })),
    createdAt: '2026-08-31T00:00:00.000Z',
  };
}

async function settleWorkflowTurnSucceeded(
  repository: SqliteTaskRepository,
  client: DbClient,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
  finishedAt: string,
) {
  await client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    [finishedAt, 'ws', turnId],
  );
  const task = await repository.getTask(taskId);
  const turn = await repository.getTurn(turnId);
  expect(task).toBeDefined();
  expect(turn).toBeDefined();
  await stageDispositionForSettlement(repository, turn!, disposition);
  return repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: 'ws',
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: finishedAt },
    turn: {
      ...turn!,
      status: 'succeeded',
      finishedAt,
      disposition,
    },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

describe('SqliteTaskRepository', () => {
  it('does not let an older backend verification overwrite a newer observation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-global-verification-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.setGlobalBackendVerification(
        'opencode',
        true,
        '2.0.0',
        '2026-08-20T10:00:00.000Z',
      );
      await repository.setGlobalBackendVerification(
        'opencode',
        false,
        '1.0.0',
        '2026-08-20T09:00:00.000Z',
      );
      await expect(repository.getGlobalBackendVerification('opencode')).resolves.toEqual({
        verified: true,
        version: '2.0.0',
        checkedAt: '2026-08-20T10:00:00.000Z',
      });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies graph create atomically with operation replay/conflict parity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-graph-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'graph-identity', 'Graph', 'now', 'now'],
      );
      for (const repository of [new SqliteTaskRepository(client, 'ws')]) {
        const root = makeTask(`graph-root-${Math.random()}`);
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
        const child = { ...makeTask(`${root.id}-child`), parentId: root.id, revision: 0 };
        const message = {
          id: `${child.id}-message`, taskId: child.id, role: 'user' as const,
          content: 'run', state: 'assigned' as const, turnId: `${child.id}-turn`,
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        const turn = {
          id: `${child.id}-turn`, taskId: child.id, sequence: 1, status: 'queued' as const,
          trigger: 'engine' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        const operation = { ledgerKey: `${root.id}:graph-op`, entry: {
          fingerprint: 'graph-fingerprint', result: { ok: true, data: { taskId: child.id, turnId: turn.id } },
        }, createdAt: '2026-07-16T00:00:01.000Z' };
        const command = {
          kind: 'createChildTask' as const, workspaceId: 'ws', expectedTasks: [{ id: root.id, revision: root.revision }],
          insertTaskIds: [child.id], tasks: [child], insertTurnIds: [turn.id], turns: [turn],
          insertMessageIds: [message.id], messages: [message], operation,
        };
        await expect(repository.execute(command)).resolves.toMatchObject({ changed: true, operation: operation.entry });
        await expect(repository.getTask(child.id)).resolves.toMatchObject({ parentId: root.id });
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ taskId: child.id });
        await expect(repository.execute(command)).resolves.toMatchObject({ changed: false, operation: operation.entry });
        await expect(repository.execute({ ...command, operation: { ...operation, entry: { ...operation.entry, fingerprint: 'different' } } })).resolves.toMatchObject({ conflict: true });
        const badChild = { ...makeTask(`${root.id}-bad`), parentId: root.id, prerequisites: [{ producerTaskId: 'missing', requiredLifecycle: 'succeeded' as const, onUnmet: 'fail' as const }] };
        await expect(repository.execute({ ...command, operation: { ...operation, ledgerKey: `${root.id}:bad`, entry: { ...operation.entry, fingerprint: 'bad' } }, insertTaskIds: [badChild.id], tasks: [badChild], insertTurnIds: [], turns: [], insertMessageIds: [], messages: [] })).resolves.toMatchObject({ changed: false });
        await expect(repository.getTask(badChild.id)).resolves.toBeUndefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('consumes a cancel request with owner/request fences and releases all claims', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-cancel-consumer-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(`INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`, ['ws', 'cancel-consumer', 'Cancel', 'now', 'now']);
      const repositories = [new SqliteTaskRepository(client, 'ws')];
      for (const repository of repositories) {
        const task = { ...makeTask(`cancel-task-${Math.random()}`), releaseState: 'released' as const };
        const turn = { id: `${task.id}-turn`, taskId: task.id, sequence: 1, status: 'running' as const, trigger: 'engine' as const, inputs: [], createdAt: '2026-07-16T00:00:01.000Z' };
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({ kind: 'claimRuntime', workspaceId: 'ws', turnId: turn.id, ownerId: 'owner', claimedAt: '2026-07-16T00:00:01.000Z', heartbeatAt: '2026-07-16T00:00:01.000Z', expiresAt: '2099-01-01T00:00:00.000Z' });
        const request = { kind: 'cancel' as const, by: 'user', opId: 'cancel-op', at: '2026-07-16T00:00:02.000Z' };
        await repository.execute({ kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id, request });
        await client.run(`INSERT INTO session_claims (workspace_id, session_id, turn_id, claimed_at) VALUES (?,?,?,?)`, ['ws', `${turn.id}-session`, turn.id, 'now']);
        await client.run(`INSERT INTO resource_claims (workspace_id, resource_key, task_id, turn_id, claimed_at) VALUES (?,?,?,?,?)`, ['ws', 'git', task.id, turn.id, 'now']);
        const nextTurn = { ...turn, status: 'cancelled' as const, finishedAt: '2026-07-16T00:00:03.000Z' };
        const consume = {
          kind: 'consumeCancelRequest', workspaceId: 'ws', expectedTasks: [{ id: task.id, revision: task.revision }],
          expectedTurns: [{ id: turn.id, status: 'running' }], expectedRuntimeClaims: [{ turnId: turn.id, ownerId: 'owner' }],
          expectedCancelRequests: [{ turnId: turn.id, kind: 'cancel', opId: request.opId }],
          tasks: [], turns: [nextTurn], messages: [], deleteOperationKeys: [],
          deleteCancelRequestTurnIds: [turn.id], deleteRuntimeClaimTurnIds: [turn.id],
          deleteSessionClaimTurnIds: [turn.id], deleteResourceClaimTurnIds: [turn.id],
        } as const;
        await expect(repository.execute({
          ...consume,
          expectedTurns: [{ id: turn.id, status: 'waiting_user' as const }],
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.getCancelRequest(turn.id)).resolves.toEqual(request);
        await expect(repository.getRuntimeClaim(turn.id)).resolves.toMatchObject({ ownerId: 'owner' });
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ status: 'running' });

        await expect(repository.execute(consume)).resolves.toMatchObject({ changed: true });
        await expect(repository.getCancelRequest(turn.id)).resolves.toBeUndefined();
        await expect(repository.getRuntimeClaim(turn.id)).resolves.toBeUndefined();
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ status: 'cancelled' });
        await expect(client.get(`SELECT 1 AS present FROM session_claims WHERE workspace_id=? AND turn_id=?`, ['ws', turn.id])).resolves.toBeUndefined();
        await expect(client.get(`SELECT 1 AS present FROM resource_claims WHERE workspace_id=? AND turn_id=?`, ['ws', turn.id])).resolves.toBeUndefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps host history commands atomic in SQLite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-history-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repositories: TaskRepository[] = [new SqliteTaskRepository(client, 'ws')];
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'history-identity', 'History', 'now', 'now'],
      );
      for (const [index, repository] of repositories.entries()) {
        const root = makeTask(`history-root-${index}`);
        const child = makeTask(`history-child-${index}`);
        child.parentId = root.id;
        const active = makeTask(`history-active-${index}`);
        const queued = makeTask(`history-queued-${index}`);
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: active });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: queued });
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: { id: `active-turn-${index}`, taskId: active.id, sequence: 1, status: 'running', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z' },
        });
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: { id: `queued-turn-${index}`, taskId: queued.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:02.000Z' },
        });

        await expect(repository.execute({
          kind: 'renameTask', workspaceId: 'ws', taskId: root.id, goal: 'renamed',
          expectedTaskRevision: 0, updatedAt: '2026-07-16T00:00:03.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(root.id)).resolves.toMatchObject({ goal: 'renamed', revision: 1 });
        await expect(repository.execute({
          kind: 'renameTask', workspaceId: 'ws', taskId: root.id, goal: 'stale',
          expectedTaskRevision: 0, updatedAt: '2026-07-16T00:00:04.000Z',
        })).resolves.toMatchObject({ changed: false });
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: {
            id: `waiting-child-turn-${index}`, taskId: child.id, sequence: 1,
            status: 'waiting_user', trigger: 'user', inputs: [],
            createdAt: '2026-07-16T00:00:04.500Z',
          },
        });
        await expect(repository.execute({
          kind: 'deleteTaskSubtree', workspaceId: 'ws', rootTaskId: child.id,
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(root.id)).resolves.toBeDefined();
        await expect(repository.getTask(child.id)).resolves.toBeUndefined();

        const queuedTask = makeTask(`history-queue-command-${index}`);
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: queuedTask });
        await expect(repository.execute({
          kind: 'queueTaskTurn', workspaceId: 'ws', expectedTaskRevision: queuedTask.revision,
          maxTurnsPerTask: 10, task: queuedTask,
          turn: {
            id: `history-queue-turn-${index}`, taskId: queuedTask.id, sequence: 1,
            status: 'queued', trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:02.500Z',
          },
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.listTurns(queuedTask.id)).resolves.toMatchObject([
          { id: `history-queue-turn-${index}`, status: 'queued' },
        ]);

        await expect(repository.execute({
          kind: 'deleteTaskSubtree', workspaceId: 'ws', rootTaskId: queued.id,
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(queued.id)).resolves.toBeUndefined();

        await expect(repository.execute({
          kind: 'clearHistory', workspaceId: 'ws', preserveRootTaskId: active.id,
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(root.id)).resolves.toBeUndefined();
        await expect(repository.getTask(child.id)).resolves.toBeUndefined();
        await expect(repository.getTask(active.id)).resolves.toBeDefined();
        await expect(repository.getTask(queuedTask.id)).resolves.toBeDefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('deletes an active workflow task and its artifact source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-delete-workflow-task-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'delete-workflow-task', 'Delete workflow task', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-delete-failed',
        version: 1,
        name: 'delete failed workflow task',
        topology: makeOneNodeDefinition({
          definitionId: 'wf-delete-failed',
          name: 'delete failed workflow task',
          createdAt: '2026-07-16T00:00:00.000Z',
        }).topology,
        createdAt: '2026-07-16T00:00:00.000Z',
      });
      const started = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-delete-failed',
        version: 1,
        startIdempotencyKey: 'delete-failed',
        createdAt: '2026-07-16T00:00:01.000Z',
        goal: 'failed workflow task',
        backend: 'grok',
      });
      const payload = started.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        ['2026-07-16T00:00:02.000Z', 'ws', payload.activationTurnId],
      );
      const activation = await client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ? AND execution_turn_id = ?`,
        ['ws', payload.runId, payload.activationTurnId],
      );
      await expect(client.run(
        `INSERT INTO workflow_artifacts (
           workspace_id, run_id, artifact_id, producer_node_id, logical_name,
           revision, kind, payload_json, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
        ['ws', payload.runId, 'delete-source-artifact', 'entry', 'result', 1, 'text', '{}', '2026-07-16T00:00:02.000Z'],
      )).resolves.toMatchObject({ changes: 1 });
      await expect(client.run(
        `INSERT INTO workflow_artifact_sources (
           workspace_id, run_id, artifact_id, artifact_revision, source_kind,
           producer_run_id, producer_node_id, producer_task_id, producing_turn_id,
           producing_activation_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          'ws', payload.runId, 'delete-source-artifact', 1, 'workflow_node',
          payload.runId, 'entry', payload.entryTaskId, payload.activationTurnId,
          activation!.activation_id,
        ],
      )).resolves.toMatchObject({ changes: 1 });

      await expect(repository.execute({
        kind: 'deleteTaskSubtree',
        workspaceId: 'ws',
        rootTaskId: payload.entryTaskId,
      })).resolves.toMatchObject({ ok: true, changed: true });
      await expect(repository.getTask(payload.entryTaskId)).resolves.toBeUndefined();
      await expect(client.get(
        `SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
        ['ws', payload.runId],
      )).resolves.toEqual({ task_id: null });
      await expect(client.get(
        `SELECT 1 AS present FROM workflow_artifact_sources
          WHERE workspace_id = ? AND run_id = ? AND artifact_id = ?`,
        ['ws', payload.runId, 'delete-source-artifact'],
      )).resolves.toBeUndefined();
      await expect(client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs the named-command and transcript-page contract on SQLite', async () => {
    const task = makeTask('contract-task');
    task.releaseState = 'released';
    const turn = {
      id: 'contract-turn', taskId: task.id, sequence: 1, status: 'queued' as const,
      trigger: 'user' as const, inputs: [{ kind: 'message' as const, messageId: 'contract-user' }],
      createdAt: '2026-07-16T00:00:01.000Z',
    };
    const userMessage = {
      id: 'contract-user', taskId: task.id, role: 'user' as const, content: 'hello',
      state: 'complete' as const, createdAt: '2026-07-16T00:00:02.000Z',
    };
    const assistantMessage = {
      id: 'contract-assistant', taskId: task.id, turnId: turn.id, role: 'assistant' as const,
      content: 'world', state: 'complete' as const, createdAt: '2026-07-16T00:00:03.000Z', order: 0,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-contract-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'contract-identity', 'Contract', 'now', 'now'],
      );
      const sqlite = new SqliteTaskRepository(client, 'ws');
      for (const repository of [sqlite]) {
        await expect(repository.execute({
          kind: 'createRootAndInitialTurn', workspaceId: 'ws', task, message: userMessage, turn,
          receipt: {
            clientRequestId: 'contract-initial-send', fingerprint: 'initial-send', taskId: task.id,
            messageId: userMessage.id, turnId: turn.id, createdAt: '2026-07-16T00:00:02.000Z',
          },
        })).resolves.toMatchObject({ ok: true, changed: true });
        await repository.execute({ kind: 'appendMessage', workspaceId: 'ws', message: assistantMessage });
        await expect(repository.execute({
          kind: 'prepareDispatch', workspaceId: 'ws', expectedTaskRevision: task.revision,
          task,
          turn: {
            ...turn,
            status: 'running',
            startedAt: '2026-07-16T00:00:02.500Z',
            dispatchPhase: 'pre_dispatch',
          },
          messages: [],
          startedAt: '2026-07-16T00:00:02.500Z',
          rootTaskId: task.id,
          maxConcurrentTurns: 10,
          maxConcurrentPerRoot: 10,
          maxConcurrentPerBackend: 10,
          resourceKeys: [],
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.execute({
          kind: 'settleTurnAndApplyEffects', workspaceId: 'ws', expectedTaskRevision: task.revision,
          task,
          turn: {
            ...turn,
            status: 'succeeded',
            startedAt: '2026-07-16T00:00:02.500Z',
            finishedAt: '2026-07-16T00:00:04.000Z',
            dispatchPhase: 'terminal_received',
          },
          expectedStatuses: ['running'],
          relatedTurns: [],
          messages: [],
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.getTask(task.id)).resolves.toMatchObject({ id: task.id, goal: task.goal });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([{
          id: turn.id, status: 'succeeded', startedAt: '2026-07-16T00:00:02.500Z',
          finishedAt: '2026-07-16T00:00:04.000Z',
        }]);
        await expect(repository.listMessages(task.id)).resolves.toHaveLength(2);
        const latest = await repository.getTranscriptPage(task.id, undefined, 1);
        expect(latest.items.map((item) => item.id)).toEqual(['contract-assistant']);
        expect(latest.hasMoreBefore).toBe(true);
        const older = await repository.getTranscriptPage(task.id, latest.beforeCursor, 1);
        expect(older.items.map((item) => item.id)).toEqual(['contract-user']);
        expect(older.hasMoreBefore).toBe(false);

        const operation: OperationLedgerEntry = {
          fingerprint: 'contract-operation', result: { ok: true, data: { turnId: turn.id } },
        };
        await expect(repository.execute({
          kind: 'claimOperation', workspaceId: 'ws', ledgerKey: `${turn.id}:operation`, entry: operation,
          createdAt: '2026-07-16T00:00:05.000Z',
        })).resolves.toMatchObject({ changed: true, operation });
        await expect(repository.execute({
          kind: 'claimOperation', workspaceId: 'ws', ledgerKey: `${turn.id}:operation`, entry: operation,
          createdAt: '2026-07-16T00:00:06.000Z',
        })).resolves.toMatchObject({ changed: false, operation });
        await repository.execute({
          kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
          toolCalls: [{
            id: `${turn.id}:tool`, taskId: task.id, turnId: turn.id, toolCallId: 'tool', order: 1,
            name: 'tool', status: 'success', output: 'done',
            createdAt: '2026-07-16T00:00:05.000Z', updatedAt: '2026-07-16T00:00:05.000Z',
          }],
          reasoning: [{
            id: `${turn.id}:reasoning`, taskId: task.id, turnId: turn.id, order: 2, content: 'think',
            createdAt: '2026-07-16T00:00:05.000Z', updatedAt: '2026-07-16T00:00:05.000Z',
          }],
        });
        await repository.execute({
          kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id,
          request: { kind: 'interrupt', by: 'user', opId: 'cancel', at: '2026-07-16T00:00:05.000Z' },
        });
        await repository.execute({
          kind: 'putSendReceipt', workspaceId: 'ws',
          receipt: { clientRequestId: `${turn.id}:send`, fingerprint: 'send', taskId: task.id, messageId: userMessage.id, turnId: turn.id, createdAt: '2026-07-16T00:00:05.000Z' },
        });
        await expect(repository.listToolCalls(task.id)).resolves.toMatchObject([{ id: `${turn.id}:tool` }]);
        await expect(repository.listReasoning(task.id)).resolves.toMatchObject([{ id: `${turn.id}:reasoning` }]);
        await expect(repository.getOperation(`${turn.id}:operation`)).resolves.toEqual(operation);
        await expect(repository.getCancelRequest(turn.id)).resolves.toMatchObject({ opId: 'cancel' });
        await expect(repository.getSendReceipt('contract-initial-send')).resolves.toMatchObject({
          taskId: task.id, messageId: userMessage.id, turnId: turn.id,
        });
        await expect(repository.getSendReceipt(`${turn.id}:send`)).resolves.toMatchObject({ turnId: turn.id });
        await expect(repository.execute({ kind: 'applyRetentionPolicy', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 })).resolves.toMatchObject({ changed: false });
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('atomically enqueues a message turn with revision and turn-cap guards', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-enqueue-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'enqueue-identity', 'Enqueue', 'now', 'now'],
      );
      const repositories = [new SqliteTaskRepository(client, 'ws')];
      for (const [index, repository] of repositories.entries()) {
        const task = makeTask(`enqueue-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const message = {
          id: `enqueue-message-${index}`, taskId: task.id, role: 'user' as const,
          content: 'follow up', state: 'pending' as const, createdAt: '2026-07-16T00:00:01.000Z',
        };
        const turn = {
          id: `enqueue-turn-${index}`, taskId: task.id, sequence: 1, trigger: 'user' as const,
          status: 'queued' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        await expect(repository.execute({
          kind: 'enqueueMessageTurn', workspaceId: 'ws', expectedTaskRevision: task.revision,
          maxTurnsPerTask: 10, task, message, turn,
          receipt: {
            clientRequestId: `enqueue-receipt-${index}`, fingerprint: 'enqueue', taskId: task.id,
            messageId: message.id, turnId: turn.id, createdAt: turn.createdAt,
          },
        })).resolves.toMatchObject({ ok: true, changed: true });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([{ id: turn.id }]);
        await expect(repository.listMessages(task.id)).resolves.toMatchObject([{ id: message.id }]);
        await expect(repository.getSendReceipt(`enqueue-receipt-${index}`)).resolves.toMatchObject({
          turnId: turn.id,
        });

        const staleMessage = { ...message, id: `stale-message-${index}` };
        const staleTurn = {
          ...turn,
          id: `stale-turn-${index}`,
          sequence: 2,
          inputs: [{ kind: 'message' as const, messageId: staleMessage.id }],
        };
        await expect(repository.execute({
          kind: 'enqueueMessageTurn', workspaceId: 'ws', expectedTaskRevision: task.revision + 1,
          maxTurnsPerTask: 10, task, message: staleMessage, turn: staleTurn,
        })).resolves.toMatchObject({ ok: true, changed: false });
        await expect(repository.getTask(task.id)).resolves.toMatchObject({ id: task.id });
        await expect(repository.listMessages(task.id)).resolves.not.toContainEqual(
          expect.objectContaining({ id: staleMessage.id }),
        );
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('claims a concurrent root send receipt before creating an aggregate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-root-receipt-race-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'root-receipt-race', 'Root receipt race', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const command = (suffix: string) => {
        const task = { ...makeTask(`root-race-${suffix}`), releaseState: 'released' as const };
        const message = {
          id: `${task.id}-message`, taskId: task.id, role: 'user' as const,
          content: 'same root send', state: 'pending' as const, createdAt: '2026-07-16T00:00:01.000Z',
        };
        const turn = {
          id: `${task.id}-turn`, taskId: task.id, sequence: 1, status: 'queued' as const,
          trigger: 'user' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        return {
          kind: 'createRootAndInitialTurn' as const,
          workspaceId: 'ws', task, message, turn,
          receipt: {
            clientRequestId: 'same-root-request', fingerprint: 'same-root-payload',
            taskId: task.id, messageId: message.id, turnId: turn.id,
            createdAt: turn.createdAt,
          },
        };
      };

      const results = await Promise.all([
        repository.execute(command('a')),
        repository.execute(command('b')),
      ]);
      expect(results.filter((result) => result.changed === true)).toHaveLength(1);
      expect(results.filter((result) => result.changed === false)).toHaveLength(1);
      expect(results.find((result) => result.changed === false)?.reason).toBe('clientRequestId already claimed');
      const tasks = await repository.listTasks('ws');
      expect(tasks).toHaveLength(1);
      await expect(repository.getSendReceipt('same-root-request')).resolves.toMatchObject({
        fingerprint: 'same-root-payload', taskId: tasks[0]!.id,
      });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('claims a concurrent follow-up receipt across different tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-follow-up-receipt-race-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'follow-up-receipt-race', 'Follow-up receipt race', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const tasks = [
        { ...makeTask('follow-up-race-a'), releaseState: 'released' as const },
        { ...makeTask('follow-up-race-b'), releaseState: 'released' as const },
      ];
      await Promise.all(tasks.map((task) => repository.execute({ kind: 'createTask', workspaceId: 'ws', task })));
      const command = (task: MusterTask, suffix: string) => {
        const message = {
          id: `${task.id}-message`, taskId: task.id, role: 'user' as const,
          content: 'same follow-up send', state: 'pending' as const, createdAt: '2026-07-16T00:00:02.000Z',
        };
        const turn = {
          id: `${task.id}-turn`, taskId: task.id, sequence: 1, status: 'queued' as const,
          trigger: 'user' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:02.000Z',
        };
        return {
          kind: 'enqueueMessageTurn' as const,
          workspaceId: 'ws', expectedTaskRevision: task.revision, maxTurnsPerTask: 10,
          task, message, turn,
          receipt: {
            clientRequestId: 'same-follow-up-request', fingerprint: `same-follow-up-${suffix}`,
            taskId: task.id, messageId: message.id, turnId: turn.id,
            createdAt: turn.createdAt,
          },
        };
      };

      const results = await Promise.all([
        repository.execute(command(tasks[0]!, 'payload')),
        repository.execute(command(tasks[1]!, 'payload')),
      ]);
      expect(results.filter((result) => result.changed === true)).toHaveLength(1);
      expect(results.filter((result) => result.changed === false)).toHaveLength(1);
      expect(results.find((result) => result.changed === false)?.reason).toBe('clientRequestId already claimed');
      const turns = await Promise.all(tasks.map((task) => repository.listTurns(task.id)));
      expect(turns.filter((entries) => entries.length === 1)).toHaveLength(1);
      expect(turns.filter((entries) => entries.length === 0)).toHaveLength(1);
      await expect(repository.getSendReceipt('same-follow-up-request')).resolves.toMatchObject({
        fingerprint: 'same-follow-up-payload',
      });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('edits, deletes, and resumes only queued message turns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-queue-mutations-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'queue-mutations', 'Queue mutations', 'now', 'now'],
      );
      const sqlite = new SqliteTaskRepository(client, 'ws');
      for (const [index, repository] of [sqlite].entries()) {
        const task = makeTask(`queue-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const message = {
          id: `queue-message-${index}`, taskId: task.id, role: 'user' as const, content: 'before',
          agentContent: '/absolute/expanded/path', state: 'pending' as const,
          createdAt: '2026-07-16T00:00:00.000Z',
        };
        const turn = {
          id: `queue-turn-${index}`, taskId: task.id, sequence: 1, trigger: 'user' as const,
          status: 'queued' as const, inputs: [{ kind: 'message' as const, messageId: message.id }],
          createdAt: '2026-07-16T00:00:00.000Z',
        };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({ kind: 'appendMessage', workspaceId: 'ws', message });
        await expect(repository.execute({
          kind: 'editQueuedMessage', workspaceId: 'ws', taskId: task.id, turnId: turn.id, content: 'after',
        })).resolves.toMatchObject({ changed: true, messageId: message.id });
        const editedMessages = await repository.listMessages(task.id);
        expect(editedMessages).toMatchObject([{ id: message.id, content: 'after' }]);
        expect(editedMessages[0]).not.toHaveProperty('agentContent');
        await expect(repository.execute({
          kind: 'deleteQueuedTurnAndMessages', workspaceId: 'ws', taskId: task.id, turnId: turn.id,
        })).resolves.toMatchObject({ changed: true, deletedMessageIds: [message.id] });
        await expect(repository.listTurns(task.id)).resolves.toEqual([]);
        await expect(repository.listMessages(task.id)).resolves.toEqual([]);
        await expect(repository.execute({
          kind: 'editQueuedMessage', workspaceId: 'ws', taskId: task.id, turnId: turn.id, content: 'late',
        })).resolves.toMatchObject({ changed: false });

        const held = {
          id: `queue-held-${index}`, taskId: task.id, sequence: 2, trigger: 'user' as const,
          status: 'queued' as const, holdAutoPromote: true, inputs: [],
          createdAt: '2026-07-16T00:00:01.000Z',
        };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: held });
        await expect(repository.execute({
          kind: 'clearQueuedTurnHold', workspaceId: 'ws', taskId: task.id, turnId: held.id,
        })).resolves.toMatchObject({ changed: true });
        const resumedTurns = await repository.listTurns(task.id);
        expect(resumedTurns).toMatchObject([{ id: held.id }]);
        expect(resumedTurns[0]).not.toHaveProperty('holdAutoPromote');
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('allocates a retry turn atomically with its task state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retry-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'retry-contract', 'Retry contract', 'now', 'now'],
      );
      for (const [index, repository] of [new SqliteTaskRepository(client, 'ws')].entries()) {
        const task = makeTask(`retry-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const oldTurn = {
          id: `retry-old-${index}`, taskId: task.id, sequence: 1, trigger: 'user' as const,
          status: 'failed' as const, inputs: [], createdAt: '2026-07-16T00:00:00.000Z',
          finishedAt: '2026-07-16T00:00:01.000Z',
        };
        const retry = {
          id: `retry-new-${index}`, taskId: task.id, sequence: 2, trigger: 'retry' as const,
          status: 'queued' as const, retryOf: oldTurn.id,
          inputs: [{ kind: 'recovery' as const, interruptedTurnId: oldTurn.id, instruction: 'try again' }],
          createdAt: '2026-07-16T00:00:02.000Z',
        };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: oldTurn });
        await expect(repository.execute({
          kind: 'retryTurn', workspaceId: 'ws', expectedTaskRevision: task.revision,
          maxTurnsPerTask: 10, task, turn: retry,
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([
          { id: oldTurn.id }, { id: retry.id, retryOf: oldTurn.id },
        ]);
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps manual and safe automatic workflow retries activation-owned and routable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-workflow-retry-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      for (const [index, mode] of ['automatic', 'manual'].entries()) {
        const createdAt = `2026-08-31T10:0${index}:00.000Z`;
        const fixture = await defineAndStartRetryWorkflow(repository, mode, createdAt);
        await claimWorkflowRetrySource(repository, fixture, `2026-08-31T10:0${index}:01.000Z`);
        const source = await repository.getTurn(fixture.activationTurnId);
        expect(source).toBeTruthy();
        const retry = workflowRetryTurn(
          source!,
          `${fixture.activationTurnId}-${mode}-retry`,
          `2026-08-31T10:0${index}:03.000Z`,
          mode === 'automatic',
        );

        if (mode === 'automatic') {
          await expect(settleWorkflowSourceFailure(
            repository,
            fixture,
            `2026-08-31T10:0${index}:02.000Z`,
            retry,
          )).resolves.toMatchObject({ ok: true, changed: true });
        } else {
          await expect(settleWorkflowSourceFailure(
            repository,
            fixture,
            `2026-08-31T10:0${index}:02.000Z`,
          )).resolves.toMatchObject({ ok: true, changed: true });
          const task = await repository.getTask(fixture.entryTaskId);
          expect(task).toBeTruthy();
          await expect(repository.execute({
            kind: 'retryTurn',
            workspaceId: 'ws',
            expectedTaskRevision: task!.revision,
            maxTurnsPerTask: 10,
            task: task!,
            turn: retry,
          })).resolves.toMatchObject({ ok: true, changed: true });
        }

        await expect(client.get<{
          status: string;
          execution_turn_id: string;
        }>(
          `SELECT status, execution_turn_id FROM workflow_activations
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', fixture.runId],
        )).resolves.toEqual({ status: 'queued', execution_turn_id: retry.id });
        await expect(client.get<{ workflow_turns_reserved: number }>(
          `SELECT workflow_turns_reserved FROM workflow_runs
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', fixture.runId],
        )).resolves.toEqual({ workflow_turns_reserved: 2 });

        await routeWorkflowRetry(
          repository,
          fixture,
          retry.id,
          `2026-08-31T10:0${index}:04.000Z`,
          `2026-08-31T10:0${index}:05.000Z`,
        );
        await expect(client.get<{ status: string; execution_turn_id: string }>(
          `SELECT status, execution_turn_id FROM workflow_activations
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', fixture.runId],
        )).resolves.toEqual({ status: 'consumed', execution_turn_id: retry.id });
        await expect(client.get<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
          ['ws', fixture.runId],
        )).resolves.toEqual({ status: 'succeeded' });
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('allows original-input workflow retries beside held follow-ups only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-workflow-retry-held-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      for (const [index, reuseOriginalInputs] of [true, false].entries()) {
        const fixture = await defineAndStartRetryWorkflow(
          repository,
          `held-${reuseOriginalInputs ? 'reuse' : 'recovery'}`,
          `2026-08-31T10:1${index}:00.000Z`,
        );
        await claimWorkflowRetrySource(repository, fixture, `2026-08-31T10:1${index}:01.000Z`);
        await expect(settleWorkflowSourceFailure(
          repository,
          fixture,
          `2026-08-31T10:1${index}:02.000Z`,
        )).resolves.toMatchObject({ ok: true, changed: true });
        const source = await repository.getTurn(fixture.activationTurnId);
        const held: TaskTurn = {
          id: `${fixture.activationTurnId}-held`,
          taskId: fixture.entryTaskId,
          sequence: 2,
          trigger: 'user',
          status: 'queued',
          holdAutoPromote: true,
          inputs: [],
          createdAt: `2026-08-31T10:1${index}:03.000Z`,
        };
        await expect(repository.execute({
          kind: 'createTurn',
          workspaceId: 'ws',
          turn: held,
        })).resolves.toMatchObject({ ok: true, changed: true });
        const retry = {
          ...workflowRetryTurn(
            source!,
            `${fixture.activationTurnId}-retry`,
            `2026-08-31T10:1${index}:04.000Z`,
            reuseOriginalInputs,
          ),
          sequence: 3,
        };
        const task = await repository.getTask(fixture.entryTaskId);
        await expect(repository.execute({
          kind: 'retryTurn',
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          maxTurnsPerTask: 10,
          task: task!,
          turn: retry,
          reuseOriginalInputs,
        })).resolves.toMatchObject({ ok: true, changed: reuseOriginalInputs });
        await expect(repository.getTurn(held.id)).resolves.toMatchObject({
          status: 'queued',
          holdAutoPromote: true,
        });
        if (reuseOriginalInputs) {
          await expect(repository.getTurn(retry.id)).resolves.toBeDefined();
        } else {
          await expect(repository.getTurn(retry.id)).resolves.toBeUndefined();
        }
        await expect(client.get<{ status: string; execution_turn_id: string }>(
          `SELECT status, execution_turn_id FROM workflow_activations
            WHERE workspace_id = ? AND run_id = ?`,
          ['ws', fixture.runId],
        )).resolves.toEqual(reuseOriginalInputs
          ? { status: 'queued', execution_turn_id: retry.id }
          : { status: 'failed', execution_turn_id: fixture.activationTurnId });
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('denies manual and automatic workflow retries when canonical authority is corrupt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-workflow-retry-corrupt-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const automatic = await defineAndStartRetryWorkflow(
        repository,
        'corrupt-automatic',
        '2026-08-31T11:00:00.000Z',
      );
      const manual = await defineAndStartRetryWorkflow(
        repository,
        'corrupt-manual',
        '2026-08-31T11:01:00.000Z',
      );
      await claimWorkflowRetrySource(repository, automatic, '2026-08-31T11:02:00.000Z');
      await claimWorkflowRetrySource(repository, manual, '2026-08-31T11:02:00.000Z');
      await expect(settleWorkflowSourceFailure(
        repository,
        manual,
        '2026-08-31T11:03:00.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });

      await client.run('DROP TRIGGER trg_workflow_definition_outputs_immutable_update');
      for (const fixture of [automatic, manual]) {
        await client.run(
          `UPDATE workflow_definition_outputs SET semantic_kind = ?
            WHERE workspace_id = ? AND definition_id = ? AND definition_version = 1`,
          [`corrupt.${fixture.definitionId}`, 'ws', fixture.definitionId],
        );
        await expect(repository.getWorkflowDefinition(fixture.definitionId, 1)).resolves.toBeUndefined();
      }

      const automaticSource = await repository.getTurn(automatic.activationTurnId);
      const automaticRetry = workflowRetryTurn(
        automaticSource!,
        `${automatic.activationTurnId}-retry`,
        '2026-08-31T11:04:00.000Z',
        true,
      );
      await expect(settleWorkflowSourceFailure(
        repository,
        automatic,
        '2026-08-31T11:04:00.000Z',
        automaticRetry,
      )).resolves.toMatchObject({
        ok: true,
        changed: false,
        reason: 'workflow definition is invalid',
      });

      const manualSource = await repository.getTurn(manual.activationTurnId);
      const manualRetry = workflowRetryTurn(
        manualSource!,
        `${manual.activationTurnId}-retry`,
        '2026-08-31T11:04:00.000Z',
        false,
      );
      const manualTask = await repository.getTask(manual.entryTaskId);
      await expect(repository.execute({
        kind: 'retryTurn',
        workspaceId: 'ws',
        expectedTaskRevision: manualTask!.revision,
        maxTurnsPerTask: 10,
        task: manualTask!,
        turn: manualRetry,
      })).resolves.toMatchObject({
        ok: true,
        changed: false,
        reason: 'workflow definition is invalid',
      });

      await expect(repository.getTurn(automaticRetry.id)).resolves.toBeUndefined();
      await expect(repository.getTurn(manualRetry.id)).resolves.toBeUndefined();
      await expect(repository.getTurn(automatic.activationTurnId)).resolves.toMatchObject({ status: 'running' });
      await expect(client.all<{ run_id: string; workflow_turns_reserved: number }>(
        `SELECT run_id, workflow_turns_reserved FROM workflow_runs
          WHERE workspace_id = ? ORDER BY run_id`,
        ['ws'],
      )).resolves.toEqual(expect.arrayContaining([
        { run_id: automatic.runId, workflow_turns_reserved: 1 },
        { run_id: manual.runId, workflow_turns_reserved: 1 },
      ]));
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('never queues workflow retries beyond the per-run turn budget', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-workflow-retry-budget-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const policy = { ...DEFAULT_WORKFLOW_POLICY, maxWorkflowTurnsPerRun: 1 };
      const automatic = await defineAndStartRetryWorkflow(
        repository,
        'budget-automatic',
        '2026-08-31T12:00:00.000Z',
        policy,
      );
      await claimWorkflowRetrySource(repository, automatic, '2026-08-31T12:01:00.000Z');
      const automaticSource = await repository.getTurn(automatic.activationTurnId);
      const automaticRetry = workflowRetryTurn(
        automaticSource!,
        `${automatic.activationTurnId}-retry`,
        '2026-08-31T12:02:00.000Z',
        true,
      );
      await expect(settleWorkflowSourceFailure(
        repository,
        automatic,
        '2026-08-31T12:02:00.000Z',
        automaticRetry,
      )).resolves.toMatchObject({ ok: true, changed: true });
      await expect(repository.getTurn(automaticRetry.id)).resolves.toBeUndefined();
      await expect(client.get<{ status: string; terminal_reason_code: string; workflow_turns_reserved: number }>(
        `SELECT status, terminal_reason_code, workflow_turns_reserved FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', automatic.runId],
      )).resolves.toEqual({
        status: 'failed',
        terminal_reason_code: 'turn_budget_exhausted',
        workflow_turns_reserved: 1,
      });

      const manual = await defineAndStartRetryWorkflow(
        repository,
        'budget-manual',
        '2026-08-31T12:03:00.000Z',
        policy,
      );
      await claimWorkflowRetrySource(repository, manual, '2026-08-31T12:04:00.000Z');
      await expect(settleWorkflowSourceFailure(
        repository,
        manual,
        '2026-08-31T12:05:00.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });
      const manualSource = await repository.getTurn(manual.activationTurnId);
      const manualRetry = workflowRetryTurn(
        manualSource!,
        `${manual.activationTurnId}-retry`,
        '2026-08-31T12:06:00.000Z',
        false,
      );
      const manualTask = await repository.getTask(manual.entryTaskId);
      await expect(repository.execute({
        kind: 'retryTurn',
        workspaceId: 'ws',
        expectedTaskRevision: manualTask!.revision,
        maxTurnsPerTask: 10,
        task: manualTask!,
        turn: manualRetry,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(repository.getTurn(manualRetry.id)).resolves.toBeUndefined();
      await expect(client.get<{ status: string; workflow_turns_reserved: number }>(
        `SELECT status, workflow_turns_reserved FROM workflow_runs
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', manual.runId],
      )).resolves.toEqual({ status: 'running', workflow_turns_reserved: 1 });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps lifecycle, disposition, and cascade commands fenced and atomic', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-lifecycle-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(`INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`, ['ws', 'lifecycle-contract', 'Lifecycle', 'now', 'now']);
      for (const [index, repository] of [new SqliteTaskRepository(client, 'ws')].entries()) {
        const task = makeTask(`lifecycle-task-${index}`);
        task.releaseState = 'released';
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        const live = { id: `lifecycle-turn-${index}`, taskId: task.id, sequence: 1, status: 'running' as const, trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:00:00.000Z' };
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: live });
        const staged = { ...live, disposition: { kind: 'complete' as const, result: 'done' }, status: 'running' as const };
        await expect(repository.execute({ kind: 'stageDisposition', workspaceId: 'ws', turnId: live.id, opId: 'op-1', turn: staged, expectedStatuses: ['running'] })).resolves.toMatchObject({ changed: true });
        await expect(repository.execute({ kind: 'stageDisposition', workspaceId: 'ws', turnId: live.id, opId: 'stale', turn: { ...staged, disposition: { kind: 'fail', error: 'bad' } }, expectedStatuses: ['running'], expectedDisposition: staged.disposition })).resolves.toMatchObject({ changed: false });
        const sealedTask = { ...task, lifecycle: 'cancelled' as const, revision: 1, updatedAt: '2026-07-16T00:00:01.000Z' };
        const sealedTurn = { ...staged, status: 'interrupted' as const, finishedAt: '2026-07-16T00:00:01.000Z' };
        await expect(repository.execute({ kind: 'applyTaskLifecycle', workspaceId: 'ws', taskId: task.id, expectedTaskRevision: task.revision, task: sealedTask, turns: [sealedTurn], expectedTurns: [{ id: live.id, status: 'running' }] })).resolves.toMatchObject({ changed: true });
        await expect(repository.getTask(task.id)).resolves.toMatchObject({ lifecycle: 'cancelled', revision: 1 });
        await expect(repository.listTurns(task.id)).resolves.toMatchObject([{ status: 'interrupted' }]);
        await expect(repository.execute({ kind: 'applyTaskLifecycle', workspaceId: 'ws', taskId: task.id, expectedTaskRevision: task.revision, task: sealedTask, turns: [], expectedTurns: [{ id: live.id, status: 'running' }] })).resolves.toMatchObject({ changed: false });

        const root = makeTask(`cascade-root-${index}`);
        const child = makeTask(`cascade-child-${index}`); child.parentId = root.id;
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: child });
        const skippedRoot = { ...root, lifecycle: 'skipped' as const, revision: 1, updatedAt: '2026-07-16T00:00:02.000Z' };
        const skippedChild = { ...child, lifecycle: 'skipped' as const, revision: 1, updatedAt: '2026-07-16T00:00:02.000Z' };
        await expect(repository.execute({ kind: 'cascadeTaskLifecycle', workspaceId: 'ws', rootTaskId: root.id, mode: 'skip', expectedTasks: [{ id: root.id, revision: 0 }, { id: child.id, revision: 0 }], tasks: [skippedChild, skippedRoot], turns: [] })).resolves.toMatchObject({ changed: true });
        await expect(repository.listSubtree(root.id)).resolves.toMatchObject([{ lifecycle: 'skipped' }, { lifecycle: 'skipped' }]);
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('claims, heartbeats, reclaims, and releases runtime ownership', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-runtime-sqlite-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 'runtime-identity', 'Runtime', 'now', 'now'],
      );
      for (const [index, repository] of [new SqliteTaskRepository(client, 'ws')].entries()) {
        const task = makeTask(`runtime-task-${index}`);
        const turnId = `runtime-turn-${index}`;
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: {
          id: turnId, taskId: task.id, sequence: 1, status: 'queued', trigger: 'engine', inputs: [],
          createdAt: '2026-07-16T00:00:00.000Z',
        } });
        await expect(repository.execute({
          kind: 'claimRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-a',
          claimedAt: '2026-07-16T00:00:01.000Z', heartbeatAt: '2026-07-16T00:00:01.000Z',
          expiresAt: '2026-07-16T00:00:10.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.execute({
          kind: 'claimRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-b',
          claimedAt: '2026-07-16T00:00:02.000Z', heartbeatAt: '2026-07-16T00:00:02.000Z',
          expiresAt: '2026-07-16T00:00:20.000Z',
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.execute({
          kind: 'heartbeatRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-a',
          heartbeatAt: '2026-07-16T00:00:05.000Z', expiresAt: '2026-07-16T00:00:15.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.execute({
          kind: 'claimRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-b',
          claimedAt: '2026-07-16T00:00:16.000Z', heartbeatAt: '2026-07-16T00:00:16.000Z',
          expiresAt: '2026-07-16T00:00:30.000Z',
        })).resolves.toMatchObject({ changed: true });
        await expect(repository.getRuntimeClaim(turnId)).resolves.toMatchObject({ ownerId: 'owner-b' });
        await expect(repository.execute({ kind: 'releaseRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-a' }))
          .resolves.toMatchObject({ changed: false });
        await expect(repository.execute({ kind: 'releaseRuntime', workspaceId: 'ws', turnId, ownerId: 'owner-b' }))
          .resolves.toMatchObject({ changed: true });
        await expect(repository.getRuntimeClaim(turnId)).resolves.toBeUndefined();
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps live transcript rows byte-for-byte during retention', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-live-retention-'));
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        ['ws', 'live-retention', 'Live retention', 'now', 'now'],
      );
      const repositories: TaskRepository[] = [new SqliteTaskRepository(client, 'ws')];
      const oversized = 'live-output'.repeat(20);
      for (const [index, repository] of repositories.entries()) {
        const task = makeTask(`live-retention-task-${index}`);
        const turn = {
          id: `live-retention-turn-${index}`, taskId: task.id, sequence: 1,
          status: 'running' as const, trigger: 'engine' as const, inputs: [],
          createdAt: '2026-07-16T00:00:01.000Z', startedAt: '2026-07-16T00:00:02.000Z',
        };
        await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
        await repository.execute({
          kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: task.id,
          messages: [{
            id: `live-retention-message-${index}`, taskId: task.id, turnId: turn.id,
            role: 'assistant', content: oversized, state: 'partial', order: 0,
            createdAt: '2026-07-16T00:00:03.000Z',
          }],
          toolCalls: [{
            id: `${turn.id}:tool`, taskId: task.id, turnId: turn.id, toolCallId: 'tool',
            order: 1, name: 'read', status: 'running', output: oversized,
            createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
          }],
          reasoning: [{
            id: `${turn.id}:2`, taskId: task.id, turnId: turn.id, order: 2, content: oversized,
            createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
          }],
        });

        await expect(repository.execute({
          kind: 'applyRetentionPolicy', workspaceId: 'ws', taskId: task.id,
          keepLatestTurns: 1, maxStoredOutputChars: 30,
        })).resolves.toMatchObject({ changed: false });
        await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ status: 'running' });
        await expect(repository.listMessages(task.id)).resolves.toMatchObject([{ content: oversized }]);
        await expect(repository.listToolCalls(task.id)).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `${turn.id}:tool`, output: oversized }),
        ]));
        await expect(repository.listReasoning(task.id)).resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: `${turn.id}:2`, content: oversized }),
        ]));
      }
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('hydrates current domain DTOs with promoted columns as the single source of truth', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-sqlite-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(dbPath);
      const task = makeTask('task-1');
      const turn = {
        id: 'turn-1', taskId: 'task-1', sequence: 1, status: 'succeeded' as const,
        trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:00:01.000Z',
      };
      const message = {
        id: 'message-1', taskId: 'task-1', role: 'assistant' as const,
        content: 'payload content (stale)', state: 'complete' as const,
        createdAt: '2026-07-16T00:00:02.000Z',
      };
      await client.transaction([
        {
          sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
                VALUES (?,?,?,?,?)`,
          params: ['ws-1', 'identity-1', 'Workspace', 'now', 'now'],
        },
        {
          sql: `INSERT INTO tasks
                (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, model,
                 revision, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'task-1', 'ws-1', null, 'worker', 'succeeded', 'released', 'column goal', 'codex',
            'column-model', 4, '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:03.000Z',
            JSON.stringify({
              payloadVersion: 1,
              capabilities: task.capabilities,
              executionPolicy: task.executionPolicy,
            }),
          ],
        },
        {
          sql: `INSERT INTO turns
                (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'turn-1', 'ws-1', 'task-1', 1, 'succeeded', 'user', turn.createdAt, null,
            '2026-07-16T00:00:02.000Z', JSON.stringify({ payloadVersion: 1 }),
          ],
        },
        {
          sql: `INSERT INTO messages
                (id, workspace_id, task_id, turn_id, role, state, ordering, content, created_at, updated_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'message-1', 'ws-1', 'task-1', 'turn-1', 'assistant', 'complete', 7,
            'column content', message.createdAt, null, JSON.stringify({ payloadVersion: 1 }),
          ],
        },
        {
          sql: `INSERT INTO turns
                (id, workspace_id, task_id, sequence, status, trigger, created_at, started_at, settled_at, payload_json)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            'turn-queued', 'ws-1', 'task-1', 2, 'queued', 'engine', '2026-07-16T00:00:04.000Z',
            null, null, JSON.stringify({ payloadVersion: 1 }),
          ],
        },
      ]);

      const repository = new SqliteTaskRepository(client, 'ws-1');
      await expect(repository.getTask('task-1')).resolves.toMatchObject({
        id: 'task-1', goal: 'column goal', backend: 'codex', model: 'column-model',
        lifecycle: 'succeeded', releaseState: 'released', revision: 4,
      });
      await expect(repository.listTurns('task-1')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'turn-1', status: 'succeeded', finishedAt: '2026-07-16T00:00:02.000Z' }),
        expect.objectContaining({ id: 'turn-queued', status: 'queued' }),
      ]));
      await expect(repository.listMessages('task-1')).resolves.toMatchObject([
        { id: 'message-1', content: 'column content', order: 7, turnId: 'turn-1' },
      ]);
      await expect(repository.listRootTasks('ws-1')).resolves.toMatchObject({ items: [{ id: 'task-1' }] });
      await expect(repository.listSubtree('task-1')).resolves.toMatchObject([{ id: 'task-1' }]);
      await expect(repository.listQueuedTurns('task-1')).resolves.toMatchObject([{ id: 'turn-queued' }]);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects malformed current payloads instead of returning partial DTOs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-sqlite-invalid-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
    });
    try {
      await client.open(dbPath);
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
         VALUES (?,?,?,?,?)`,
        ['ws-1', 'identity-1', 'Workspace', 'now', 'now'],
      );
      await client.run(
        `INSERT INTO tasks
         (id, workspace_id, parent_id, role, lifecycle, release_state, goal, backend, revision, created_at, updated_at, payload_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['task-1', 'ws-1', null, 'worker', 'open', 'draft', 'goal', 'codex', 0, 'now', 'now', JSON.stringify({ payloadVersion: 1 })],
      );
      const repository = new SqliteTaskRepository(client, 'ws-1');
      await expect(repository.getTask('task-1')).rejects.toThrow(/missing domain payload fields/);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('persists every task aggregate as normalized rows exposed by focused queries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-parity-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({
        kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'file:///repo', displayName: 'Repo',
        createdAt: '2026-07-16T00:00:00.000Z', lastOpenedAt: '2026-07-16T00:00:00.000Z',
      });
      await repository.execute({
        kind: 'recordWorkspaceLocation', workspaceId: 'ws', canonicalUri: 'file:///repo',
        firstSeenAt: '2026-07-16T00:00:00.000Z', lastSeenAt: '2026-07-16T00:00:00.000Z',
      });
      await expect(repository.getWorkspace()).resolves.toMatchObject({ identityKey: 'file:///repo' });
      await expect(repository.listWorkspaceLocations()).resolves.toMatchObject([{ canonicalUri: 'file:///repo' }]);
      const producer = makeTask('producer');
      producer.description = 'normalised task payload';
      producer.releaseState = 'released';
      const consumer = makeTask('consumer');
      consumer.prerequisites = [{ producerTaskId: producer.id, requiredLifecycle: 'succeeded', onUnmet: 'block' }];
      consumer.description = 'consumer payload';
      consumer.wait = { kind: 'external', key: 'approval', message: 'waiting for approval' };
      consumer.releaseState = 'released';
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: producer });
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: consumer });
      const turn = {
        id: 'turn-1', taskId: consumer.id, sequence: 1, status: 'queued' as const, trigger: 'user' as const,
        inputs: [
          { kind: 'message' as const, messageId: 'message-1' },
          { kind: 'recovery' as const, interruptedTurnId: 'old-turn', instruction: 'continue safely' },
        ],
        createdAt: '2026-07-16T00:00:01.000Z',
      };
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn });
      const message = {
        id: 'message-1', taskId: consumer.id, turnId: turn.id, role: 'assistant' as const,
        content: 'stream fragment', agentContent: 'full stream fragment', state: 'partial' as const,
        order: 0, createdAt: '2026-07-16T00:00:02.000Z',
      };
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: consumer.id,
        messages: [message],
        toolCalls: [{
          id: 'turn-1:tool-1', taskId: consumer.id, turnId: turn.id, toolCallId: 'tool-1', order: 1,
          name: 'read_file', kind: 'builtin', status: 'success', input: { path: 'a.ts' }, output: 'ok',
          createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
        }],
        reasoning: [{
          id: `${turn.id}:2`, taskId: consumer.id, turnId: turn.id, order: 2, content: 'reasoning',
          createdAt: '2026-07-16T00:00:03.000Z', updatedAt: '2026-07-16T00:00:04.000Z',
        }],
      });
      const batchFeed = await client.all<{ revision: number; n: number }>(
        `SELECT revision, COUNT(*) AS n FROM change_log
          WHERE workspace_id = ? AND entity_kind IN ('message', 'tool_call', 'reasoning')
          GROUP BY revision ORDER BY revision`,
        ['ws'],
      );
      expect(batchFeed).toHaveLength(1);
      expect(batchFeed[0]?.n).toBe(3);
      const operation: OperationLedgerEntry = { fingerprint: 'fp', result: { ok: true, data: { created: true } } };
      await repository.execute({ kind: 'putOperation', workspaceId: 'ws', ledgerKey: 'turn-1:op-1', entry: operation, createdAt: '2026-07-16T00:00:05.000Z' });
      await repository.execute({
        kind: 'putCancelRequest', workspaceId: 'ws', turnId: turn.id,
        request: { kind: 'interrupt', by: 'user', opId: 'cancel-1', at: '2026-07-16T00:00:06.000Z', reason: 'stop' },
      });
      await repository.execute({
        kind: 'putSendReceipt', workspaceId: 'ws',
        receipt: { clientRequestId: 'request-1', fingerprint: 'send-fp', taskId: consumer.id, messageId: message.id, turnId: turn.id, createdAt: '2026-07-16T00:00:07.000Z' },
      });

      const taskRow = await client.get<{ payload_json: string }>('SELECT payload_json FROM tasks WHERE workspace_id = ? AND id = ?', ['ws', consumer.id]);
      const turnRow = await client.get<{ payload_json: string }>('SELECT payload_json FROM turns WHERE workspace_id = ? AND id = ?', ['ws', turn.id]);
      expect(taskRow?.payload_json).not.toContain('"dependencies"');
      expect(taskRow?.payload_json).not.toContain('"goal"');
      expect(turnRow?.payload_json).not.toContain('"inputs"');
      expect(await client.all('SELECT * FROM turn_inputs WHERE workspace_id = ? AND turn_id = ?', ['ws', turn.id])).toHaveLength(2);

      await expect(repository.getTask(consumer.id)).resolves.toMatchObject({
        prerequisites: consumer.prerequisites,
        description: consumer.description,
        wait: consumer.wait,
      });
      await expect(repository.getTurn(turn.id)).resolves.toMatchObject({ inputs: turn.inputs });
      await expect(repository.listMessages(consumer.id)).resolves.toContainEqual(
        expect.objectContaining({ id: message.id, agentContent: message.agentContent }),
      );
      await expect(repository.listToolCalls(consumer.id)).resolves.toMatchObject([{ id: 'turn-1:tool-1' }]);
      await expect(repository.listReasoning(consumer.id)).resolves.toMatchObject([{ id: `${turn.id}:2`, order: 2 }]);
      await expect(repository.getOperation('turn-1:op-1')).resolves.toEqual(operation);
      await expect(repository.getCancelRequest(turn.id)).resolves.toMatchObject({ opId: 'cancel-1' });
      await expect(repository.getSendReceipt('request-1')).resolves.toMatchObject({ turnId: turn.id });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('claims operations idempotently without advancing revision on a replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-operations-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'ops', displayName: 'Ops', createdAt: 'now', lastOpenedAt: 'now' });
      const entry: OperationLedgerEntry = { fingerprint: 'fp-1', result: { ok: true, data: { value: 1 } } };
      const first = await repository.execute({ kind: 'claimOperation', workspaceId: 'ws', ledgerKey: 'turn:op', entry, createdAt: 'now' });
      const revisionAfterFirst = await client.get<{ revision: number }>('SELECT revision FROM workspace_revisions WHERE workspace_id = ?', ['ws']);
      const replay = await repository.execute({ kind: 'claimOperation', workspaceId: 'ws', ledgerKey: 'turn:op', entry, createdAt: 'later' });
      const revisionAfterReplay = await client.get<{ revision: number }>('SELECT revision FROM workspace_revisions WHERE workspace_id = ?', ['ws']);
      const conflict = await repository.execute({
        kind: 'claimOperation', workspaceId: 'ws', ledgerKey: 'turn:op',
        entry: { fingerprint: 'different', result: { ok: false, error: 'not used' } }, createdAt: 'later',
      });
      expect(first).toMatchObject({ changed: true, operation: entry });
      expect(replay).toMatchObject({ changed: false, operation: entry });
      expect(conflict).toMatchObject({ changed: false, conflict: true, operation: entry });
      expect(revisionAfterReplay?.revision).toBe(revisionAfterFirst?.revision);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('serializes same-session and git claims across two DB workers, then releases them on settlement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-claims-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const one = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    const two = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await one.open(dbPath);
      await two.open(dbPath);
      const first = new SqliteTaskRepository(one, 'ws');
      const second = new SqliteTaskRepository(two, 'ws');
      await first.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'claims', displayName: 'Claims', createdAt: 'now', lastOpenedAt: 'now' });
      const root = makeTask('root');
      root.releaseState = 'released';
      const a = makeTask('a'); a.parentId = root.id; a.releaseState = 'released'; a.claimsGit = true;
      const b = makeTask('b'); b.parentId = root.id; b.releaseState = 'released'; b.claimsGit = true;
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: root });
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: a });
      await first.execute({ kind: 'createTask', workspaceId: 'ws', task: b });
      await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn: { id: 'ta', taskId: a.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z' } });
      await first.execute({ kind: 'createTurn', workspaceId: 'ws', turn: { id: 'tb', taskId: b.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z' } });
      const claim = (repository: SqliteTaskRepository, turnId: string, startedAt: string) => repository.execute({
        kind: 'claimTurn' as const, workspaceId: 'ws', turnId, startedAt, rootTaskId: root.id,
        maxConcurrentTurns: 10, maxConcurrentPerRoot: 10, maxConcurrentPerBackend: 10,
        sessionId: 'shared-session', resourceKeys: ['git'],
      });
      const [left, right] = await Promise.all([claim(first, 'ta', '2026-07-16T00:00:02.000Z'), claim(second, 'tb', '2026-07-16T00:00:02.000Z')]);
      expect([left.changed, right.changed].filter(Boolean)).toHaveLength(1);
      expect(await one.all(
        `SELECT * FROM change_log WHERE workspace_id = ? AND entity_kind = 'turn' AND change_kind = 'promote'`,
        ['ws'],
      )).toHaveLength(1);
      const winner = left.changed ? { repository: first, turnId: 'ta' } : { repository: second, turnId: 'tb' };
      const loser = left.changed ? { repository: second, turnId: 'tb' } : { repository: first, turnId: 'ta' };
      // A stale settlement of the queued loser must not run the trailing claim
      // cleanup statements. This protects the winner's session/resource lease.
      await expect(loser.repository.execute({ kind: 'settleTurn', workspaceId: 'ws', turnId: loser.turnId, status: 'succeeded', finishedAt: '2026-07-16T00:00:02.500Z' })).resolves.toMatchObject({ changed: false });
      expect(await one.all('SELECT * FROM session_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
      expect(await one.all('SELECT * FROM resource_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
      await winner.repository.execute({ kind: 'settleTurn', workspaceId: 'ws', turnId: winner.turnId, status: 'succeeded', finishedAt: '2026-07-16T00:00:03.000Z' });
      await expect(claim(loser.repository, loser.turnId, '2026-07-16T00:00:04.000Z')).resolves.toMatchObject({ changed: true });
      expect(await one.all('SELECT * FROM session_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
      expect(await one.all('SELECT * FROM resource_claims WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
    } finally {
      await Promise.all([one.close(), two.close()]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('derives the owning root in SQLite instead of trusting the caller root id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-root-claim-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'root-claim', displayName: 'Root claim', createdAt: 'now', lastOpenedAt: 'now' });
      const rootA = makeTask('root-a'); rootA.releaseState = 'released';
      const rootB = makeTask('root-b'); rootB.releaseState = 'released';
      const a1 = makeTask('a-1'); a1.parentId = rootA.id; a1.releaseState = 'released';
      const a2 = makeTask('a-2'); a2.parentId = rootA.id; a2.releaseState = 'released';
      const b1 = makeTask('b-1'); b1.parentId = rootB.id; b1.releaseState = 'released';
      for (const task of [rootA, rootB, a1, a2, b1]) await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      for (const [turnId, taskId] of [['ta1', a1.id], ['ta2', a2.id], ['tb1', b1.id]] as const) {
        await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: {
          id: turnId, taskId, sequence: 1, status: 'queued', trigger: 'engine', inputs: [], createdAt: '2026-07-16T00:00:00.000Z',
        } });
      }
      const claim = (turnId: string, callerRoot: string) => repository.execute({
        kind: 'claimTurn' as const, workspaceId: 'ws', turnId, startedAt: `2026-07-16T00:00:0${turnId.length}.000Z`,
        rootTaskId: callerRoot, maxConcurrentTurns: 10, maxConcurrentPerRoot: 1,
        maxConcurrentPerBackend: 10, resourceKeys: [],
      });
      await expect(claim('ta1', rootA.id)).resolves.toMatchObject({ changed: true });
      // Lying with root-b must not bypass root-a's concurrency ceiling.
      await expect(claim('ta2', rootB.id)).resolves.toMatchObject({ changed: false });
      await expect(claim('tb1', rootA.id)).resolves.toMatchObject({ changed: true });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps the final SQLite claim gate aligned with scheduler readiness blockers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-readiness-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'readiness', displayName: 'Readiness', createdAt: 'now', lastOpenedAt: 'now' });
      const task = makeTask('blocked-task');
      task.releaseState = 'released';
      task.wait = { kind: 'external', key: 'approval' };
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: { id: 'blocked-turn', taskId: task.id, sequence: 1, status: 'queued', trigger: 'user', inputs: [], createdAt: '2026-07-16T00:00:01.000Z', runtimeEpoch: 1 } });
      const claim = () => repository.execute({
        kind: 'claimTurn' as const, workspaceId: 'ws', turnId: 'blocked-turn', startedAt: '2026-07-16T00:00:02.000Z',
        rootTaskId: task.id, maxConcurrentTurns: 10, maxConcurrentPerRoot: 10, maxConcurrentPerBackend: 10,
        resourceKeys: [],
      });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.wait = undefined;
      task.runtimeEpoch = 2;
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.runtimeEpoch = 1;
      task.inputBindings = [{ fromTaskId: 'missing-producer', output: 'summary', as: 'input' }];
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: false });

      task.inputBindings = undefined;
      await repository.execute({ kind: 'upsertTask', workspaceId: 'ws', task });
      await expect(claim()).resolves.toMatchObject({ changed: true });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('leaves terminal rows intact until payload retention has work to perform', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retention-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'retention', displayName: 'Retention', createdAt: 'now', lastOpenedAt: 'now' });
      const task = makeTask('retention-task');
      task.lifecycle = 'succeeded';
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task });
      for (const sequence of [1, 2, 3]) {
        const turnId = `turn-${sequence}`;
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: { id: turnId, taskId: task.id, sequence, status: 'succeeded', trigger: 'user', inputs: [], createdAt: `2026-07-16T00:00:0${sequence}.000Z`, finishedAt: `2026-07-16T00:00:1${sequence}.000Z` },
        });
        await repository.execute({
          kind: 'appendMessage', workspaceId: 'ws',
          message: { id: `message-${sequence}`, taskId: task.id, turnId, role: 'assistant', content: String(sequence), state: 'complete', order: 0, createdAt: `2026-07-16T00:00:2${sequence}.000Z` },
        });
      }
      await expect(repository.execute({ kind: 'applyRetention', workspaceId: 'ws', taskId: task.id, keepLatestTurns: 1 })).resolves.toMatchObject({ changed: false });
      await expect(repository.listTurns(task.id)).resolves.toHaveLength(3);
      await expect(repository.listMessages(task.id)).resolves.toHaveLength(3);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('retention preserves open workflow evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-workflow-retention-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'workflow-retention', displayName: 'Workflow retention', createdAt: 'now', lastOpenedAt: 'now' });
      const createdAt = '2026-07-19T00:00:00.000Z';
      await expect(repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-retention', version: 1,
        name: 'retention', topology: makeOneNodeDefinition({
          definitionId: 'wf-retention', name: 'retention', createdAt,
        }).topology, createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
      const start = await repository.execute({
        kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-retention', version: 1,
        startIdempotencyKey: 'retention-start', createdAt, goal: 'retain active evidence', backend: 'grok',
      });
      const started = start.operation?.result?.data as {
        runId: string; entryTaskId: string; activationTurnId: string; entryMessageId: string;
      };
      expect(started).toMatchObject({
        runId: expect.any(String), entryTaskId: expect.any(String), activationTurnId: expect.any(String),
      });
      const operationKey = `${started.activationTurnId}:retention-proof`;
      await expect(repository.execute({
        kind: 'claimOperation', workspaceId: 'ws', ledgerKey: operationKey,
        entry: { fingerprint: 'retention-proof', result: { ok: true, data: { retained: true } } },
        createdAt: '2026-07-19T00:00:01.000Z',
      })).resolves.toMatchObject({ changed: true });

      const workflowTask = await repository.getTask(started.entryTaskId);
      expect(workflowTask).toBeDefined();
      await repository.execute({
        kind: 'upsertTask', workspaceId: 'ws',
        task: {
          ...workflowTask!, lifecycle: 'succeeded', finishedAt: '2026-07-19T00:00:02.000Z',
          updatedAt: '2026-07-19T00:00:02.000Z', revision: workflowTask!.revision + 1,
        },
      });

      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: started.entryTaskId, keepLatestTurns: 0,
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(repository.getTurn(started.activationTurnId)).resolves.toMatchObject({ status: 'queued' });
      await expect(repository.listMessages(started.entryTaskId)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: started.entryMessageId }),
      ]));
      await expect(repository.getOperation(operationKey)).resolves.toMatchObject({ fingerprint: 'retention-proof' });
      await expect(client.get(
        `SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?`,
        ['ws', started.runId],
      )).resolves.toMatchObject({ status: 'running' });
      await expect(client.get(
        `SELECT status, execution_turn_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', started.runId],
      )).resolves.toMatchObject({ status: 'queued', execution_turn_id: started.activationTurnId });
      await expect(client.get(
        `SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ?`,
        ['ws', started.runId],
      )).resolves.toMatchObject({ status: 'satisfied' });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('preserves terminal history and keeps the newest settled output on open tasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-retention-policy-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      await repository.execute({ kind: 'upsertWorkspace', workspaceId: 'ws', identityKey: 'retention-policy', displayName: 'Retention policy', createdAt: 'now', lastOpenedAt: 'now' });

      const terminal = makeTask('terminal-retention');
      terminal.lifecycle = 'succeeded';
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: terminal });
      for (const sequence of [1, 2, 3]) {
        await repository.execute({
          kind: 'createTurn', workspaceId: 'ws',
          turn: {
            id: `terminal-turn-${sequence}`, taskId: terminal.id, sequence, status: 'succeeded',
            trigger: 'user', inputs: [], createdAt: `2026-07-16T00:00:0${sequence}.000Z`,
            ...(sequence === 3 ? { retryOf: 'terminal-turn-2' } : {}),
          },
        });
      }
      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: terminal.id, keepLatestTurns: 1,
      })).resolves.toMatchObject({ changed: false });
      await expect(repository.listTurns(terminal.id)).resolves.toMatchObject([
        { id: 'terminal-turn-1' },
        { id: 'terminal-turn-2' },
        { id: 'terminal-turn-3', retryOf: 'terminal-turn-2' },
      ]);

      const open = makeTask('open-retention');
      await repository.execute({ kind: 'createTask', workspaceId: 'ws', task: open });
      const openTurn = {
        id: 'open-turn', taskId: open.id, sequence: 1, status: 'succeeded' as const,
        trigger: 'user' as const, inputs: [], createdAt: '2026-07-16T00:01:00.000Z',
      };
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: openTurn });
      const liveTurn = {
        id: 'open-live-turn', taskId: open.id, sequence: 2, status: 'running' as const,
        trigger: 'engine' as const, inputs: [], createdAt: '2026-07-16T00:02:00.000Z',
        startedAt: '2026-07-16T00:02:01.000Z',
      };
      await repository.execute({ kind: 'createTurn', workspaceId: 'ws', turn: liveTurn });
      const oversized = 'x'.repeat(100);
      await repository.execute({
        kind: 'appendTranscriptBatch', workspaceId: 'ws', taskId: open.id,
        messages: [
          { id: 'open-assistant', taskId: open.id, turnId: openTurn.id, role: 'assistant', content: oversized, state: 'complete', order: 0, createdAt: openTurn.createdAt },
          { id: 'live-assistant', taskId: open.id, turnId: liveTurn.id, role: 'assistant', content: oversized, state: 'partial', order: 0, createdAt: liveTurn.createdAt },
        ],
        toolCalls: [
          { id: 'open-tool', taskId: open.id, turnId: openTurn.id, toolCallId: 'tool', order: 1, name: 'read', status: 'success', output: oversized, createdAt: openTurn.createdAt, updatedAt: openTurn.createdAt },
          { id: 'live-tool', taskId: open.id, turnId: liveTurn.id, toolCallId: 'live-tool', order: 1, name: 'read', status: 'running', output: oversized, createdAt: liveTurn.createdAt, updatedAt: liveTurn.createdAt },
        ],
        reasoning: [
          { id: 'open-reasoning', taskId: open.id, turnId: openTurn.id, order: 2, content: oversized, createdAt: openTurn.createdAt, updatedAt: openTurn.createdAt },
          { id: 'live-reasoning', taskId: open.id, turnId: liveTurn.id, order: 2, content: oversized, createdAt: liveTurn.createdAt, updatedAt: liveTurn.createdAt },
        ],
      });
      await expect(repository.execute({
        kind: 'applyRetention', workspaceId: 'ws', taskId: open.id, keepLatestTurns: 1,
        maxStoredOutputChars: 30,
      })).resolves.toMatchObject({ changed: false });
      await expect(repository.listTurns(open.id)).resolves.toMatchObject([
        { id: openTurn.id }, { id: liveTurn.id, status: 'running' },
      ]);
      await expect(repository.listMessages(open.id)).resolves.toMatchObject([
        { id: 'open-assistant', content: oversized },
        { id: 'live-assistant', content: oversized },
      ]);
      await expect(repository.listToolCalls(open.id)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'open-tool', output: oversized }),
        expect.objectContaining({ id: 'live-tool', output: oversized }),
      ]));
      await expect(repository.listReasoning(open.id)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'open-reasoning', content: oversized }),
        expect.objectContaining({ id: 'live-reasoning', content: oversized }),
      ]));
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);



  it('starts a one-node workflow run with one queued entry turn and idempotent replay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-start-wf-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const createdAt = '2026-07-19T00:00:00.000Z';
      const topology = makeOneNodeDefinition({
        definitionId: 'wf-one', name: 'one-node', createdAt,
      }).topology;
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        name: 'one-node',
        topology,
        createdAt,
      });
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'repo-start-1',
        createdAt,
        goal: 'entry goal',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      expect(start.changed).toBe(true);
      const data = start.operation?.result?.data as { activationTurnId: string; entryTaskId: string; runId: string };
      expect(data.activationTurnId).toEqual(expect.any(String));
      const turns = await repository.listQueuedTurns(data.entryTaskId);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.id).toBe(data.activationTurnId);
      const replay = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-one',
        version: 1,
        startIdempotencyKey: 'repo-start-1',
        createdAt,
        goal: 'entry goal',
        backend: 'grok',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(await repository.listTurns(data.entryTaskId)).toHaveLength(1);
      expect(await client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('multi-node fan-in start: per-task gates, entry activation only, consumer stays open', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-start-fan-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const createdAt = '2026-07-19T00:00:00.000Z';
      const topology = makeGraphFanInDefinition({
        definitionId: 'wf-fan', name: 'fan-in', createdAt,
      }).topology;
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-fan',
        version: 1,
        name: 'fan-in',
        topology,
        createdAt,
      });
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-fan',
        version: 1,
        startIdempotencyKey: 'repo-start-fan-1',
        createdAt,
        goal: 'fan goal',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      expect(start.changed).toBe(true);
      const data = start.operation?.result?.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; gateId: string; activationTurnId: string }>;
        nodeGates: Array<{ nodeId: string; gateId: string }>;
      };
      expect(data.entries).toHaveLength(2);
      expect(data.nodeGates).toHaveLength(3);
      expect(data.entries.map((e) => e.nodeId).sort()).toEqual(['p1', 'p2']);

      for (const entry of data.entries) {
        const turns = await repository.listQueuedTurns(entry.taskId);
        expect(turns).toHaveLength(1);
        expect(turns[0]?.id).toBe(entry.activationTurnId);
      }
      const tasks = await client.all(
        'SELECT id FROM tasks WHERE workspace_id = ? ORDER BY id',
        ['ws'],
      );
      expect(tasks).toHaveLength(3);
      const consumerTaskIdBefore = (await client.get<{ task_id: string }>(
        'SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      ))?.task_id;
      expect(consumerTaskIdBefore).toEqual(expect.any(String));
      const consumerShellTask = await repository.getTask(consumerTaskIdBefore!);
      expect(consumerShellTask?.workflowShell).toMatchObject({ runId: data.runId, nodeId: 'consumer' });
      expect(await repository.listTurns(consumerTaskIdBefore!)).toHaveLength(0);

      const nodes = await client.all(
        'SELECT node_id, task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? ORDER BY node_id',
        ['ws', data.runId],
      );
      expect(nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ node_id: 'p1', status: 'active' }),
          expect.objectContaining({ node_id: 'p2', status: 'active' }),
          expect.objectContaining({ node_id: 'consumer', task_id: expect.any(String), status: 'pending' }),
        ]),
      );

      const gates = await client.all(
        'SELECT consumer_node_id, status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? ORDER BY consumer_node_id',
        ['ws', data.runId],
      );
      expect(gates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ consumer_node_id: 'p1', status: 'satisfied' }),
          expect.objectContaining({ consumer_node_id: 'p2', status: 'satisfied' }),
          expect.objectContaining({ consumer_node_id: 'consumer', status: 'open' }),
        ]),
      );

      const consumerGate = data.nodeGates.find((g) => g.nodeId === 'consumer')!;
      const bindings = await client.all(
        'SELECT input_ref, producer_node_id, required_kind FROM workflow_gate_bindings WHERE workspace_id = ? AND run_id = ? AND gate_id = ? ORDER BY input_ref',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(bindings).toEqual([
        { input_ref: 'from_p1', producer_node_id: 'p1', required_kind: 'next_result' },
        { input_ref: 'from_p2', producer_node_id: 'p2', required_kind: 'next_result' },
      ]);

      const fills = await client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(fills).toHaveLength(0);

      const replay = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-fan',
        version: 1,
        startIdempotencyKey: 'repo-start-fan-1',
        createdAt,
        goal: 'fan goal',
        backend: 'grok',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(await client.all('SELECT id FROM tasks WHERE workspace_id = ?', ['ws'])).toHaveLength(3);
      expect(await client.all('SELECT run_id FROM workflow_runs WHERE workspace_id = ?', ['ws'])).toHaveLength(1);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
  it('NEXT contribution: partial fill then final gate close + aggregate activation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-next-fan-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const createdAt = '2026-07-19T00:00:00.000Z';
      const topology = makeGraphFanInDefinition({
        definitionId: 'wf-next', name: 'fan-in-next', createdAt,
      }).topology;
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-next',
        version: 1,
        name: 'fan-in-next',
        topology,
        createdAt,
      });
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-next',
        version: 1,
        startIdempotencyKey: 'repo-next-fan-1',
        createdAt,
        goal: 'fan next goal',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      const data = start.operation?.result?.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; gateId: string; activationTurnId: string }>;
        nodeGates: Array<{ nodeId: string; gateId: string }>;
      };
      const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
      const p1 = byNode.get('p1')!;
      const p2 = byNode.get('p2')!;
      const consumerGate = data.nodeGates.find((g) => g.nodeId === 'consumer')!;

      const settleProducer = async (
        entry: { taskId: string; activationTurnId: string },
        result: string,
        finishedAt: string,
      ) => {
        await client.run(
          `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
          [createdAt, 'ws', entry.activationTurnId],
        );
        const task = await repository.getTask(entry.taskId);
        const turn = await repository.getTurn(entry.activationTurnId);
        expect(task).toBeTruthy();
        expect(turn).toBeTruthy();
        const disposition = { kind: 'workflow_next' as const, change: 'updated' as const, result };
        await stageDispositionForSettlement(repository, turn!, disposition);
        return repository.execute({
          kind: 'settleTurnAndApplyEffects',
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          task: {
            ...task!,
            updatedAt: finishedAt,
          },
          turn: {
            ...turn!,
            status: 'succeeded',
            finishedAt,
            disposition,
          },
          expectedStatuses: ['running'],
          relatedTurns: [],
          messages: [],
        });
      };

      const first = await settleProducer(p1, 'p1-result', '2026-07-19T00:01:00.000Z');
      expect(first.ok).toBe(true);
      expect(first.changed).toBe(true);

      // Partial: one fill, gate open, consumer absent.
      const fillsAfterFirst = await client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ? ORDER BY input_ref',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(fillsAfterFirst).toEqual([{ input_ref: 'from_p1' }]);
      const gateAfterFirst = await client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(gateAfterFirst).toMatchObject({ status: 'open' });
      expect(await client.all('SELECT id FROM tasks WHERE workspace_id = ?', ['ws'])).toHaveLength(3);
      const consumerNodeAfterFirst = await client.get(
        'SELECT task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNodeAfterFirst?.task_id).toEqual(expect.any(String));
      expect(consumerNodeAfterFirst).toMatchObject({ status: 'pending' });
      const shellTaskAfterFirst = await repository.getTask(consumerNodeAfterFirst!.task_id as string);
      expect(shellTaskAfterFirst?.workflowShell).toMatchObject({ runId: data.runId, nodeId: 'consumer' });
      expect(await repository.listTurns(shellTaskAfterFirst!.id)).toHaveLength(0);

      // Producer lifecycle stays open after NEXT.
      const p1Task = await repository.getTask(p1.taskId);
      expect(p1Task?.lifecycle).toBe('open');

      const second = await settleProducer(p2, 'p2-result', '2026-07-19T00:02:00.000Z');
      expect(second.ok).toBe(true);
      expect(second.changed).toBe(true);

      const fillsAfterSecond = await client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ? ORDER BY input_ref',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(fillsAfterSecond).toEqual([{ input_ref: 'from_p1' }, { input_ref: 'from_p2' }]);
      const gateAfterSecond = await client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(gateAfterSecond).toMatchObject({ status: 'satisfied' });

      const consumerNode = await client.get(
        'SELECT task_id, status FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      );
      expect(consumerNode?.task_id).toEqual(expect.any(String));
      expect(consumerNode?.status).toBe('active');
      const consumerTaskId = consumerNode!.task_id as string;
      const consumerTurns = await repository.listQueuedTurns(consumerTaskId);
      expect(consumerTurns).toHaveLength(1);
      expect(consumerTurns[0]?.trigger).toBe('engine');
      expect(consumerTurns[0]?.status).toBe('queued');

      const messages = await repository.listMessages(consumerTaskId);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content.startsWith('[workflow-aggregate]')).toBe(true);
      // Definition edge order: from_p1 then from_p2.
      const content = messages[0]!.content;
      expect(content.indexOf('from_p1=')).toBeLessThan(content.indexOf('from_p2='));

      // Exactly one activation turn; producers remain open.
      expect(await repository.listTurns(consumerTaskId)).toHaveLength(1);
      expect((await repository.getTask(p1.taskId))?.lifecycle).toBe('open');
      expect((await repository.getTask(p2.taskId))?.lifecycle).toBe('open');

      // Durable contribution fence: one routed message per producer contribution.
      const routed = await client.all(
        `SELECT message_id, kind, source_node_id, destination_node_id, body_json
           FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ?
          ORDER BY source_node_id`,
        ['ws', data.runId],
      );
      expect(routed).toHaveLength(2);
      expect(routed.every((row) => row.kind === 'next_contribution')).toBe(true);
      expect(routed.every((row) => row.destination_node_id === 'consumer')).toBe(true);
      // body_json carries identities only — no result text, paths, SQL, or credentials.
      for (const row of routed) {
        const body = String(row.body_json);
        expect(body).not.toContain('p1-result');
        expect(body).not.toContain('p2-result');
        expect(body).not.toMatch(/SELECT |INSERT |DELETE /i);
        expect(body).toContain('next_contribution');
        expect(body).toContain('artifactRevision');
      }

      // Deterministic revision: exactly one artifact row per producer, revision 1.
      const artifacts = await client.all(
        `SELECT producer_node_id, revision FROM workflow_artifacts
          WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'
          ORDER BY producer_node_id, revision`,
        ['ws', data.runId],
      );
      expect(artifacts).toEqual([
        { producer_node_id: 'p1', revision: 1 },
        { producer_node_id: 'p2', revision: 1 },
      ]);

      // Redelivery of already-settled producer is a no-op (no second activation).
      const redelivery = await repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: (await repository.getTask(p2.taskId))!.revision,
        task: (await repository.getTask(p2.taskId))!,
        turn: {
          ...(await repository.getTurn(p2.activationTurnId))!,
          status: 'succeeded',
          finishedAt: '2026-07-19T00:02:00.000Z',
          disposition: { kind: 'workflow_next', change: 'updated', result: 'p2-result' },
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      });
      expect(redelivery.ok).toBe(true);
      expect(redelivery.changed).toBe(false);
      expect(await repository.listTurns(consumerTaskId)).toHaveLength(1);
      expect(await client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate.gateId],
      )).toHaveLength(2);

      // After pruning the source turn's operations ledger, force a re-settlement:
      // durable fence keeps contribution a no-op (no second artifact/fill/activation).
      await client.run(
        `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`,
        ['ws', `${p2.activationTurnId}:*`],
      );
      await client.run(
        `UPDATE turns SET status = 'running', settled_at = NULL, started_at = ?
          WHERE workspace_id = ? AND id = ?`,
        ['2026-07-19T00:03:00.000Z', 'ws', p2.activationTurnId],
      );
      const postPrune = await repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: (await repository.getTask(p2.taskId))!.revision,
        task: {
          ...(await repository.getTask(p2.taskId))!,
          updatedAt: '2026-07-19T00:03:00.000Z',
        },
        turn: {
          ...(await repository.getTurn(p2.activationTurnId))!,
          status: 'succeeded',
          finishedAt: '2026-07-19T00:03:00.000Z',
          disposition: { kind: 'workflow_next', change: 'updated', result: 'p2-result-again' },
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      });
      expect(postPrune.ok).toBe(true);
      // Turn settles again, but contribution fence suppresses workflow side effects.
      expect(await client.all(
        `SELECT message_id FROM workflow_routed_messages WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).toHaveLength(2);
      expect(await client.all(
        `SELECT producer_node_id, revision FROM workflow_artifacts
          WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'`,
        ['ws', data.runId],
      )).toHaveLength(2);
      expect(await client.all(
        'SELECT input_ref FROM workflow_gate_fills WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate.gateId],
      )).toHaveLength(2);
      expect(await repository.listTurns(consumerTaskId)).toHaveLength(1);
      const gateAfterPrune = await client.get(
        'SELECT status FROM workflow_dependency_gates WHERE workspace_id = ? AND run_id = ? AND gate_id = ?',
        ['ws', data.runId, consumerGate.gateId],
      );
      expect(gateAfterPrune).toMatchObject({ status: 'satisfied' });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('PREV feedback ALL-join: open round, partial no resume, final ordered resume, redelivery no-op', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-prev-fan-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const createdAt = '2026-07-19T00:00:00.000Z';
      const topology = makeGraphFanInDefinition({
        definitionId: 'wf-prev', name: 'prev-all-join', createdAt,
      }).topology;
      await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-prev',
        version: 1,
        name: 'prev-all-join',
        topology,
        createdAt,
      });
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-prev',
        version: 1,
        startIdempotencyKey: 'repo-prev-fan-1',
        createdAt,
        goal: 'prev join goal',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      const data = start.operation?.result?.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; gateId: string; activationTurnId: string }>;
        nodeGates: Array<{ nodeId: string; gateId: string }>;
      };
      const byNode = new Map(data.entries.map((e) => [e.nodeId, e]));
      const p1 = byNode.get('p1')!;
      const p2 = byNode.get('p2')!;

      const settleSucceeded = async (
        taskId: string,
        turnId: string,
        disposition: { kind: 'workflow_next'; change: 'updated' | 'unchanged'; result?: string }
          | { kind: 'workflow_prev'; targets: 'all' | string[]; note?: string },
        finishedAt: string,
      ) => {
        await client.run(
          `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
          [createdAt, 'ws', turnId],
        );
        const task = await repository.getTask(taskId);
        const turn = await repository.getTurn(turnId);
        expect(task).toBeTruthy();
        expect(turn).toBeTruthy();
        await stageDispositionForSettlement(repository, turn!, disposition);
        return repository.execute({
          kind: 'settleTurnAndApplyEffects',
          workspaceId: 'ws',
          expectedTaskRevision: task!.revision,
          task: { ...task!, updatedAt: finishedAt },
          turn: {
            ...turn!,
            status: 'succeeded',
            finishedAt,
            disposition,
          },
          expectedStatuses: ['running'],
          relatedTurns: [],
          messages: [],
        });
      };

      // Producers fill the fan-in gate and activate the consumer.
      expect((await settleSucceeded(p1.taskId, p1.activationTurnId, {
        kind: 'workflow_next', change: 'updated', result: 'p1-v1',
      }, '2026-07-19T00:01:00.000Z')).changed).toBe(true);
      expect((await settleSucceeded(p2.taskId, p2.activationTurnId, {
        kind: 'workflow_next', change: 'updated', result: 'p2-v1',
      }, '2026-07-19T00:02:00.000Z')).changed).toBe(true);

      const consumerNode = await client.get(
        'SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ? AND node_id = ?',
        ['ws', data.runId, 'consumer'],
      );
      const consumerTaskId = consumerNode!.task_id as string;
      const consumerTurns = await repository.listTurns(consumerTaskId);
      expect(consumerTurns).toHaveLength(1);
      const consumerActivationTurnId = consumerTurns[0]!.id;

      // Consumer PREV all → open one round + one feedback turn per producer FIFO.
      const prev = await settleSucceeded(consumerTaskId, consumerActivationTurnId, {
        kind: 'workflow_prev',
        targets: 'all',
        note: 'please revise',
      }, '2026-07-19T00:03:00.000Z');
      expect(prev.ok).toBe(true);
      expect(prev.changed).toBe(true);

      const rounds = await client.all(
        `SELECT round_id, requester_node_id, status, join_mode
           FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      );
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({
        requester_node_id: 'consumer',
        status: 'open',
        join_mode: 'all',
      });
      const roundId = rounds[0]!.round_id as string;

      const targets = await client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', data.runId, roundId],
      );
      expect(targets).toEqual([
        { target_node_id: 'p1', status: 'pending' },
        { target_node_id: 'p2', status: 'pending' },
      ]);

      const requestFences = await client.all(
        `SELECT kind, source_node_id, destination_node_id, body_json
           FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_request'
          ORDER BY destination_node_id`,
        ['ws', data.runId],
      );
      expect(requestFences).toHaveLength(2);
      for (const row of requestFences) {
        expect(row.source_node_id).toBe('consumer');
        const body = String(row.body_json);
        expect(body).toContain('feedback_request');
        expect(body).toContain(roundId);
        expect(body).not.toContain('please revise');
        expect(body).not.toMatch(/SELECT |INSERT |DELETE /i);
      }

      // Feedback turns append to existing producer FIFOs (sequence > activation).
      const p1TurnsAfterPrev = await repository.listTurns(p1.taskId);
      const p2TurnsAfterPrev = await repository.listTurns(p2.taskId);
      expect(p1TurnsAfterPrev).toHaveLength(2);
      expect(p2TurnsAfterPrev).toHaveLength(2);
      const p1Feedback = p1TurnsAfterPrev.find((t) => t.id !== p1.activationTurnId)!;
      const p2Feedback = p2TurnsAfterPrev.find((t) => t.id !== p2.activationTurnId)!;
      expect(p1Feedback.status).toBe('queued');
      expect(p1Feedback.trigger).toBe('engine');
      expect(p1Feedback.sequence).toBeGreaterThan(1);
      expect(p2Feedback.sequence).toBeGreaterThan(1);

      // Requester has no resume yet while round is partial.
      expect(await repository.listTurns(consumerTaskId)).toHaveLength(1);

      // PREV redelivery is a no-op (no second round/target/turn).
      await client.run(
        `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`,
        ['ws', `${consumerActivationTurnId}:*`],
      );
      await client.run(
        `UPDATE turns SET status = 'running', settled_at = NULL, started_at = ?
          WHERE workspace_id = ? AND id = ?`,
        ['2026-07-19T00:03:30.000Z', 'ws', consumerActivationTurnId],
      );
      const prevAgain = await settleSucceeded(consumerTaskId, consumerActivationTurnId, {
        kind: 'workflow_prev',
        targets: 'all',
        note: 'please revise again',
      }, '2026-07-19T00:03:30.000Z');
      expect(prevAgain.ok).toBe(true);
      expect(await client.all(
        `SELECT round_id FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).toHaveLength(1);
      expect(await repository.listTurns(p1.taskId)).toHaveLength(2);
      expect(await repository.listTurns(p2.taskId)).toHaveLength(2);

      // Foreign/empty PREV never opens a round (no additional rows).
      // Use a fresh consumer follow-up turn for an invalid PREV attempt.
      // (Consumer already settled; invalid PREV is tested via a second synthetic settle path
      // on a new queued turn created by a targeted-invalid request after responses.)

      // Partial response: p1 answers via workflow_next on its feedback turn.
      const partial = await settleSucceeded(p1.taskId, p1Feedback.id, {
        kind: 'workflow_next', change: 'updated', result: 'p1-v2',
      }, '2026-07-19T00:04:00.000Z');
      expect(partial.ok).toBe(true);
      expect(partial.changed).toBe(true);

      const targetsAfterPartial = await client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', data.runId, roundId],
      );
      expect(targetsAfterPartial).toEqual([
        { target_node_id: 'p1', status: 'responded' },
        { target_node_id: 'p2', status: 'pending' },
      ]);
      const roundAfterPartial = await client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', data.runId, roundId],
      );
      expect(roundAfterPartial).toMatchObject({ status: 'open' });
      expect(await repository.listTurns(consumerTaskId)).toHaveLength(1);

      // Feedback response is NOT a forward contribution (no second consumer activation from NEXT).
      const responseFencesPartial = await client.all(
        `SELECT kind FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_response'`,
        ['ws', data.runId],
      );
      expect(responseFencesPartial).toHaveLength(1);

      // Final response: p2 closes the ALL-join and queues one ordered resume.
      const final = await settleSucceeded(p2.taskId, p2Feedback.id, {
        kind: 'workflow_next', change: 'updated', result: 'p2-v2',
      }, '2026-07-19T00:05:00.000Z');
      expect(final.ok).toBe(true);
      expect(final.changed).toBe(true);

      const roundAfterFinal = await client.get(
        `SELECT status FROM workflow_feedback_rounds
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?`,
        ['ws', data.runId, roundId],
      );
      expect(roundAfterFinal).toMatchObject({ status: 'satisfied' });
      const targetsAfterFinal = await client.all(
        `SELECT target_node_id, status FROM workflow_feedback_targets
          WHERE workspace_id = ? AND run_id = ? AND round_id = ?
          ORDER BY target_node_id`,
        ['ws', data.runId, roundId],
      );
      expect(targetsAfterFinal.every((t) => t.status === 'responded')).toBe(true);

      const consumerTurnsAfter = await repository.listTurns(consumerTaskId);
      expect(consumerTurnsAfter).toHaveLength(2);
      const resume = consumerTurnsAfter.find((t) => t.id !== consumerActivationTurnId)!;
      expect(resume.status).toBe('queued');
      expect(resume.trigger).toBe('engine');
      expect(resume.sequence).toBeGreaterThan(consumerTurns[0]!.sequence);

      const resumeMessages = (await repository.listMessages(consumerTaskId))
        .filter((m) => m.turnId === resume.id);
      expect(resumeMessages).toHaveLength(1);
      const resumeContent = resumeMessages[0]!.content;
      expect(resumeContent.startsWith('[workflow-feedback-resume]')).toBe(true);
      // Frozen dependency declaration order: from_p1 then from_p2 (not arrival order).
      expect(resumeContent.indexOf('from_p1=')).toBeLessThan(resumeContent.indexOf('from_p2='));

      // Response redelivery after ledger prune is a no-op (no second resume).
      await client.run(
        `DELETE FROM operations WHERE workspace_id = ? AND ledger_key GLOB ?`,
        ['ws', `${p2Feedback.id}:*`],
      );
      await client.run(
        `UPDATE turns SET status = 'running', settled_at = NULL, started_at = ?
          WHERE workspace_id = ? AND id = ?`,
        ['2026-07-19T00:06:00.000Z', 'ws', p2Feedback.id],
      );
      const responseAgain = await settleSucceeded(p2.taskId, p2Feedback.id, {
        kind: 'workflow_next', change: 'updated', result: 'p2-v2-again',
      }, '2026-07-19T00:06:00.000Z');
      expect(responseAgain.ok).toBe(true);
      expect(await client.all(
        `SELECT message_id FROM workflow_routed_messages
          WHERE workspace_id = ? AND run_id = ? AND kind = 'feedback_response'`,
        ['ws', data.runId],
      )).toHaveLength(2);
      expect(await repository.listTurns(consumerTaskId)).toHaveLength(2);

      // Lifecycles stay open (PREV never seals requester or targets).
      expect((await repository.getTask(p1.taskId))?.lifecycle).toBe('open');
      expect((await repository.getTask(p2.taskId))?.lifecycle).toBe('open');
      expect((await repository.getTask(consumerTaskId))?.lifecycle).toBe('open');

      // Targeted PREV with foreign inputRef rejects without opening another round.
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        [createdAt, 'ws', resume.id],
      );
      const invalidPrev = await settleSucceeded(consumerTaskId, resume.id, {
        kind: 'workflow_prev',
        targets: ['not_a_binding'],
      }, '2026-07-19T00:07:00.000Z');
      expect(invalidPrev.ok).toBe(true);
      expect(await client.all(
        `SELECT round_id FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?`,
        ['ws', data.runId],
      )).toHaveLength(1);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);


  it('persists and reloads complete ordered canonical workflow authority', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-define-wf-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let reloadedClient: DbClient | undefined;
    try {
      const dbPath = path.join(dir, 'muster.sqlite3');
      const packagePromptPath = path.join(dir, 'prompts', 'left.md');
      fs.mkdirSync(path.dirname(packagePromptPath), { recursive: true });
      await client.open(dbPath);
      const repository = new SqliteTaskRepository(client, 'ws');
      const fixture = canonicalStorageFixture();
      fs.writeFileSync(packagePromptPath, fixture.topology.nodes[1].instructions.content);
      const validated = validateDefineWorkflow({
        ...fixture,
        policy: DEFAULT_WORKFLOW_POLICY,
      });
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const first = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
      });
      expect(first.ok).toBe(true);
      expect(first.changed).toBe(true);
      expect(first.operation?.fingerprint).toEqual(expect.any(String));

      await expect(client.get(
        `SELECT definition_id, version, name, description
           FROM workflow_definitions WHERE workspace_id = ? AND definition_id = ?`,
        ['ws', fixture.definitionId],
      )).resolves.toEqual({
        definition_id: fixture.definitionId,
        version: 1,
        name: fixture.name,
        description: fixture.topology.description,
      });
      await expect(client.all(
        `SELECT name, semantic_kind, entry_node_id, input_ref, ordinal, expected_artifact_kind
           FROM workflow_definition_inputs
          WHERE workspace_id = ? AND definition_id = ? ORDER BY ordinal`,
        ['ws', fixture.definitionId],
      )).resolves.toEqual([
        {
          name: 'rightRequest', semantic_kind: 'request.right', entry_node_id: 'right',
          input_ref: 'right_request', ordinal: 0, expected_artifact_kind: 'workflow_input',
        },
        {
          name: 'leftRequest', semantic_kind: 'request.left', entry_node_id: 'left',
          input_ref: 'left_request', ordinal: 1, expected_artifact_kind: 'workflow_input',
        },
      ]);
      await expect(client.all(
        `SELECT name, semantic_kind, terminal_node_id, ordinal, expected_artifact_kind
           FROM workflow_definition_outputs
          WHERE workspace_id = ? AND definition_id = ? ORDER BY ordinal`,
        ['ws', fixture.definitionId],
      )).resolves.toEqual([
        { name: 'publishedResult', semantic_kind: 'result.published', terminal_node_id: 'publish', ordinal: 0, expected_artifact_kind: 'next_result' },
        { name: 'checkedResult', semantic_kind: 'result.checked', terminal_node_id: 'check', ordinal: 1, expected_artifact_kind: 'next_result' },
      ]);
      await expect(client.all(
        `SELECT node_id, ordinal, title, instructions_kind, instructions_file,
                instructions_content, instructions_sha256, execution_kind, script_interpreter,
                script_file, script_args_json, script_package_path, script_package_sha256,
                script_sha256, outcome_kind
           FROM workflow_definition_nodes
          WHERE workspace_id = ? AND definition_id = ? ORDER BY ordinal`,
        ['ws', fixture.definitionId],
      )).resolves.toEqual([
        expect.objectContaining({ node_id: 'right', ordinal: 0, title: 'Right display title', outcome_kind: 'agent' }),
        expect.objectContaining({
          node_id: 'left', ordinal: 1, instructions_kind: 'file', instructions_file: 'prompts/left.md',
          instructions_content: fixture.topology.nodes[1].instructions.content,
          instructions_sha256: fixture.topology.nodes[1].instructions.sha256,
          outcome_kind: 'agent',
        }),
        expect.objectContaining({
          node_id: 'publish', ordinal: 2, instructions_kind: 'inline',
          instructions_content: fixture.topology.nodes[2].instructions.content,
          outcome_kind: 'agent',
        }),
        expect.objectContaining({
          node_id: 'check', ordinal: 3, execution_kind: 'script', script_interpreter: 'node',
          script_file: 'scripts/check.js', script_args_json: '["--strict","left"]',
          script_package_path: 'canonical-storage', script_package_sha256: 'a'.repeat(64),
          script_sha256: 'b'.repeat(64), outcome_kind: 'exit',
        }),
      ]);
      await expect(repository.getWorkflowDefinition(fixture.definitionId, 1)).resolves.toEqual(
        validated.definition,
      );

      const replay = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
        createdAt: '2099-01-01T00:00:00.000Z',
      });
      expect(replay.ok).toBe(true);
      expect(replay.changed).toBe(false);
      expect(await client.all(
        'SELECT definition_id FROM workflow_definitions WHERE workspace_id = ?',
        ['ws'],
      )).toHaveLength(1);

      const conflict = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
        name: 'Canonical storage workflow changed',
      });
      expect(conflict.ok).toBe(false);
      expect(conflict.conflict).toBe(true);
      expect(conflict.reason).toMatch(/fingerprint conflict|definition fingerprint conflict/);
      await expect(client.get(
        'SELECT name FROM workflow_definitions WHERE workspace_id = ? AND definition_id = ?',
        ['ws', fixture.definitionId],
      )).resolves.toEqual({ name: fixture.name });

      fs.writeFileSync(packagePromptPath, 'MUTATED package instructions that must not execute.');
      await client.close();
      reloadedClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await reloadedClient.open(dbPath);
      const reloadedRepository = new SqliteTaskRepository(reloadedClient, 'ws');
      await expect(reloadedRepository.getWorkflowDefinition(fixture.definitionId, 1)).resolves.toEqual(
        validated.definition,
      );
      const caller = { ...makeTask('canonical-storage-caller'), role: 'coordinator' as const };
      await reloadedRepository.execute({ kind: 'createTask', workspaceId: 'ws', task: caller });
      await reloadedRepository.execute({
        kind: 'createTurn',
        workspaceId: 'ws',
        turn: {
          id: 'canonical-storage-caller-turn',
          taskId: caller.id,
          sequence: 1,
          status: 'running',
          trigger: 'user',
          inputs: [],
          createdAt: '2026-08-31T00:00:00.500Z',
        },
      });
      const started = await reloadedRepository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: fixture.definitionId,
        version: 1,
        startIdempotencyKey: 'canonical-storage-reload-start',
        createdAt: '2026-08-31T00:00:01.000Z',
        entryInputs: [
          { entryNodeId: 'right', inputRef: 'right_request', kind: 'workflow_input', value: 'right value' },
          { entryNodeId: 'left', inputRef: 'left_request', kind: 'workflow_input', value: 'left value' },
        ],
        ownerRootTaskId: caller.id,
        callerTaskId: caller.id,
        callerTurnId: 'canonical-storage-caller-turn',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const startedData = started.operation?.result?.data as {
        runId: string;
        entries: Array<{ nodeId: string; taskId: string; activationTurnId: string }>;
      };
      const leftEntry = startedData.entries.find((entry) => entry.nodeId === 'left')!;
      const leftTask = await reloadedRepository.getTask(leftEntry.taskId);
      const leftTurn = await reloadedRepository.getTurn(leftEntry.activationTurnId);
      expect(leftTask?.goal).not.toContain('Left display title');
      expect(leftTurn?.workflowInstructions).toBe(fixture.topology.nodes[1].instructions.content);
      const entryPrompt = compileTaskPrompt(
        synthesizeBriefFromGoal(leftTask!.goal),
        [],
        { goal: leftTask!.goal, workflowInstructions: leftTurn!.workflowInstructions },
      );
      expect(entryPrompt).toContain(fixture.topology.nodes[1].instructions.content);
      expect(entryPrompt).not.toContain('MUTATED package instructions');
      expect(entryPrompt).not.toContain('Left display title');

      const rightEntry = startedData.entries.find((entry) => entry.nodeId === 'right')!;
      await reloadedClient.run(
        `UPDATE turns SET status = 'running', started_at = ? WHERE workspace_id = ? AND id = ?`,
        ['2026-08-31T00:00:02.000Z', 'ws', rightEntry.activationTurnId],
      );
      const rightTask = await reloadedRepository.getTask(rightEntry.taskId);
      const rightTurn = await reloadedRepository.getTurn(rightEntry.activationTurnId);
      const rightDisposition = {
        kind: 'workflow_next' as const,
        change: 'updated' as const,
        result: 'right branch result',
      };
      await stageDispositionForSettlement(reloadedRepository, rightTurn!, rightDisposition);
      await expect(reloadedRepository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: rightTask!.revision,
        task: { ...rightTask!, updatedAt: '2026-08-31T00:00:03.000Z' },
        turn: {
          ...rightTurn!,
          status: 'succeeded',
          finishedAt: '2026-08-31T00:00:03.000Z',
          disposition: rightDisposition,
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      })).resolves.toMatchObject({ ok: true, changed: true });
      const publishNode = await reloadedClient.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'publish'`,
        ['ws', startedData.runId],
      );
      const publishTurn = (await reloadedRepository.listTurns(publishNode!.task_id))[0]!;
      expect(publishTurn.workflowInstructions).toBe(fixture.topology.nodes[2].instructions.content);
      const dependencyPrompt = compileTaskPrompt(
        synthesizeBriefFromGoal((await reloadedRepository.getTask(publishNode!.task_id))!.goal),
        [],
        { workflowInstructions: publishTurn.workflowInstructions },
      );
      expect(dependencyPrompt).toContain(fixture.topology.nodes[2].instructions.content);
      expect(dependencyPrompt).not.toContain('Publish display title');
    } finally {
      await reloadedClient?.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('records a new public operation as a read-only replay of identical canonical authority', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-public-define-replay-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const fixture = canonicalStorageFixture('wf-public-define-replay');
      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
        publicOperation: { ledgerKey: 'turn-a:define', fingerprint: 'public-fingerprint-a' },
      })).resolves.toMatchObject({ ok: true, changed: true });

      const replay = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
        createdAt: '2026-08-31T00:00:01.000Z',
        publicOperation: { ledgerKey: 'turn-b:define', fingerprint: 'public-fingerprint-b' },
      });
      expect(replay).toMatchObject({ ok: true, changed: false });
      await expect(client.get<{ fingerprint: string; result_json: string }>(
        'SELECT fingerprint, result_json FROM operations WHERE workspace_id = ? AND ledger_key = ?',
        ['ws', 'turn-b:define'],
      )).resolves.toEqual({
        fingerprint: 'public-fingerprint-b',
        result_json: expect.stringContaining('"replay":true'),
      });
      await expect(client.get(
        'SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id = ? AND definition_id = ?',
        ['ws', fixture.definitionId],
      )).resolves.toEqual({ count: 1 });

      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
        name: 'Conflicting canonical authority',
        publicOperation: { ledgerKey: 'turn-c:define', fingerprint: 'public-fingerprint-c' },
      })).resolves.toMatchObject({ ok: false, changed: false, conflict: true });
      await expect(client.get(
        'SELECT ledger_key FROM operations WHERE workspace_id = ? AND ledger_key = ?',
        ['ws', 'turn-c:define'],
      )).resolves.toBeUndefined();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('persists frozen instructions on feedback request and resume turns across reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-feedback-instructions-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const promptPath = path.join(dir, 'prompts', 'producer.md');
    const producerInstructions = 'Use the frozen producer instructions for every correction turn.';
    const consumerInstructions = 'Use the frozen consumer instructions after feedback returns.';
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, producerInstructions);
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let reloadedClient: DbClient | undefined;
    try {
      await client.open(dbPath);
      const repository = new SqliteTaskRepository(client, 'ws');
      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-feedback-instructions',
        version: 1,
        name: 'Feedback instructions',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'consumer' }],
          nodes: [
            {
              nodeId: 'producer',
              instructions: {
                kind: 'file',
                file: 'prompts/producer.md',
                content: producerInstructions,
                sha256: sha256(producerInstructions),
              },
              outcome: {
                kind: 'agent',
                requireExplicitDisposition: true,
                next: { when: 'The producer result is ready.' },
              },
            },
            {
              nodeId: 'consumer',
              instructions: {
                kind: 'inline',
                content: consumerInstructions,
                sha256: sha256(consumerInstructions),
              },
              outcome: {
                kind: 'agent',
                requireExplicitDisposition: true,
                next: { when: 'The consumer result is ready.' },
                prev: [{
                  when: 'The producer result needs correction.',
                  targets: ['producer_result'],
                  feedback: 'required',
                }],
              },
            },
          ],
          edges: [{
            fromNodeId: 'producer',
            toNodeId: 'consumer',
            inputRef: 'producer_result',
            expectedArtifactKind: 'next_result',
          }],
        },
        createdAt: '2026-08-31T01:00:00.000Z',
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-feedback-instructions',
        version: 1,
        startIdempotencyKey: 'feedback-instructions-start',
        createdAt: '2026-08-31T01:00:01.000Z',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const data = started.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      await expect(settleWorkflowTurnSucceeded(
        repository,
        client,
        data.entryTaskId,
        data.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'producer-v1' },
        '2026-08-31T01:00:02.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });
      const consumerNode = await client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'consumer'`,
        ['ws', data.runId],
      );
      const consumerTurn = (await repository.listTurns(consumerNode!.task_id))[0]!;
      await expect(settleWorkflowTurnSucceeded(
        repository,
        client,
        consumerNode!.task_id,
        consumerTurn.id,
        { kind: 'workflow_prev', targets: ['producer_result'], note: 'revise producer' },
        '2026-08-31T01:00:03.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });

      fs.writeFileSync(promptPath, 'MUTATED producer instructions that must not be loaded.');
      await client.close();
      reloadedClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await reloadedClient.open(dbPath);
      const reloadedRepository = new SqliteTaskRepository(reloadedClient, 'ws');
      const producerFeedbackTurn = (await reloadedRepository.listTurns(data.entryTaskId))
        .find((turn) => turn.id !== data.activationTurnId)!;
      expect(producerFeedbackTurn.workflowInstructions).toBe(producerInstructions);
      await expect(settleWorkflowTurnSucceeded(
        reloadedRepository,
        reloadedClient,
        data.entryTaskId,
        producerFeedbackTurn.id,
        { kind: 'workflow_next', change: 'updated', result: 'producer-v2' },
        '2026-08-31T01:00:04.000Z',
      )).resolves.toMatchObject({ ok: true, changed: true });
      const consumerResume = (await reloadedRepository.listTurns(consumerNode!.task_id))
        .find((turn) => turn.id !== consumerTurn.id)!;
      expect(consumerResume.workflowInstructions).toBe(consumerInstructions);
      const resumedPrompt = compileTaskPrompt(
        synthesizeBriefFromGoal((await reloadedRepository.getTask(consumerNode!.task_id))!.goal),
        [],
        { workflowInstructions: consumerResume.workflowInstructions },
      );
      expect(resumedPrompt).toContain(consumerInstructions);
      expect(resumedPrompt).not.toContain('MUTATED producer instructions');
    } finally {
      await reloadedClient?.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed when any canonical definition authority is corrupted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-corrupt-wf-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      const repository = new SqliteTaskRepository(client, 'ws');
      const cases: Array<{
        suffix: string;
        trigger: string;
        sql: string;
        params: string[];
      }> = [
        {
          suffix: 'definition',
          trigger: 'trg_workflow_definition_semantics_immutable',
          sql: `UPDATE workflow_definitions SET description = 'corrupt description'
                 WHERE workspace_id = ? AND definition_id = ?`,
          params: [],
        },
        {
          suffix: 'definition-scope',
          trigger: 'trg_workflow_definition_semantics_immutable',
          sql: `UPDATE workflow_definitions SET owner_root_task_id = 'corrupt-owner'
                 WHERE workspace_id = ? AND definition_id = ?`,
          params: [],
        },
        {
          suffix: 'input',
          trigger: 'trg_workflow_definition_inputs_immutable_update',
          sql: `UPDATE workflow_definition_inputs SET semantic_kind = 'corrupt.input'
                 WHERE workspace_id = ? AND definition_id = ? AND ordinal = 0`,
          params: [],
        },
        {
          suffix: 'output',
          trigger: 'trg_workflow_definition_outputs_immutable_update',
          sql: `UPDATE workflow_definition_outputs SET semantic_kind = 'corrupt.output'
                 WHERE workspace_id = ? AND definition_id = ? AND ordinal = 0`,
          params: [],
        },
        {
          suffix: 'outcome',
          trigger: 'trg_workflow_definition_nodes_immutable_update',
          sql: `UPDATE workflow_definition_nodes
                   SET outcome_json = '{"kind":"agent","requireExplicitDisposition":true,"next":{"when":"Corrupt but valid."}}'
                 WHERE workspace_id = ? AND definition_id = ? AND node_id = 'publish'`,
          params: [],
        },
        {
          suffix: 'instructions',
          trigger: 'trg_workflow_definition_nodes_immutable_update',
          sql: `UPDATE workflow_definition_nodes SET instructions_sha256 = ?
                 WHERE workspace_id = ? AND definition_id = ? AND node_id = 'left'`,
          params: ['f'.repeat(64)],
        },
        {
          suffix: 'edge',
          trigger: 'trg_workflow_definition_edges_immutable_update',
          sql: `UPDATE workflow_definition_edges SET destination_input_ref = 'corrupt_edge'
                 WHERE workspace_id = ? AND definition_id = ? AND ordinal = 0`,
          params: [],
        },
      ];
      const dropped = new Set<string>();
      for (const testCase of cases) {
        const fixture = canonicalStorageFixture(`wf-corrupt-${testCase.suffix}`);
        await expect(repository.execute({
          kind: 'defineWorkflowVersion',
          workspaceId: 'ws',
          ...fixture,
        })).resolves.toMatchObject({ ok: true, changed: true });
        if (!dropped.has(testCase.trigger)) {
          await client.run(`DROP TRIGGER ${testCase.trigger}`);
          dropped.add(testCase.trigger);
        }
        await client.run(testCase.sql, [
          ...testCase.params,
          'ws',
          fixture.definitionId,
        ]);
        await expect(repository.getWorkflowDefinition(fixture.definitionId, 1)).resolves.toBeUndefined();
      }

      const corruptStart = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-corrupt-output',
        version: 1,
        startIdempotencyKey: 'corrupt-output-start',
        createdAt: '2026-08-31T00:00:02.000Z',
        entryInputs: [
          { entryNodeId: 'right', inputRef: 'right_request', kind: 'workflow_input', value: 'right value' },
          { entryNodeId: 'left', inputRef: 'left_request', kind: 'workflow_input', value: 'left value' },
        ],
      });
      expect(corruptStart).toMatchObject({ ok: false, changed: false });
      await expect(client.get(
        'SELECT COUNT(*) AS count FROM workflow_runs WHERE workspace_id = ?',
        ['ws'],
      )).resolves.toEqual({ count: 0 });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('denies a queued activation claim when its definition is corrupted after start and reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-active-corruption-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let reloadedClient: DbClient | undefined;
    try {
      await client.open(dbPath);
      const repository = new SqliteTaskRepository(client, 'ws');
      const definitionId = 'wf-active-corruption';
      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId,
        version: 1,
        name: 'Active corruption',
        topology: makeOneNodeDefinition({ definitionId, name: 'Active corruption' }).topology,
        createdAt: '2026-08-31T02:00:00.000Z',
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId,
        version: 1,
        startIdempotencyKey: 'active-corruption-start',
        createdAt: '2026-08-31T02:00:00.000Z',
      });
      expect(started).toMatchObject({ ok: true, changed: true });
      const data = started.operation?.result?.data as {
        entryTaskId: string;
        activationTurnId: string;
      };
      await client.close();

      reloadedClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await reloadedClient.open(dbPath);
      const reloadedRepository = new SqliteTaskRepository(reloadedClient, 'ws');
      await reloadedClient.run('DROP TRIGGER trg_workflow_definition_outputs_immutable_update');
      await reloadedClient.run(
        `UPDATE workflow_definition_outputs SET semantic_kind = 'corrupt.active.output'
          WHERE workspace_id = ? AND definition_id = ? AND ordinal = 0`,
        ['ws', definitionId],
      );
      await expect(reloadedRepository.getWorkflowDefinition(definitionId, 1)).resolves.toBeUndefined();
      const corruptedTask = await reloadedRepository.getTask(data.entryTaskId);
      const corruptedTurn = await reloadedRepository.getTurn(data.activationTurnId);
      await expect(reloadedRepository.execute({
        kind: 'prepareDispatch',
        workspaceId: 'ws',
        expectedTaskRevision: corruptedTask!.revision,
        task: corruptedTask!,
        turn: {
          ...corruptedTurn!,
          status: 'running',
          startedAt: '2026-08-31T02:00:01.000Z',
          dispatchPhase: 'pre_dispatch',
        },
        messages: [],
        startedAt: '2026-08-31T02:00:01.000Z',
        rootTaskId: data.entryTaskId,
        maxConcurrentTurns: 10,
        maxConcurrentPerRoot: 10,
        maxConcurrentPerBackend: 10,
        sessionId: 'corrupt-definition-session',
        resourceKeys: [],
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(reloadedRepository.execute({
        kind: 'claimTurn',
        workspaceId: 'ws',
        turnId: data.activationTurnId,
        startedAt: '2026-08-31T02:00:01.000Z',
        rootTaskId: data.entryTaskId,
        maxConcurrentTurns: 10,
        maxConcurrentPerRoot: 10,
        maxConcurrentPerBackend: 10,
        sessionId: 'corrupt-definition-session',
        resourceKeys: [],
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(reloadedRepository.getTurn(data.activationTurnId)).resolves.toMatchObject({
        status: 'queued',
      });
      await expect(reloadedClient.get(
        'SELECT session_id FROM session_claims WHERE workspace_id = ? AND turn_id = ?',
        ['ws', data.activationTurnId],
      )).resolves.toBeUndefined();
    } finally {
      await reloadedClient?.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rehydrates frozen file instructions for activation recovery after reload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-recovery-instructions-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const promptPath = path.join(dir, 'prompts', 'recovery.md');
    const instructions = 'Use the frozen recovery instructions after reopening the store.';
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, instructions);
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    let reloadedClient: DbClient | undefined;
    try {
      await client.open(dbPath);
      const repository = new SqliteTaskRepository(client, 'ws');
      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-recovery-instructions',
        version: 1,
        name: 'Recovery instructions',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
          nodes: [{
            nodeId: 'entry',
            instructions: {
              kind: 'file',
              file: 'prompts/recovery.md',
              content: instructions,
              sha256: sha256(instructions),
            },
          }],
          edges: [],
        },
        createdAt: '2026-08-31T03:00:00.000Z',
      })).resolves.toMatchObject({ ok: true, changed: true });
      const started = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-recovery-instructions',
        version: 1,
        startIdempotencyKey: 'recovery-instructions-start',
        createdAt: '2026-08-31T03:00:01.000Z',
      });
      const data = started.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      const activation = await client.get<{ activation_id: string }>(
        `SELECT activation_id FROM workflow_activations
          WHERE workspace_id = ? AND run_id = ? AND execution_turn_id = ?`,
        ['ws', data.runId, data.activationTurnId],
      );
      await client.run(
        `UPDATE turns SET status = 'failed', settled_at = ?
          WHERE workspace_id = ? AND id = ?`,
        ['2026-08-31T03:00:02.000Z', 'ws', data.activationTurnId],
      );
      await client.run(
        `UPDATE workflow_activations SET status = 'failed', updated_at = ?
          WHERE workspace_id = ? AND run_id = ? AND activation_id = ?`,
        ['2026-08-31T03:00:02.000Z', 'ws', data.runId, activation!.activation_id],
      );
      fs.writeFileSync(promptPath, 'MUTATED recovery instructions that must not be loaded.');
      await client.close();

      reloadedClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await reloadedClient.open(dbPath);
      const reloadedRepository = new SqliteTaskRepository(reloadedClient, 'ws');
      const recovered = await reloadedRepository.execute({
        kind: 'recoverWorkflowActivation',
        workspaceId: 'ws',
        runId: data.runId,
        activationId: activation!.activation_id,
        failedTurnId: data.activationTurnId,
        recoveryOperationId: 'recovery-instructions-op',
        fingerprint: 'recovery-instructions-fingerprint',
        instruction: 'Retry the same activation.',
        expectedActivationStatus: 'failed',
        createdAt: '2026-08-31T03:00:03.000Z',
      });
      expect(recovered).toMatchObject({ ok: true, changed: true });
      const recoveredTurnId = (recovered.operation?.result as { ok: true; data: { turnId: string } }).data.turnId;
      const recoveredTurn = await reloadedRepository.getTurn(recoveredTurnId);
      expect(recoveredTurn?.workflowInstructions).toBe(instructions);
      const recoveryPrompt = compileTaskPrompt(
        synthesizeBriefFromGoal((await reloadedRepository.getTask(data.entryTaskId))!.goal),
        [],
        { workflowInstructions: recoveredTurn?.workflowInstructions },
      );
      expect(recoveryPrompt).toContain(instructions);
      expect(recoveryPrompt).not.toContain('MUTATED recovery instructions');
    } finally {
      await reloadedClient?.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rolls back the operation claim and every authority row on a definition transaction fault', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-rollback-wf-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({
      workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
      execArgv: ['--import', 'tsx'],
      faultCapability: true,
      faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
    });
    let checkClient: DbClient | undefined;
    try {
      await client.open(dbPath);
      const repository = new SqliteTaskRepository(client, 'ws');
      const fixture = canonicalStorageFixture('wf-transaction-fault');
      await expect(repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        ...fixture,
      })).rejects.toMatchObject({ code: 'full' });
      await client.close();
      checkClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
      });
      await checkClient.open(dbPath);
      for (const table of [
        'operations',
        'workflow_definitions',
        'workflow_definition_inputs',
        'workflow_definition_outputs',
        'workflow_definition_nodes',
        'workflow_definition_edges',
      ]) {
        await expect(checkClient.get(
          `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`,
          ['ws'],
        )).resolves.toEqual({ count: 0 });
      }
    } finally {
      await checkClient?.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);






  it('M018 S05 fail-fast closure: workflow_fail closes the run and owned task once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-s05-fail-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 's05-fail', 'S05 Fail', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const createdAt = '2026-07-20T00:00:00.000Z';
      const topology = makeOneNodeDefinition({
        definitionId: 'wf-s05', name: 's05-one', createdAt,
      }).topology;
      const def = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-s05',
        version: 1,
        name: 's05-one',
        topology,
        createdAt,
      });
      expect(def.ok).toBe(true);
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-s05',
        version: 1,
        startIdempotencyKey: 's05-fail-1',
        createdAt,
        goal: 's05 fail goal',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      const data = start.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };
      expect(data.runId).toBeTruthy();

      // Promote queued -> running via direct SQL (S04 settleSucceeded pattern).
      const finishedAt = '2026-07-20T00:00:01.000Z';
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL WHERE workspace_id = ? AND id = ?`,
        [createdAt, 'ws', data.activationTurnId],
      );
      const task = await repository.getTask(data.entryTaskId);
      const turn = await repository.getTurn(data.activationTurnId);
      expect(task).toBeTruthy();
      expect(turn).toBeTruthy();
      const disposition = { kind: 'workflow_fail' as const, reason: 'agent gave up' };
      await stageDispositionForSettlement(repository, turn!, disposition);

      const settle = await repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: task!.revision,
        task: { ...task!, updatedAt: finishedAt },
        turn: {
          ...turn!,
          status: 'succeeded',
          finishedAt,
          disposition,
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      });
      expect(settle.ok).toBe(true);
      expect(settle.changed).toBe(true);

      const runRows = await client.all<{ status: string }>(
        'SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?',
        ['ws', data.runId],
      );
      expect(runRows[0]?.status).toBe('failed');

      const after = await repository.getTask(data.entryTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        finishedAt,
        error: 'agent_fail',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(after?.attention).toBeUndefined();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('M018 S05 invalid PREV route closes the failed run and owned task', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-repository-s05-prev-'));
    const client = new DbClient({ workerPath: path.join(__dirname, 'sqlite', 'worker.ts'), execArgv: ['--import', 'tsx'] });
    try {
      await client.open(path.join(dir, 'muster.sqlite3'));
      await client.run(
        `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
        ['ws', 's05-prev', 'S05 Prev', 'now', 'now'],
      );
      const repository = new SqliteTaskRepository(client, 'ws');
      const createdAt = '2026-07-20T00:00:00.000Z';
      const topology = makeOneNodeDefinition({
        definitionId: 'wf-s05-prev', name: 's05-prev', createdAt,
      }).topology;
      const def = await repository.execute({
        kind: 'defineWorkflowVersion',
        workspaceId: 'ws',
        definitionId: 'wf-s05-prev',
        version: 1,
        name: 's05-prev',
        topology,
        createdAt,
      });
      expect(def.ok).toBe(true);
      const start = await repository.execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: 'wf-s05-prev',
        version: 1,
        startIdempotencyKey: 's05-prev-1',
        createdAt,
        goal: 's05 prev invalid',
        backend: 'grok',
      });
      expect(start.ok).toBe(true);
      const data = start.operation?.result?.data as {
        runId: string;
        entryTaskId: string;
        activationTurnId: string;
      };

      const finishedAt = '2026-07-20T00:00:01.000Z';
      await client.run(
        `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL WHERE workspace_id = ? AND id = ?`,
        [createdAt, 'ws', data.activationTurnId],
      );
      const task = await repository.getTask(data.entryTaskId);
      const turn = await repository.getTurn(data.activationTurnId);
      expect(task).toBeTruthy();
      expect(turn).toBeTruthy();
      const disposition = { kind: 'workflow_prev' as const, targets: 'all' as const };
      await stageDispositionForSettlement(repository, turn!, disposition);

      const settle = await repository.execute({
        kind: 'settleTurnAndApplyEffects',
        workspaceId: 'ws',
        expectedTaskRevision: task!.revision,
        task: { ...task!, updatedAt: finishedAt },
        turn: {
          ...turn!,
          status: 'succeeded',
          finishedAt,
          // Entry PREV with no direct producers -> invalid_route fail closure.
          disposition,
        },
        expectedStatuses: ['running'],
        relatedTurns: [],
        messages: [],
      });
      expect(settle.ok).toBe(true);
      const runRows = await client.all<{ status: string }>(
        'SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?',
        ['ws', data.runId],
      );
      expect(runRows[0]?.status).toBe('failed');
      const after = await repository.getTask(data.entryTaskId);
      expect(after).toMatchObject({
        lifecycle: 'failed',
        finishedAt,
        error: 'invalid_route',
        lifecycleAuthority: { kind: 'workflow', runId: data.runId },
      });
      expect(after?.attention).toBeUndefined();
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);


});
