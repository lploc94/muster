import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  SCRIPT_WORKFLOW_UAT_RESULT_KIND,
  type ScriptWorkflowUatResult,
} from '../src/host/script-workflow-uat-fixture';
import { UAT_COMMANDS } from '../src/host/uat-commands';

export interface ScriptWorkflowNativeHostResult {
  ok: true;
  kind: 'script-workflow-native-host-result';
  schemaVersion: 1;
  vscodeVersion: string;
  hostMode: 'extension-development-host';
  observation: ScriptWorkflowUatResult;
}

function writeResult(result: ScriptWorkflowNativeHostResult): void {
  const output = process.env.MUSTER_UAT_HOST_RESULT_OUT;
  if (!output) return;
  fs.writeFileSync(`${output}.tmp`, `${JSON.stringify(result)}\n`);
  fs.renameSync(`${output}.tmp`, output);
}

function assertAllTrue(record: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(record)) {
    assert.equal(value, true, `${label}.${key} was not proven`);
  }
}

export async function run(): Promise<void> {
  assert.equal(process.env.MUSTER_UAT_MODE, '1', 'MUSTER_UAT_MODE=1 is required');
  const extension = vscode.extensions.getExtension('tlelabs.muster');
  assert.ok(extension, 'packaged tlelabs.muster extension was not discovered');
  await extension.activate();
  assert.equal(extension.isActive, true, 'packaged extension failed to activate');
  assert.equal(vscode.workspace.workspaceFolders?.length, 1, 'one disposable workspace is required');

  const observation = await vscode.commands.executeCommand<ScriptWorkflowUatResult>(
    UAT_COMMANDS.runScriptWorkflowQa,
  );
  assert.ok(observation, 'native host returned no script workflow observation');
  assert.equal(observation.ok, true);
  assert.equal(observation.kind, SCRIPT_WORKFLOW_UAT_RESULT_KIND);
  assert.equal(observation.schemaVersion, 1);
  assertAllTrue(observation.catalog, 'catalog');
  assertAllTrue(observation.policy, 'policy');
  assertAllTrue(observation.runtime, 'runtime');

  const result: ScriptWorkflowNativeHostResult = {
    ok: true,
    kind: 'script-workflow-native-host-result',
    schemaVersion: 1,
    vscodeVersion: vscode.version,
    hostMode: 'extension-development-host',
    observation,
  };
  writeResult(result);
  console.log(
    `[script-workflow-native-host] PASS vscode=${vscode.version} ` +
      `catalog=${Object.keys(observation.catalog).length} ` +
      `policy=${Object.keys(observation.policy).length} ` +
      `runtime=${Object.keys(observation.runtime).length}`,
  );
}
