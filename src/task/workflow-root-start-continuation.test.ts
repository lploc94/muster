import { describe, expect, it } from 'vitest';
import {
  NAMED_WORKSPACE_ID,
  defineCanonicalWorkflow,
  openNamedWorkflowHarness,
  reopenNamedWorkflowHarness,
  settleWorkflowTurn,
  startWorkflow,
  startedData,
  type NamedWorkflowHarness,
} from './workflow-named-composition-test-helpers';
import { SqliteTaskRepository, type RepositoryDatabase } from './repository';
import type { SqlValue } from './sqlite/rpc';

async function defineOneNode(harness: NamedWorkflowHarness): Promise<void> {
  await defineCanonicalWorkflow(harness, {
    definitionId: 'wf-root-continuation',
    topology: {
      kind: 'workflow',
      inputs: [],
      outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'entry' }],
      nodes: [{
        nodeId: 'entry',
        outcome: {
          kind: 'agent',
          requireExplicitDisposition: true,
          next: { when: 'The result is ready.' },
          fail: { when: 'The result cannot be produced.' },
        },
      }],
      edges: [],
    },
  });
}

async function settleRootTurn(harness: NamedWorkflowHarness): Promise<void> {
  await expect(harness.repository.execute({
    kind: 'settleTurn',
    workspaceId: NAMED_WORKSPACE_ID,
    turnId: 'root-turn',
    status: 'succeeded',
    finishedAt: harness.nextTimestamp(),
  })).resolves.toMatchObject({ ok: true, changed: true });
}

async function resolveAfterReload(harness: NamedWorkflowHarness) {
  await reopenNamedWorkflowHarness(harness);
  return harness.repository.execute({
    kind: 'resolveWorkflowStartContinuation',
    workspaceId: NAMED_WORKSPACE_ID,
    now: harness.nextTimestamp(),
  });
}

async function expectTerminalResultAfterReload(
  terminal: 'failed' | 'cancelled',
  reason: 'agent_fail' | 'required_target_cancelled',
): Promise<void> {
  const harness = await openNamedWorkflowHarness(`root-continuation-${terminal}`);
  try {
    await defineOneNode(harness);
    const started = startedData(await startWorkflow(harness, {
      definitionId: 'wf-root-continuation',
      key: `root-${terminal}`,
      resumeCallerOnCompletion: true,
    }));
    if (terminal === 'failed') {
      await settleWorkflowTurn(
        harness,
        started.entryTaskId,
        started.activationTurnId,
        { kind: 'workflow_fail', reason: 'cannot produce root result' },
      );
    } else {
      const task = await harness.repository.getTask(started.entryTaskId);
      const turn = await harness.repository.getTurn(started.activationTurnId);
      const at = harness.nextTimestamp();
      await expect(harness.repository.execute({
        kind: 'applyTaskLifecycle',
        workspaceId: NAMED_WORKSPACE_ID,
        taskId: task!.id,
        expectedTaskRevision: task!.revision,
        task: {
          ...task!,
          lifecycle: 'cancelled',
          revision: task!.revision + 1,
          updatedAt: at,
        },
        turns: [{ ...turn!, status: 'cancelled', finishedAt: at }],
        expectedTurns: [{ id: turn!.id, status: 'queued' }],
      })).resolves.toMatchObject({ ok: true, changed: true });
    }
    await settleRootTurn(harness);

    await expect(resolveAfterReload(harness)).resolves.toMatchObject({ changed: true });
    const completion = await harness.repository.getWorkflowRunCompletion(
      started.runId,
      'root-task',
    );
    expect(completion).toMatchObject({ runStatus: terminal, terminalReason: reason });
    const messages = await harness.repository.listMessages('root-task');
    expect(messages.filter((message) => message.role === 'system')).toEqual([
      expect.objectContaining({
        content: expect.stringContaining(`\"reason\":\"${reason}\"`),
      }),
    ]);
    await expect(harness.repository.execute({
      kind: 'resolveWorkflowStartContinuation',
      workspaceId: NAMED_WORKSPACE_ID,
      now: harness.nextTimestamp(),
    })).resolves.toMatchObject({ changed: false });
  } finally {
    await harness.close();
  }
}

