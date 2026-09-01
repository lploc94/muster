import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PUBLIC_MCP_TOOL_ACTIONS } from './capabilities';

const ROOT = path.resolve(__dirname, '..', '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function interfaceBody(source: string, interfaceName: string): string {
  const match = new RegExp(
    `export interface ${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  expect(match, `missing ${interfaceName}`).toBeTruthy();
  return match![1];
}

describe('M024 S04 agent-facing workflow graph boundary', () => {
  it('keeps graph topology out of the public MCP tool catalog and routing paths', () => {
    expect(PUBLIC_MCP_TOOL_ACTIONS).not.toContain('get_workflow_graph');
    expect(PUBLIC_MCP_TOOL_ACTIONS).not.toContain('getWorkflowGraphForTask');

    for (const relativePath of [
      'src/task/coordinator-tools.ts',
      'src/task/engine-graph.ts',
      'src/bridge/server.ts',
    ]) {
      expect(readSource(relativePath)).not.toContain('getWorkflowGraphForTask');
    }
  });

  it('keeps topology and graph-only fields out of agent status and inspection projections', () => {
    const types = readSource('src/task/workflow-types.ts');
    const status = interfaceBody(types, 'WorkflowTaskStatusProjection');
    const inspection = interfaceBody(types, 'WorkflowRunInspectionProjection');

    for (const publicProjection of [status, inspection]) {
      expect(publicProjection).not.toMatch(/\b(topology|edges|label|artifactId|artifactRevision)\s*[?:]/);
    }
    expect(status).not.toMatch(/\btaskId\s*[?:]/);
    expect(types).toMatch(/export interface WorkflowRunNodeInspectionProjection[\s\S]*?\btaskId\?\s*:/);
    expect(status).not.toContain('WorkflowGraph');
    expect(inspection).not.toContain('WorkflowGraph');
  });

  it('pins canonical named-input composition guidance across active public surfaces', () => {
    const server = readSource('src/bridge/server.ts');
    const bridgeDocs = readSource('docs/MUSTER-BRIDGE.md');
    const taskDocs = readSource('docs/TASK-MANAGEMENT.md');

    expect(server).toContain('{name,value} or {name,fromRun,output}');
    expect(bridgeDocs).toContain('{ "name": "plan", "fromRun": "run-ref", "output": "verifiedPlan" }');
    expect(taskDocs).toContain('(fromRun, outputName)');
    for (const source of [server, bridgeDocs, taskDocs]) {
      expect(source).not.toContain('{node, fromRun, fromNode, fromTask}');
      expect(source).not.toContain('reuse [{node, fromRun}]');
    }
  });
});
