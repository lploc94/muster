import { expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask, TurnDisposition } from './types';
import type { WorkflowPolicy, WorkflowTopology } from './workflow-types';

export const NAMED_WORKSPACE_ID = 'ws';
export const NAMED_NOW = '2026-08-01T00:00:00.000Z';

export type NamedWorkflowHarness = {
  dir: string;
  dbPath: string;
  client: DbClient;
  repository: SqliteTaskRepository;
  nextTimestamp: () => string;
  close: () => Promise<void>;
};

function rootTask(taskId: string, at: string): MusterTask {
  return {
    id: taskId,
    role: 'coordinator',
    lifecycle: 'open',
    releaseState: 'released',
    goal: 'coordinate named workflow composition',
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 40, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: at,
    updatedAt: at,
    releasedAt: at,
  };
}

export async function addRootAuthority(
  harness: NamedWorkflowHarness,
  taskId: string,
  turnId: string,
): Promise<void> {
  const at = harness.nextTimestamp();
  await harness.repository.execute({
    kind: 'createTask',
    workspaceId: NAMED_WORKSPACE_ID,
    task: rootTask(taskId, at),
  });
  await harness.repository.execute({
    kind: 'createTurn',
    workspaceId: NAMED_WORKSPACE_ID,
    turn: {
      id: turnId,
      taskId,
      sequence: 1,
      status: 'running',
      trigger: 'user',
      inputs: [],
      createdAt: at,
      startedAt: at,
    },
  });
}

export async function openNamedWorkflowHarness(label: string): Promise<NamedWorkflowHarness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `muster-named-composition-${label}-`));
  const dbPath = path.join(dir, 'muster.sqlite3');
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(dbPath);
  let tick = 0;
  const nextTimestamp = () => `2026-08-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
  const repository = new SqliteTaskRepository(client, NAMED_WORKSPACE_ID);
  const harness: NamedWorkflowHarness = {
    dir,
    dbPath,
    client,
    repository,
    nextTimestamp,
    async close() {
      await harness.client.close().catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES (?,?,?,?,?)`,
    [NAMED_WORKSPACE_ID, `named-${label}`, `Named composition ${label}`, NAMED_NOW, NAMED_NOW],
  );
  await addRootAuthority(harness, 'root-task', 'root-turn');
  return harness;
}

export async function reopenNamedWorkflowHarness(
  harness: NamedWorkflowHarness,
): Promise<void> {
  await harness.client.close().catch(() => undefined);
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(harness.dbPath);
  harness.client = client;
  harness.repository = new SqliteTaskRepository(client, NAMED_WORKSPACE_ID);
}

export async function defineCanonicalWorkflow(
  harness: NamedWorkflowHarness,
  input: {
    definitionId: string;
    topology: WorkflowTopology;
    name?: string;
    policy?: WorkflowPolicy;
    scope?: { kind: 'workspace' } | { kind: 'root'; ownerRootTaskId: string };
  },
): Promise<void> {
  const entryContracts = input.topology.inputs.map((declared) => ({
    entryNodeId: declared.entryNodeId,
    inputRef: declared.inputRef,
    expectedArtifactKind: 'workflow_input' as const,
  }));
  await expect(harness.repository.execute({
    kind: 'defineWorkflowVersion',
    workspaceId: NAMED_WORKSPACE_ID,
    definitionId: input.definitionId,
    version: 1,
    name: input.name ?? input.definitionId,
    topology: input.topology,
    ...(entryContracts.length > 0 ? { entryContracts } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    createdAt: harness.nextTimestamp(),
  })).resolves.toMatchObject({ ok: true, changed: true });
}

export async function defineOneNodeProducer(
  harness: NamedWorkflowHarness,
  definitionId: string,
  semanticKind: string = 'plan',
  outputName: string = 'plan',
): Promise<void> {
  await defineCanonicalWorkflow(harness, {
    definitionId,
    topology: {
      kind: 'workflow',
      inputs: [],
      outputs: [{ name: outputName, semanticKind, sourceNodeId: 'entry' }],
      nodes: [{
        nodeId: 'entry',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The producer result is ready.' },
          fail: { when: 'The producer cannot complete.' },
        },
      }],
      edges: [],
    },
  });
}