describe('root workflow start continuation', () => {
  it('resumes a root exactly once with a successful result after reload', async () => {
    const harness = await openNamedWorkflowHarness('root-continuation-success');
    try {
      await defineOneNode(harness);
      const started = startedData(await startWorkflow(harness, {
        definitionId: 'wf-root-continuation',
        key: 'root-success',
        resumeCallerOnCompletion: true,
      }));
      await expect(harness.client.get(
        `SELECT status FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'`,
        [NAMED_WORKSPACE_ID, started.runId],
      )).resolves.toEqual({ status: 'pending' });

      await settleWorkflowTurn(
        harness,
        started.entryTaskId,
        started.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'ROOT exact result' },
      );
      await settleRootTurn(harness);

      await expect(resolveAfterReload(harness)).resolves.toMatchObject({
        ok: true,
        changed: true,
      });
      const continuation = await harness.client.get<{
        status: string;
        resume_turn_id: string;
        resume_message_id: string;
      }>(
        `SELECT status,
                json_extract(payload_json, '$.resumeTurnId') AS resume_turn_id,
                json_extract(payload_json, '$.resumeMessageId') AS resume_message_id
           FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'`,
        [NAMED_WORKSPACE_ID, started.runId],
      );
      expect(continuation).toMatchObject({
        status: 'resolved',
        resume_turn_id: expect.any(String),
        resume_message_id: expect.any(String),
      });
      await expect(harness.repository.getTurn(continuation!.resume_turn_id)).resolves.toMatchObject({
        taskId: 'root-task',
        status: 'queued',
        workflowResume: {
          kind: 'start_workflow',
          runId: started.runId,
        },
      });
      expect((await harness.repository.listMessages('root-task')).find(
        (message) => message.id === continuation!.resume_message_id,
      )).toMatchObject({
        role: 'system',
        content: expect.stringContaining('ROOT exact result'),
      });

      await expect(harness.repository.execute({
        kind: 'resolveWorkflowStartContinuation',
        workspaceId: NAMED_WORKSPACE_ID,
        now: harness.nextTimestamp(),
      })).resolves.toMatchObject({ ok: true, changed: false });
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM turns
          WHERE workspace_id = ? AND id = ?`,
        [NAMED_WORKSPACE_ID, continuation!.resume_turn_id],
      )).resolves.toEqual({ count: 1 });
    } finally {
      await harness.close();
    }
  });

  it('delivers a failed terminal result once after reload', async () => {
    await expectTerminalResultAfterReload('failed', 'agent_fail');
  });

  it('delivers a cancelled terminal result once after reload', async () => {
    await expectTerminalResultAfterReload('cancelled', 'required_target_cancelled');
  });

  it('cancels the pending continuation when the caller is unavailable', async () => {
    const harness = await openNamedWorkflowHarness('root-continuation-caller-cancelled');
    try {
      await defineOneNode(harness);
      const started = startedData(await startWorkflow(harness, {
        definitionId: 'wf-root-continuation',
        key: 'caller-cancelled',
        resumeCallerOnCompletion: true,
      }));
      const root = await harness.repository.getTask('root-task');
      const rootTurn = await harness.repository.getTurn('root-turn');
      const at = harness.nextTimestamp();
      await expect(harness.repository.execute({
        kind: 'applyTaskLifecycle',
        workspaceId: NAMED_WORKSPACE_ID,
        taskId: root!.id,
        expectedTaskRevision: root!.revision,
        task: {
          ...root!,
          lifecycle: 'cancelled',
          revision: root!.revision + 1,
          updatedAt: at,
        },
        turns: [{ ...rootTurn!, status: 'cancelled', finishedAt: at }],
        expectedTurns: [{ id: rootTurn!.id, status: 'running' }],
      })).resolves.toMatchObject({ changed: true });
      await settleWorkflowTurn(
        harness,
        started.entryTaskId,
        started.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'unused result' },
      );

      await expect(resolveAfterReload(harness)).resolves.toMatchObject({ changed: true });
      await expect(harness.client.get(
        `SELECT status, outcome, reason_code FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'`,
        [NAMED_WORKSPACE_ID, started.runId],
      )).resolves.toEqual({
        status: 'cancelled',
        outcome: 'cancelled',
        reason_code: 'caller_unavailable',
      });
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM turns
          WHERE workspace_id = ?
            AND json_extract(payload_json, '$.workflowResume.kind') = 'start_workflow'`,
        [NAMED_WORKSPACE_ID],
      )).resolves.toEqual({ count: 0 });
    } finally {
      await harness.close();
    }
  });

  it('cancels instead of resuming when caller cancellation commits after the resolver read', async () => {
    const harness = await openNamedWorkflowHarness('root-continuation-cancellation-race');
    try {
      await defineOneNode(harness);
      const started = startedData(await startWorkflow(harness, {
        definitionId: 'wf-root-continuation',
        key: 'caller-cancellation-race',
        resumeCallerOnCompletion: true,
      }));
      await settleWorkflowTurn(
        harness,
        started.entryTaskId,
        started.activationTurnId,
        { kind: 'workflow_next', change: 'updated', result: 'race result' },
      );
      await settleRootTurn(harness);

      const root = await harness.repository.getTask('root-task');
      expect(root).toBeTruthy();
      let armed = true;
      const base = harness.client;
      const racingDatabase: RepositoryDatabase = {
        all: (sql, params) => base.all(sql, params),
        get: async <T = unknown>(sql: string, params?: SqlValue[]) => {
          const row = await base.get<T>(sql, params);
          if (
            armed
            && sql.includes('FROM workflow_continuations continuation')
            && sql.includes("continuation.kind = 'start_wait'")
          ) {
            armed = false;
            const at = harness.nextTimestamp();
            await harness.repository.execute({
              kind: 'applyTaskLifecycle',
              workspaceId: NAMED_WORKSPACE_ID,
              taskId: root!.id,
              expectedTaskRevision: root!.revision,
              task: {
                ...root!,
                lifecycle: 'cancelled',
                revision: root!.revision + 1,
                updatedAt: at,
              },
              turns: [],
            });
          }
          return row;
        },
        run: (sql, params) => base.run(sql, params),
        transaction: (statements, options) => base.transaction(statements, options),
        pragma: (pragma) => base.pragma(pragma),
      };
      const racingRepository = new SqliteTaskRepository(
        racingDatabase,
        NAMED_WORKSPACE_ID,
      );

      await expect(racingRepository.execute({
        kind: 'resolveWorkflowStartContinuation',
        workspaceId: NAMED_WORKSPACE_ID,
        now: harness.nextTimestamp(),
      })).resolves.toMatchObject({ ok: true, changed: true });
      expect(armed).toBe(false);
      await expect(harness.client.get(
        `SELECT status, outcome, reason_code FROM workflow_continuations
          WHERE workspace_id = ? AND run_id = ? AND kind = 'start_wait'`,
        [NAMED_WORKSPACE_ID, started.runId],
      )).resolves.toEqual({
        status: 'cancelled',
        outcome: 'cancelled',
        reason_code: 'caller_unavailable',
      });
      await expect(harness.client.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM turns
          WHERE workspace_id = ?
            AND json_extract(payload_json, '$.workflowResume.kind') = 'start_workflow'`,
        [NAMED_WORKSPACE_ID],
      )).resolves.toEqual({ count: 0 });
    } finally {
      await harness.close();
    }
  });
});
