import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';
import { makeOneNodeDefinition } from './workflow';
import { decodeWorkflowCompositeSpec, expandWorkflowComposite } from './workflow-composite-codec';
import { fingerprintWorkflowDefinition } from './workflow-codec';

const WORKER_TS = path.join(__dirname, 'sqlite', 'worker.ts');
const TSX_ARGV = ['--import', 'tsx'];
const dirs: string[] = [];
const clients: DbClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('atomic run-scoped workflow composites', () => {
  it('persists one composite run authority without creating a definition row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-composite-start-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'muster.sqlite3');
    const client = new DbClient({ workerPath: WORKER_TS, execArgv: TSX_ARGV });
    clients.push(client);
    await client.open(dbPath);
    await client.run(
      `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at) VALUES (?,?,?,?,?)`,
      ['ws', 'composite', 'composite', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'],
    );
    const repository = new SqliteTaskRepository(client, 'ws');
    await repository.execute({
      kind: 'createTask', workspaceId: 'ws', task: {
        id: 'root', role: 'coordinator', lifecycle: 'open', releaseState: 'released', goal: 'root', parentId: null,
        prerequisites: [], backend: 'grok', capabilities: ['create_child'], executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
        revision: 0, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', releasedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    await repository.execute({
      kind: 'createTurn', workspaceId: 'ws', turn: {
        id: 'root-turn', taskId: 'root', sequence: 1, status: 'running', trigger: 'user', inputs: [],
        createdAt: '2026-08-01T00:00:00.000Z', startedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    // Both component and local keys may contain ':'. The graph projection
    // must preserve the pair without collapsing (a, b:c) with (a:b, c).
    const leftBase = makeOneNodeDefinition({ definitionId: 'workflow-11111111111111111111111111111111', nodeId: 'b:c', createdAt: '2026-08-01T00:00:00.000Z' });
    const rightBase = makeOneNodeDefinition({ definitionId: 'workflow-22222222222222222222222222222222', nodeId: 'c', createdAt: '2026-08-01T00:00:00.000Z' });
    const left = {
      ...leftBase,
      topology: { ...leftBase.topology, inputs: [{ name: 'input', semanticKind: 'result', entryNodeId: 'b:c', inputRef: 'input' }] },
      entryContracts: [{ entryNodeId: 'b:c', inputRef: 'input', expectedArtifactKind: 'workflow_input' as const }],
    };
    const right = {
      ...rightBase,
      topology: { ...rightBase.topology, inputs: [{ name: 'input', semanticKind: 'result', entryNodeId: 'c', inputRef: 'input' }] },
      entryContracts: [{ entryNodeId: 'c', inputRef: 'input', expectedArtifactKind: 'workflow_input' as const }],
    };
    for (const definition of [left]) {
      await expect(repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: definition.definitionId,
        version: 1, name: definition.name, topology: definition.topology,
        entryContracts: definition.entryContracts, policy: definition.policy,
        createdAt: definition.createdAt,
      })).resolves.toMatchObject({ ok: true, changed: true });
    }
    const parsed = decodeWorkflowCompositeSpec({
      components: [
        { key: 'a', workflow: `${left.definitionId}@1` },
        { key: 'a:b', manifest: {
          schema: 'muster.workflow/v2', name: 'inline-right',
          inputs: [{ name: 'input', kind: 'result', to: 'c', inputRef: 'input' }],
          outputs: [{ name: 'result', kind: 'result', from: 'c' }],
          nodes: [{ nodeKey: 'c', taskType: 'general', outcome: {
            kind: 'agent', requireExplicitDisposition: true,
            next: { when: 'complete' }, fail: { when: 'fail' },
          } }],
          edges: [],
        } },
      ],
      connections: [{
        from: { component: 'a', output: left.topology.outputs[0]!.name },
        to: { component: 'a:b', input: right.topology.inputs[0]!.name },
      }],
      inputs: [{ name: 'leftInput', to: { component: 'a', input: left.topology.inputs[0]!.name } }],
      outputs: [
        { name: 'leftResult', from: { component: 'a', output: left.topology.outputs[0]!.name } },
        { name: 'rightResult', from: { component: 'a:b', output: right.topology.outputs[0]!.name } },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const authorities = [{
      key: 'a',
      source: { kind: 'workflow' as const, workflowRef: `${left.definitionId}@1`, fingerprint: fingerprintWorkflowDefinition(left) },
      definition: left,
    }];
    const expanded = expandWorkflowComposite({ spec: parsed.spec, authorities });
    expect(expanded, JSON.stringify(expanded)).toMatchObject({ ok: true });
    if (!expanded.ok) return;
    const started = await repository.execute({
      kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'workflow-composite',
      version: 1, startIdempotencyKey: 'composite-start', createdAt: '2026-08-01T00:00:00.000Z',
      goal: 'composite', backend: 'grok', composite: expanded,
      inputs: [{ name: 'leftInput', value: 'left' }],
      ownerRootTaskId: 'root', callerTaskId: 'root', callerTurnId: 'root-turn',
      resumeCallerOnCompletion: false,
    });
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, changed: true });
    const run = started.operation?.result?.data as { runId: string };
    expect(run.runId).toMatch(/^wf/);
    await expect(client.get<{ count: number }>(`SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id = 'ws'`)).resolves.toEqual({ count: 1 });
    await expect(client.get<{ kind: string }>(`SELECT authority_kind AS kind FROM workflow_runs WHERE workspace_id = 'ws' AND run_id = ?`, [run.runId])).resolves.toEqual({ kind: 'composite' });
    await expect(client.get<{ count: number }>(`SELECT COUNT(*) AS count FROM workflow_continuations WHERE workspace_id = 'ws' AND run_id = ? AND kind = 'start_wait'`, [run.runId])).resolves.toEqual({ count: 0 });
    const authority = await repository.getWorkflowRunAuthority(run.runId);
    expect(authority).toMatchObject({ kind: 'composite' });
    const graph = await repository.getWorkflowGraphForTask('root');
    const publicNodeKeys = graph?.topology?.nodes.map((node) => node.nodeKey) ?? [];
    expect(publicNodeKeys).toHaveLength(2);
    expect(new Set(publicNodeKeys).size).toBe(publicNodeKeys.length);
    expect(publicNodeKeys).toEqual(expect.arrayContaining(['1:a/3:b:c', '3:a:b/1:c']));
  });
});
