/**
 * M024/S06 Extension Development Host entrypoint. It seeds a real workflow
 * reuse run through the UAT-only production delegates, then observes one
 * genuine webview-initiated `requestWorkflowGraph` / `workflowGraphResult`
 * round trip across the live host/webview transport.
 *
 * It never posts the request itself and never reads SQLite directly: the
 * webview's own focus effect issues the request, and the host's production
 * `post` path carries the reply. That is the seam the vitest route tests cannot
 * cover, because they inject `getFocused` instead of exercising focus wiring.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { UAT_COMMANDS, type UatHostState } from '../src/host/uat-commands';
import type { WorkflowGraphProbeObservation } from '../src/host/workflow-graph-probe';
import type { WorkflowGraphFixtureResult } from '../src/host/workflow-graph-uat-fixture';

export type WorkflowGraphHostResult = {
  ok: true;
  kind: 'm024-s06-workflow-graph-host-result';
  schemaVersion: 1;
  vscodeVersion: string;
  hostMode: 'extension-development-host';
  probeSource: 'live-extension-host-transport';
  fixture: WorkflowGraphFixtureResult;
  observation: WorkflowGraphProbeObservation;
};

const POLL_MS = 100;
/** The chain has five nodes; reuse at `four` suppresses one..four. */
const EXPECTED_NODE_COUNT = 5;
const EXPECTED_REUSED_NODE_COUNT = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function command<T>(id: string, args?: unknown): Promise<T> {
  return (await vscode.commands.executeCommand(id, args)) as T;
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  describeLast?: (value: T | undefined) => string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `timeout waiting for ${label}${describeLast ? `; ${describeLast(last)}` : ''}`,
      );
    }
    await sleep(POLL_MS);
  }
}

function writeResult(result: WorkflowGraphHostResult): void {
  const out = process.env.MUSTER_UAT_HOST_RESULT_OUT;
  if (!out) return;
  fs.writeFileSync(`${out}.tmp`, `${JSON.stringify(result)}\n`);
  fs.renameSync(`${out}.tmp`, out);
}

export async function run(): Promise<void> {
  assert.equal(process.env.MUSTER_UAT_MODE, '1', 'MUSTER_UAT_MODE=1 is required');
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'packaged tlelabs.muster extension was not discovered');
  await extension.activate();
  assert.equal(extension.isActive, true, 'packaged extension failed to activate');
  await command('muster.openChat');
  await waitFor<UatHostState>(
    'webview hydration',
    () => command(UAT_COMMANDS.hostState),
    (state) => state.viewResolved && state.viewVisible && state.pollingReady,
  );

  // Real reuse run: one settled producer, then a five-node chain whose first four
  // nodes are each bound to that producer's execution, so only `five` activates
  // and owns a graph. Reuse is bind-only: an unbound ancestor would be rejected.
  const fixture = await command<WorkflowGraphFixtureResult>(
    UAT_COMMANDS.seedWorkflowGraphFixture,
  );
  assert.equal(
    fixture.reusedNodeCount,
    EXPECTED_REUSED_NODE_COUNT,
    `fixture seeded ${fixture.reusedNodeCount} reused nodes`,
  );
  assert.ok(fixture.focusTaskId, 'fixture exposed no live node task to focus');

  // Wait for the seeded task to hydrate into the webview; the webview cannot
  // request a graph for a task it has not yet received.
  await waitFor<UatHostState>(
    'seeded workflow task hydration',
    () => command(UAT_COMMANDS.hostState),
    (state) => state.taskIds.includes(fixture.focusTaskId),
    (state) => `last hostState taskIds=${state?.taskIds.length ?? 0}`,
  );

  const observation = await command<WorkflowGraphProbeObservation>(
    UAT_COMMANDS.observeWorkflowGraphRoundTrip,
    { taskId: fixture.focusTaskId },
  );

  assert.equal(observation.taskId, fixture.focusTaskId, 'observed graph for a different task');
  assert.equal(observation.ok, true, `graph result failed with code=${observation.code ?? 'none'}`);
  const graph = observation.graph;
  assert.ok(graph, 'ok result carried no graph observation');
  assert.equal(graph.hasRunId, true, 'graph carried no runId');
  assert.equal(graph.nodeCount, EXPECTED_NODE_COUNT, `graph exposed ${graph.nodeCount} nodes`);
  assert.equal(
    graph.reusedNodeCount,
    EXPECTED_REUSED_NODE_COUNT,
    `graph flagged ${graph.reusedNodeCount} reused nodes on the wire`,
  );
  assert.equal(
    graph.reuseNodeCount,
    EXPECTED_REUSED_NODE_COUNT,
    `host reuse counter reported ${graph.reuseNodeCount}`,
  );
  assert.ok(graph.nodeStatuses.includes('reused'), 'reused status did not survive to the wire');

  const result: WorkflowGraphHostResult = {
    ok: true,
    kind: 'm024-s06-workflow-graph-host-result',
    schemaVersion: 1,
    vscodeVersion: vscode.version,
    hostMode: 'extension-development-host',
    probeSource: 'live-extension-host-transport',
    fixture,
    observation,
  };
  writeResult(result);
  console.log(
    `[m024-s06-workflow-graph-host] nodes=${graph.nodeCount} reusedNodes=${graph.reusedNodeCount} edges=${graph.edgeCount} reusedEdges=${graph.reusedEdgeCount}`,
  );
}