export async function defineOneNodeConsumer(
  harness: NamedWorkflowHarness,
  definitionId: string,
  inputs: ReadonlyArray<{ name: string; semanticKind: string; inputRef?: string }>,
): Promise<void> {
  await defineCanonicalWorkflow(harness, {
    definitionId,
    topology: {
      kind: 'workflow',
      inputs: inputs.map((declared) => ({
        name: declared.name,
        semanticKind: declared.semanticKind,
        entryNodeId: 'entry',
        inputRef: declared.inputRef ?? declared.name,
      })),
      outputs: [{ name: 'result', semanticKind: 'result', sourceNodeId: 'entry' }],
      nodes: [{
        nodeId: 'entry',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The consumer result is ready.' },
          fail: { when: 'The consumer cannot complete.' },
        },
      }],
      edges: [],
    },
  });
}

export async function startWorkflow(
  harness: NamedWorkflowHarness,
  input: {
    definitionId: string;
    key: string;
    inputs?: readonly (
      | { name: string; value: string }
      | { name: string; fromRun: string; output: string }
    )[];
    ownerRootTaskId?: string;
    callerTaskId?: string;
    callerTurnId?: string;
    resumeCallerOnCompletion?: boolean;
    createdAt?: string;
  },
) {
  return harness.repository.execute({
    kind: 'startWorkflowRun',
    workspaceId: NAMED_WORKSPACE_ID,
    definitionId: input.definitionId,
    version: 1,
    startIdempotencyKey: input.key,
    createdAt: input.createdAt ?? harness.nextTimestamp(),
    ...(input.inputs ? { inputs: input.inputs } : {}),
    ownerRootTaskId: input.ownerRootTaskId ?? 'root-task',
    callerTaskId: input.callerTaskId ?? 'root-task',
    callerTurnId: input.callerTurnId ?? 'root-turn',
    ...(input.resumeCallerOnCompletion === true ? { resumeCallerOnCompletion: true } : {}),
  });
}

export type StartedWorkflow = {
  runId: string;
  entries: Array<{
    nodeId: string;
    taskId: string;
    gateId: string;
    activationTurnId: string;
  }>;
  entryTaskId: string;
  activationTurnId: string;
  entryGateId: string;
};

export function startedData(result: Awaited<ReturnType<typeof startWorkflow>>): StartedWorkflow {
  expect(result).toMatchObject({ ok: true, changed: true });
  return result.operation!.result.data as StartedWorkflow;
}

export async function settleWorkflowTurn(
  harness: NamedWorkflowHarness,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
): Promise<void> {
  const startedAt = harness.nextTimestamp();
  await harness.client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    [startedAt, NAMED_WORKSPACE_ID, turnId],
  );
  const task = await harness.repository.getTask(taskId);
  const turn = await harness.repository.getTurn(turnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  await expect(stageDispositionForSettlement(
    harness.repository,
    turn!,
    disposition,
    `stage:${turnId}`,
  )).resolves.toMatchObject({ ok: true, changed: true });
  const finishedAt = harness.nextTimestamp();
  await expect(harness.repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: NAMED_WORKSPACE_ID,
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', disposition, finishedAt },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  })).resolves.toMatchObject({ ok: true, changed: true });
}

export async function produceNamedOutput(
  harness: NamedWorkflowHarness,
  definitionId: string,
  key: string,
  value: string,
): Promise<StartedWorkflow> {
  const source = startedData(await startWorkflow(harness, { definitionId, key }));
  const entry = source.entries[0]!;
  await settleWorkflowTurn(harness, entry.taskId, entry.activationTurnId, {
    kind: 'workflow_next',
    change: 'updated',
    result: value,
  });
  return source;
}

export async function workflowRowCount(
  harness: NamedWorkflowHarness,
  definitionId: string,
): Promise<number> {
  const row = await harness.client.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM workflow_runs
      WHERE workspace_id = ? AND source_definition_id = ?`,
    [NAMED_WORKSPACE_ID, definitionId],
  );
  return Number(row?.count ?? 0);
}
