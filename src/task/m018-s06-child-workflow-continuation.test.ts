import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { stageDispositionForSettlement } from './m018-test-helpers';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import type { TurnDisposition } from './types';
import {
  defineCanonicalWorkflow,
  NAMED_WORKSPACE_ID,
  type NamedWorkflowHarness,
  openNamedWorkflowHarness,
  reopenNamedWorkflowHarness,
  startWorkflow,
  startedData,
} from './workflow-named-composition-test-helpers';

const CHILD_DEFINITION_ID = 'wf-named-child';

async function defineCallerAndChild(harness: NamedWorkflowHarness): Promise<void> {
  await defineCanonicalWorkflow(harness, {
    definitionId: 'wf-named-caller',
    topology: {
      kind: 'workflow',
      inputs: [{
        name: 'source',
        semanticKind: 'parent-opaque',
        entryNodeId: 'entry',
        inputRef: 'source',
      }],
      outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
      nodes: [{
        nodeId: 'entry',
        role: 'coordinator',
        capabilities: ['create_child'],
      }],
      edges: [],
    },
  });
  await defineCanonicalWorkflow(harness, {
    definitionId: CHILD_DEFINITION_ID,
    topology: {
      kind: 'workflow',
      inputs: [
        {
          name: 'request',
          semanticKind: 'child-request',
          entryNodeId: 'entry',
          inputRef: 'requestInput',
        },
        {
          name: 'context',
          semanticKind: 'child-context',
          entryNodeId: 'entry',
          inputRef: 'contextInput',
        },
      ],
      outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
      nodes: [{
        nodeId: 'entry',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The child result is ready.' },
          fail: { when: 'The child cannot complete safely.' },
        },
      }],
      edges: [],
    },
  });
}

async function startCaller(
  harness: NamedWorkflowHarness,
  key: string,
  value: string,
) {
  return startedData(await startWorkflow(harness, {
    definitionId: 'wf-named-caller',
    key,
    inputs: [{ name: 'source', value }],
  }));
}

function childRoute(
  entryBindings: ReadonlyArray<Record<string, unknown>>,
  childIdempotencyKey: string = 'named-child-key',
  childDefinitionId: string = CHILD_DEFINITION_ID,
): Extract<TurnDisposition, { kind: 'workflow_next' }> {
  return {
    kind: 'workflow_next',
    change: 'updated',
    route: {
      kind: 'child_workflow',
      childDefinitionId,
      childDefinitionVersion: 1,
      entryBindings: entryBindings as unknown as ReadonlyArray<{
        name: string;
        fromInputRef: string;
      }>,
      childIdempotencyKey,
    },
  };
}

async function stageCallerDisposition(
  harness: NamedWorkflowHarness,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
  opId: string,
) {
  await harness.client.run(
    `UPDATE turns SET status = 'running', started_at = ?, settled_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    [harness.nextTimestamp(), NAMED_WORKSPACE_ID, turnId],
  );
  const turn = await harness.repository.getTurn(turnId);
  expect(turn).toBeTruthy();
  return stageDispositionForSettlement(harness.repository, turn!, disposition, opId);
}

async function prepareCallerSettlement(
  harness: NamedWorkflowHarness,
  taskId: string,
  turnId: string,
  disposition: TurnDisposition,
  opId: string,
) {
  await expect(stageCallerDisposition(
    harness,
    taskId,
    turnId,
    disposition,
    opId,
  )).resolves.toMatchObject({ ok: true, changed: true });
  const task = await harness.repository.getTask(taskId);
  const turn = await harness.repository.getTurn(turnId);
  expect(task).toBeTruthy();
  expect(turn).toBeTruthy();
  const finishedAt = harness.nextTimestamp();
  return () => harness.repository.execute({
    kind: 'settleTurnAndApplyEffects',
    workspaceId: NAMED_WORKSPACE_ID,
    expectedTaskRevision: task!.revision,
    task: { ...task!, updatedAt: finishedAt },
    turn: { ...turn!, status: 'succeeded', disposition, finishedAt },
    expectedStatuses: ['running'],
    relatedTurns: [],
    messages: [],
  });
}

async function childRuns(harness: NamedWorkflowHarness, parentRunId: string) {
  return harness.client.all<{
    run_id: string;
    status: string;
  }>(
    `SELECT run_id, status FROM workflow_runs
      WHERE workspace_id = ? AND parent_run_id = ? AND origin = 'child'
      ORDER BY run_id`,
    [NAMED_WORKSPACE_ID, parentRunId],
  );
}

describe('M018 S06 named child workflow continuation', () => {
  it('rejects missing, duplicate, unknown, foreign, and coordinate-bearing child bindings before child creation', async () => {
    const harness = await openNamedWorkflowHarness('child-invalid');
    try {
      await defineCallerAndChild(harness);
      const invalidBindings: Array<{
        label: string;
        bindings: ReadonlyArray<Record<string, unknown>>;
      }> = [
        {
          label: 'missing',
          bindings: [{ name: 'request', fromInputRef: 'source' }],
        },
        {
          label: 'duplicate',
          bindings: [
            { name: 'request', fromInputRef: 'source' },
            { name: 'request', fromInputRef: 'source' },
          ],
        },
        {
          label: 'unknown',
          bindings: [
            { name: 'request', fromInputRef: 'source' },
            { name: 'unknown', fromInputRef: 'source' },
          ],
        },
        {
          label: 'foreign',
          bindings: [
            { name: 'request', fromInputRef: 'source' },
            { name: 'context', fromInputRef: 'another-activation-only' },
          ],
        },
        {
          label: 'coordinates',
          bindings: [
            {
              name: 'request',
              fromInputRef: 'source',
              childEntryNodeId: 'entry',
              inputRef: 'requestInput',
              artifactId: 'model-artifact',
              artifactRevision: 7,
            },
            { name: 'context', fromInputRef: 'source' },
          ],
        },
      ];

      for (const invalid of invalidBindings) {
        const caller = await startCaller(
          harness,
          `caller-${invalid.label}`,
          `value-${invalid.label}`,
        );
        const result = await stageCallerDisposition(
          harness,
          caller.entryTaskId,
          caller.activationTurnId,
          childRoute(invalid.bindings, `child-${invalid.label}`),
          `stage-invalid-${invalid.label}`,
        );
        expect(result, invalid.label).toMatchObject({ ok: true, changed: false });
        expect(await childRuns(harness, caller.runId), invalid.label).toEqual([]);
      }
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('pins current-activation provenance, adapts destination semantic kinds, and replays one concurrent invocation', async () => {
    const harness = await openNamedWorkflowHarness('child-provenance');
    try {
      await defineCallerAndChild(harness);
      const caller = await startCaller(harness, 'caller-valid', 'PARENT exact value');
      const disposition = childRoute([
        { name: 'context', fromInputRef: 'source' },
        { name: 'request', fromInputRef: 'source' },
      ]);
      const execute = await prepareCallerSettlement(
        harness,
        caller.entryTaskId,
        caller.activationTurnId,
        disposition,
        'stage-valid-child',
      );
      await expect(stageCallerDisposition(
        harness,
        caller.entryTaskId,
        caller.activationTurnId,
        childRoute([
          { name: 'context', fromInputRef: 'source' },
          { name: 'request', fromInputRef: 'source' },
        ], 'changed-child-key'),
        'stage-conflicting-child',
      )).resolves.toMatchObject({
        ok: true,
        changed: false,
        conflict: true,
        reason: 'turn already has a different disposition',
      });
      const concurrent = await Promise.all([execute(), execute()]);
      expect(concurrent).toEqual(expect.arrayContaining([
        expect.objectContaining({ ok: true, changed: true }),
        expect.objectContaining({ ok: true, changed: false }),
      ]));

      const children = await childRuns(harness, caller.runId);
      expect(children).toHaveLength(1);
      const childRunId = children[0]!.run_id;
      const childInputs = await harness.client.all<{
        input_ref: string;
        payload_json: string;
        source_artifact_run_id: string;
        source_artifact_id: string;
        source_artifact_revision: number;
      }>(
        `SELECT fill.input_ref, artifact.payload_json,
                source.source_artifact_run_id, source.source_artifact_id,
                source.source_artifact_revision
           FROM workflow_gate_fills fill
           JOIN workflow_artifacts artifact
             ON artifact.workspace_id = fill.workspace_id
            AND artifact.run_id = fill.run_id
            AND artifact.artifact_id = fill.artifact_id
            AND artifact.revision = fill.artifact_revision
           JOIN workflow_artifact_sources source
             ON source.workspace_id = artifact.workspace_id
            AND source.run_id = artifact.run_id
            AND source.artifact_id = artifact.artifact_id
            AND source.artifact_revision = artifact.revision
          WHERE fill.workspace_id = ? AND fill.run_id = ?
          ORDER BY fill.input_ref`,
        [NAMED_WORKSPACE_ID, childRunId],
      );
      expect(childInputs.map((row) => ({
        inputRef: row.input_ref,
        payload: JSON.parse(row.payload_json),
      }))).toEqual([
        {
          inputRef: 'contextInput',
          payload: {
            payloadVersion: 1,
            value: 'PARENT exact value',
            semanticKind: 'child-context',
          },
        },
        {
          inputRef: 'requestInput',
          payload: {
            payloadVersion: 1,
            value: 'PARENT exact value',
            semanticKind: 'child-request',
          },
        },
      ]);
      expect(new Set(childInputs.map((row) => (
        `${row.source_artifact_run_id}:${row.source_artifact_id}:${row.source_artifact_revision}`
      ))).size).toBe(1);
      expect(childInputs[0]!.source_artifact_run_id).toBe(caller.runId);
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND child_run_id = ? AND status = 'pending'`,
        [NAMED_WORKSPACE_ID, caller.runId, childRunId],
      )).resolves.toEqual({ count: 1 });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('returns exactly once after reload and ignores exact settlement redelivery', async () => {
    const harness = await openNamedWorkflowHarness('child-reload');
    try {
      await defineCallerAndChild(harness);
      const caller = await startCaller(harness, 'caller-reload', 'ORIGINAL parent value');
      const disposition = childRoute([
        { name: 'request', fromInputRef: 'source' },
        { name: 'context', fromInputRef: 'source' },
      ], 'stable-child-key');
      const execute = await prepareCallerSettlement(
        harness,
        caller.entryTaskId,
        caller.activationTurnId,
        disposition,
        'stage-child-before-reload',
      );
      await expect(execute()).resolves.toMatchObject({ ok: true, changed: true });
      const childRunId = (await childRuns(harness, caller.runId))[0]!.run_id;

      await reopenNamedWorkflowHarness(harness);
      const childNode = await harness.client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
        [NAMED_WORKSPACE_ID, childRunId],
      );
      const childTurn = (await harness.repository.listTurns(childNode!.task_id))[0]!;
      const returnChild = await prepareCallerSettlement(
        harness,
        childNode!.task_id,
        childTurn.id,
        { kind: 'workflow_next', change: 'updated', result: 'CHILD exact result' },
        'stage-child-return',
      );
      await expect(returnChild()).resolves.toMatchObject({ ok: true, changed: true });
      await expect(returnChild()).resolves.toMatchObject({ ok: true, changed: false });

      await expect(harness.client.get<{
        status: string;
        resolved_at: string | null;
      }>(
        `SELECT status, resolved_at FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND child_run_id = ?`,
        [NAMED_WORKSPACE_ID, caller.runId, childRunId],
      )).resolves.toMatchObject({ status: 'resolved' });
      const resumeTurns = await harness.client.all<{ id: string; status: string }>(
        `SELECT turn_row.id, turn_row.status
           FROM turns turn_row
          WHERE turn_row.workspace_id = ? AND turn_row.task_id = ?
            AND turn_row.id <> ? AND turn_row.trigger = 'engine'
          ORDER BY turn_row.sequence, turn_row.id`,
        [NAMED_WORKSPACE_ID, caller.entryTaskId, caller.activationTurnId],
      );
      expect(resumeTurns).toHaveLength(1);
      expect(resumeTurns[0]!.status).toBe('queued');
      expect(await childRuns(harness, caller.runId)).toHaveLength(1);
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ?`,
        [NAMED_WORKSPACE_ID, caller.runId],
      )).resolves.toEqual({ count: 1 });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('same child key is isolated across callers and conflicts on changed same-caller bindings', async () => {
    const harness = await openNamedWorkflowHarness('child-key-scope');
    try {
      await defineCallerAndChild(harness);
      const bindings = [
        { name: 'request', fromInputRef: 'source' },
        { name: 'context', fromInputRef: 'source' },
      ];
      const first = await startCaller(harness, 'caller-key-first', 'FIRST parent value');
      const settleFirst = await prepareCallerSettlement(
        harness,
        first.entryTaskId,
        first.activationTurnId,
        childRoute(bindings, 'shared-child-key'),
        'stage-shared-child-first',
      );
      await expect(settleFirst()).resolves.toMatchObject({ ok: true, changed: true });

      const second = await startCaller(harness, 'caller-key-second', 'SECOND parent value');
      const settleSecond = await prepareCallerSettlement(
        harness,
        second.entryTaskId,
        second.activationTurnId,
        childRoute(bindings, 'shared-child-key'),
        'stage-shared-child-second',
      );
      await expect(settleSecond()).resolves.toMatchObject({ ok: true, changed: true });
      const firstChildren = await childRuns(harness, first.runId);
      const secondChildren = await childRuns(harness, second.runId);
      expect(firstChildren).toHaveLength(1);
      expect(secondChildren).toHaveLength(1);
      expect(firstChildren[0]!.run_id).not.toBe(secondChildren[0]!.run_id);

      const conflicting = await startCaller(
        harness,
        'caller-key-conflict',
        'CONFLICT parent value',
      );
      await expect(stageCallerDisposition(
        harness,
        conflicting.entryTaskId,
        conflicting.activationTurnId,
        childRoute(bindings, 'original-child-key'),
        'stage-original-child-key',
      )).resolves.toMatchObject({ ok: true, changed: true });
      await expect(stageCallerDisposition(
        harness,
        conflicting.entryTaskId,
        conflicting.activationTurnId,
        childRoute(bindings, 'changed-child-key'),
        'stage-changed-child-key',
      )).resolves.toMatchObject({
        ok: true,
        changed: false,
        conflict: true,
        reason: 'turn already has a different disposition',
      });
      expect(await childRuns(harness, conflicting.runId)).toEqual([]);
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('propagates child failure through the parent continuation exactly once', async () => {
    const harness = await openNamedWorkflowHarness('child-failure-propagation');
    try {
      await defineCallerAndChild(harness);
      const caller = await startCaller(harness, 'caller-child-failure', 'FAIL parent value');
      const invoke = await prepareCallerSettlement(
        harness,
        caller.entryTaskId,
        caller.activationTurnId,
        childRoute([
          { name: 'request', fromInputRef: 'source' },
          { name: 'context', fromInputRef: 'source' },
        ], 'failing-child-key'),
        'stage-failing-child',
      );
      await expect(invoke()).resolves.toMatchObject({ ok: true, changed: true });
      const childRunId = (await childRuns(harness, caller.runId))[0]!.run_id;
      const childNode = await harness.client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
        [NAMED_WORKSPACE_ID, childRunId],
      );
      const childTurn = (await harness.repository.listTurns(childNode!.task_id))[0]!;
      const failChild = await prepareCallerSettlement(
        harness,
        childNode!.task_id,
        childTurn.id,
        { kind: 'workflow_fail', reason: 'declared child failure' },
        'stage-child-failure',
      );
      await expect(failChild()).resolves.toMatchObject({ ok: true, changed: true });
      await expect(failChild()).resolves.toMatchObject({ ok: true, changed: false });

      const runs = await harness.client.all<{
        run_id: string;
        status: string;
        terminal_reason_code: string | null;
      }>(
        `SELECT run_id, status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id IN (?,?) ORDER BY run_id`,
        [NAMED_WORKSPACE_ID, caller.runId, childRunId],
      );
      expect(runs).toHaveLength(2);
      expect(runs.every((run) =>
        run.status === 'failed' && run.terminal_reason_code === 'agent_fail')).toBe(true);
      await expect(harness.client.get(
        `SELECT status, outcome, reason_code, result_artifact_id
           FROM workflow_continuations WHERE workspace_id = ? AND child_run_id = ?`,
        [NAMED_WORKSPACE_ID, childRunId],
      )).resolves.toEqual({
        status: 'failed',
        outcome: 'failed',
        reason_code: 'agent_fail',
        result_artifact_id: null,
      });
      await expect(harness.client.get(
        `SELECT status, result_artifact_id FROM workflow_return_gates
          WHERE workspace_id = ? AND child_run_id = ?`,
        [NAMED_WORKSPACE_ID, childRunId],
      )).resolves.toEqual({ status: 'failed', result_artifact_id: null });
      await expect(harness.repository.getTask(caller.entryTaskId)).resolves.toMatchObject({
        lifecycle: 'failed',
      });
      await expect(harness.repository.getTask(childNode!.task_id)).resolves.toMatchObject({
        lifecycle: 'failed',
      });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('propagates typed child cancellation through the parent continuation exactly once', async () => {
    const harness = await openNamedWorkflowHarness('child-cancellation-propagation');
    try {
      await defineCallerAndChild(harness);
      const caller = await startCaller(harness, 'caller-child-cancel', 'CANCEL parent value');
      const invoke = await prepareCallerSettlement(
        harness,
        caller.entryTaskId,
        caller.activationTurnId,
        childRoute([
          { name: 'request', fromInputRef: 'source' },
          { name: 'context', fromInputRef: 'source' },
        ], 'cancelled-child-key'),
        'stage-cancelled-child',
      );
      await expect(invoke()).resolves.toMatchObject({ ok: true, changed: true });
      const childRunId = (await childRuns(harness, caller.runId))[0]!.run_id;
      const childNode = await harness.client.get<{ task_id: string }>(
        `SELECT task_id FROM workflow_nodes
          WHERE workspace_id = ? AND run_id = ? AND node_id = 'entry'`,
        [NAMED_WORKSPACE_ID, childRunId],
      );
      const childTask = await harness.repository.getTask(childNode!.task_id);
      const childTurn = (await harness.repository.listTurns(childNode!.task_id))[0]!;
      const cancelledAt = harness.nextTimestamp();
      const cancelCommand = {
        kind: 'applyTaskLifecycle' as const,
        workspaceId: NAMED_WORKSPACE_ID,
        taskId: childTask!.id,
        expectedTaskRevision: childTask!.revision,
        task: {
          ...childTask!,
          lifecycle: 'cancelled' as const,
          revision: childTask!.revision + 1,
          updatedAt: cancelledAt,
        },
        turns: [{ ...childTurn, status: 'cancelled' as const, finishedAt: cancelledAt }],
        expectedTurns: [{ id: childTurn.id, status: 'queued' as const }],
      };
      await expect(harness.repository.execute(cancelCommand)).resolves.toMatchObject({
        ok: true,
        changed: true,
      });

      const runs = await harness.client.all<{
        run_id: string;
        status: string;
        terminal_reason_code: string | null;
      }>(
        `SELECT run_id, status, terminal_reason_code FROM workflow_runs
          WHERE workspace_id = ? AND run_id IN (?,?) ORDER BY run_id`,
        [NAMED_WORKSPACE_ID, caller.runId, childRunId],
      );
      expect(runs).toHaveLength(2);
      expect(runs.every((run) =>
        run.status === 'cancelled'
        && run.terminal_reason_code === 'required_target_cancelled')).toBe(true);
      await expect(harness.client.get(
        `SELECT status, outcome, reason_code, result_artifact_id
           FROM workflow_continuations WHERE workspace_id = ? AND child_run_id = ?`,
        [NAMED_WORKSPACE_ID, childRunId],
      )).resolves.toEqual({
        status: 'cancelled',
        outcome: 'cancelled',
        reason_code: 'required_target_cancelled',
        result_artifact_id: null,
      });
      await expect(harness.client.get(
        `SELECT status FROM workflow_return_gates
          WHERE workspace_id = ? AND child_run_id = ?`,
        [NAMED_WORKSPACE_ID, childRunId],
      )).resolves.toEqual({ status: 'cancelled' });
      await expect(harness.repository.getTask(caller.entryTaskId)).resolves.toMatchObject({
        lifecycle: 'cancelled',
      });
      await expect(harness.repository.getTask(childNode!.task_id)).resolves.toMatchObject({
        lifecycle: 'cancelled',
      });

      await reopenNamedWorkflowHarness(harness);
      await expect(harness.repository.execute(cancelCommand)).resolves.toMatchObject({
        changed: false,
      });
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_continuations
          WHERE workspace_id = ? AND child_run_id = ?`,
        [NAMED_WORKSPACE_ID, childRunId],
      )).resolves.toEqual({ count: 1 });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rolls back the child run, return gate, continuation, and provenance on a transaction fault', async () => {
    const harness = await openNamedWorkflowHarness('child-fault');
    try {
      await defineCallerAndChild(harness);
      const caller = await startCaller(harness, 'caller-fault', 'FAULT parent value');
      const execute = await prepareCallerSettlement(
        harness,
        caller.entryTaskId,
        caller.activationTurnId,
        childRoute([
          { name: 'request', fromInputRef: 'source' },
          { name: 'context', fromInputRef: 'source' },
        ], 'fault-child-key'),
        'stage-fault-child',
      );

      await harness.client.close();
      const faultyClient = new DbClient({
        workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
        execArgv: ['--import', 'tsx'],
        faultCapability: true,
        faultPlan: { code: 'full', operation: 'transaction', remaining: 1 },
      });
      await faultyClient.open(harness.dbPath);
      harness.client = faultyClient;
      harness.repository = new SqliteTaskRepository(faultyClient, NAMED_WORKSPACE_ID);
      await expect(execute()).rejects.toMatchObject({ code: 'full' });

      await reopenNamedWorkflowHarness(harness);
      expect(await childRuns(harness, caller.runId)).toEqual([]);
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ?`,
        [NAMED_WORKSPACE_ID, caller.runId],
      )).resolves.toEqual({ count: 0 });
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_return_gates
          WHERE workspace_id = ? AND caller_run_id = ?`,
        [NAMED_WORKSPACE_ID, caller.runId],
      )).resolves.toEqual({ count: 0 });

      await expect(execute()).resolves.toMatchObject({ ok: true, changed: true });
      expect(await childRuns(harness, caller.runId)).toHaveLength(1);
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('invokes valid zero-input and 65-input children through exact public-name coverage', async () => {
    const harness = await openNamedWorkflowHarness('child-contract-bounds');
    try {
      await defineCallerAndChild(harness);
      await defineCanonicalWorkflow(harness, {
        definitionId: 'wf-zero-input-child',
        topology: {
          kind: 'workflow',
          inputs: [],
          outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
          nodes: [{ nodeId: 'entry' }],
          edges: [],
        },
      });
      const wideInputs = Array.from({ length: 65 }, (_, index) => ({
        name: `input${String(index).padStart(2, '0')}`,
        semanticKind: `kind${String(index).padStart(2, '0')}`,
        entryNodeId: `entry${String(Math.floor(index / 3)).padStart(2, '0')}`,
        inputRef: `inputRef${String(index).padStart(2, '0')}`,
      }));
      const componentCount = Math.ceil(wideInputs.length / 3);
      await defineCanonicalWorkflow(harness, {
        definitionId: 'wf-wide-input-child',
        topology: {
          kind: 'workflow',
          inputs: wideInputs,
          outputs: Array.from({ length: componentCount }, (_, index) => ({
            name: `result${String(index).padStart(2, '0')}`,
            semanticKind: 'result',
            terminalNodeId: `terminal${String(index).padStart(2, '0')}`,
          })),
          nodes: Array.from({ length: componentCount }, (_, index) => [
            { nodeId: `entry${String(index).padStart(2, '0')}` },
            { nodeId: `terminal${String(index).padStart(2, '0')}` },
          ]).flat(),
          edges: Array.from({ length: componentCount }, (_, index) => ({
            fromNodeId: `entry${String(index).padStart(2, '0')}`,
            toNodeId: `terminal${String(index).padStart(2, '0')}`,
            inputRef: `resultInput${String(index).padStart(2, '0')}`,
          })),
        },
      });

      const zeroCaller = await startCaller(harness, 'zero-input-caller', 'unused parent value');
      const settleZero = await prepareCallerSettlement(
        harness,
        zeroCaller.entryTaskId,
        zeroCaller.activationTurnId,
        childRoute([], 'zero-child-key', 'wf-zero-input-child'),
        'stage-zero-input-child',
      );
      await expect(settleZero()).resolves.toMatchObject({ ok: true, changed: true });
      expect(await childRuns(harness, zeroCaller.runId)).toHaveLength(1);

      const wideCaller = await startCaller(harness, 'wide-input-caller', 'shared parent value');
      const settleWide = await prepareCallerSettlement(
        harness,
        wideCaller.entryTaskId,
        wideCaller.activationTurnId,
        childRoute(
          wideInputs.map((input) => ({ name: input.name, fromInputRef: 'source' })),
          'wide-child-key',
          'wf-wide-input-child',
        ),
        'stage-wide-input-child',
      );
      await expect(settleWide()).resolves.toMatchObject({ ok: true, changed: true });
      const wideChildRunId = (await childRuns(harness, wideCaller.runId))[0]!.run_id;
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workflow_artifact_sources
          WHERE workspace_id = ? AND run_id = ? AND source_kind = 'workflow_artifact'`,
        [NAMED_WORKSPACE_ID, wideChildRunId],
      )).resolves.toEqual({ count: 65 });
      await expect(harness.client.all('PRAGMA foreign_key_check')).resolves.toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
