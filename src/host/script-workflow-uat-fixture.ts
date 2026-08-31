import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch, type ToolCommand } from '../task/coordinator-tools';
import type { TaskEngine } from '../task/engine';
import type { TaskRepository } from '../task/repository';
import type { DbClient } from '../task/sqlite/client';
import type { MusterTask, TaskTurn } from '../task/types';

export const SCRIPT_WORKFLOW_UAT_RESULT_KIND = 'script-workflow-native-uat-result';

export interface ScriptWorkflowUatResult {
  ok: true;
  kind: typeof SCRIPT_WORKFLOW_UAT_RESULT_KIND;
  schemaVersion: 1;
  catalog: {
    workspaceShadowsGlobal: true;
    invalidFileDiagnosed: true;
    opaqueRefResolved: true;
    staleRefRejected: true;
    pathsRedacted: true;
  };
  policy: {
    disabledStartRejected: true;
    enabledStartAccepted: true;
  };
  runtime: {
    graphSucceeded: true;
    globalBundleExecuted: true;
    packageIntegrityRejected: true;
    exactStdoutPreserved: true;
    nextExitMetadataPreserved: true;
    nonzeroPrevCorrected: true;
    emptyPrevFeedbackSynthesized: true;
    stderrDiagnosticOnly: true;
    emptyStdoutSucceeded: true;
    nonzeroFailFailedOnce: true;
    noAcpSessionClaims: true;
    graphProjected: true;
  };
}

export interface ScriptWorkflowUatDeps {
  engine: Pick<TaskEngine, 'getProjection' | 'handleToolCall'>;
  repository: TaskRepository;
  client: DbClient;
  workspaceId: string;
  workspaceFolder: string;
  setHostRun: (enabled: boolean) => Promise<void>;
}

function assertQa(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`script workflow UAT: ${message}`);
}

async function waitForRun(
  repository: TaskRepository,
  runId: string,
  rootId: string,
): Promise<'succeeded' | 'failed'> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const completion = await repository.getWorkflowRunCompletion(runId, rootId);
    if (completion?.runStatus === 'succeeded' || completion?.runStatus === 'failed') {
      return completion.runStatus;
    }
    if (Date.now() >= deadline) throw new Error('script workflow UAT: workflow run timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForRejectedPackageRun(
  deps: ScriptWorkflowUatDeps,
  runId: string,
  rootId: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const completion = await deps.repository.getWorkflowRunCompletion(runId, rootId);
    if (completion?.runStatus === 'failed') return;
    const failedTurn = await deps.client.get<{ count: number }>(
      `SELECT COUNT(*) AS count
         FROM workflow_nodes node
         JOIN turns turn_row
           ON turn_row.workspace_id = node.workspace_id AND turn_row.task_id = node.task_id
        WHERE node.workspace_id = ? AND node.run_id = ? AND turn_row.status = 'failed'`,
      [deps.workspaceId, runId],
    );
    if ((failedTurn?.count ?? 0) > 0) return;
    if (Date.now() >= deadline) throw new Error('script workflow UAT: rejected workflow run timed out');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function context(rootId: string, turnId: string): CredentialContext {
  return {
    credentialId: `uat-${randomUUID()}`,
    rootId,
    callerTaskId: rootId,
    turnId,
    attemptId: `uat-attempt-${randomUUID()}`,
    allowedActions: new Set([
      'list_predefined_workflows',
      'get_predefined_workflow',
      'define_workflow',
      'start_workflow',
    ]),
    expiry: Date.now() + 120_000,
  };
}

function route(
  tool: string,
  args: Record<string, unknown>,
  credential: CredentialContext,
): ToolCommand {
  const routed = dispatch(tool, args, credential);
  if (!routed.ok) throw new Error(`script workflow UAT: ${tool} parse failed: ${routed.toolError}`);
  return routed.command;
}

function exitOutcome() {
  return {
    kind: 'exit',
    next: { when: { exitCode: 0 } },
    fail: { when: { exitCode: 'nonzero' } },
  };
}

function prevExitOutcome(targets: readonly string[]) {
  return {
    kind: 'exit',
    next: { when: { exitCode: 0 } },
    prev: { when: { exitCode: 'nonzero' }, targets, feedback: 'stdout' },
  };
}

function scriptNode(nodeKey: string, file: string, args: string[] = []) {
  return {
    nodeKey,
    script: { interpreter: 'node', file, args },
    outcome: exitOutcome(),
  };
}

function canonicalManifest(
  name: string,
  nodes: readonly Record<string, unknown>[],
  edges: readonly Record<string, unknown>[] = [],
  inputs: readonly Record<string, unknown>[] = [],
  outputs: readonly Record<string, unknown>[] = [{ name: 'result', kind: 'result', from: 'run' }],
): Record<string, unknown> {
  return {
    schema: 'muster.workflow/v2',
    name,
    description: `${name} description`,
    inputs,
    outputs,
    nodes,
    edges,
  };
}

async function writeCanonicalPackage(
  root: string,
  packageName: string,
  manifest: Record<string, unknown>,
  assets: Record<string, string>,
): Promise<string> {
  const packageRoot = join(root, packageName);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'workflow.json'), JSON.stringify(manifest), 'utf8');
  await Promise.all(Object.entries(assets).map(async ([relative, content]) => {
    const file = join(packageRoot, ...relative.split('/'));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content, 'utf8');
  }));
  return packageRoot;
}

async function invoke(
  deps: ScriptWorkflowUatDeps,
  credential: CredentialContext,
  tool: string,
  command: ToolCommand,
): Promise<unknown> {
  const result = await deps.engine.handleToolCall(credential, tool, command);
  if (!result.ok) throw new Error(`script workflow UAT: ${tool} failed: ${result.error}`);
  return result.result;
}

async function defineAndStart(
  deps: ScriptWorkflowUatDeps,
  credential: CredentialContext,
  semantic: Record<string, unknown>,
  goal: string,
): Promise<{ definitionId: string; runId: string; entryTaskId: string }> {
  const definition = route('define_workflow', semantic, credential);
  assertQa(definition.kind === 'define_workflow', 'define route returned the wrong command');
  const defined = await invoke(deps, credential, 'define_workflow', definition) as { definitionId?: unknown };
  const definitionId = 'definitionId' in definition
    ? definition.definitionId
    : defined.definitionId;
  assertQa(typeof definitionId === 'string', 'define route returned no definition identity');
  const start = route('start_workflow', {
    workflow: `${definitionId}@1`,
    goal,
  }, credential);
  assertQa(start.kind === 'start_workflow', 'start route returned the wrong command');
  const result = await invoke(deps, credential, 'start_workflow', start) as {
    runId?: unknown;
    entryTaskId?: unknown;
  };
  assertQa(typeof result.runId === 'string', 'start returned no runId');
  assertQa(typeof result.entryTaskId === 'string', 'start returned no entryTaskId');
  return { definitionId, runId: result.runId, entryTaskId: result.entryTaskId };
}

/**
 * Runs the feature through the activated extension's real repository, engine,
 * live hostRun setting, semantic tool parser, script process runner, and graph
 * projection. The returned object is deliberately redacted to booleans only.
 */
export async function runScriptWorkflowUatFixture(
  deps: ScriptWorkflowUatDeps,
): Promise<ScriptWorkflowUatResult> {
  const rootId = `uat-script-root-${randomUUID()}`;
  const turnId = `uat-script-turn-${randomUUID()}`;
  const now = new Date().toISOString();
  const root: MusterTask = {
    id: rootId,
    role: 'coordinator',
    lifecycle: 'open',
    releaseState: 'released',
    goal: 'Native script workflow QA coordinator',
    parentId: null,
    prerequisites: [],
    backend: 'grok',
    cwd: deps.workspaceFolder,
    capabilities: ['create_child'],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 1 },
    revision: 0,
    createdAt: now,
    updatedAt: now,
    releasedAt: now,
  };
  const turn: TaskTurn = {
    id: turnId,
    taskId: rootId,
    sequence: 1,
    status: 'running',
    trigger: 'user',
    inputs: [],
    createdAt: now,
    startedAt: now,
  };
  await deps.repository.execute({ kind: 'createTask', workspaceId: deps.workspaceId, task: root });
  await deps.repository.execute({ kind: 'createTurn', workspaceId: deps.workspaceId, turn });
  await deps.engine.getProjection()?.refreshTask(rootId);
  const credential = context(rootId, turnId);

   const workspaceCatalog = join(deps.workspaceFolder, '.muster', 'workflows');
   const globalCatalog = join(homedir(), '.muster', 'workflows');
   const globalBundle = join(globalCatalog, 'native-qa-bundle');
   const globalBundleManifest = join(globalBundle, 'workflow.json');
   const globalBundleScript = join(globalBundle, 'scripts', 'native-global.ts');
  await Promise.all([
    mkdir(workspaceCatalog, { recursive: true }),
    mkdir(globalCatalog, { recursive: true }),
    mkdir(join(globalBundle, 'scripts'), { recursive: true }),
    mkdir(join(deps.workspaceFolder, 'scripts'), { recursive: true }),
  ]);
   const savedName = `Native QA Saved Workflow ${randomUUID()}`;
   const workspaceSaved = join(workspaceCatalog, 'native-qa-saved');
   const globalSaved = join(globalCatalog, 'native-qa-saved');
   const invalidSaved = join(workspaceCatalog, 'native-qa-invalid');
   const savedManifest = (description: string) => ({
     ...canonicalManifest(
       savedName,
       [{ nodeKey: 'saved', taskType: 'review', instructions: { inline: 'Review the request.' } }],
       [],
       [],
       [{ name: 'result', kind: 'result', from: 'saved' }],
     ),
     description,
   });
   await Promise.all([
     writeCanonicalPackage(globalCatalog, 'native-qa-saved', savedManifest('global native QA'), {}),
     writeCanonicalPackage(workspaceCatalog, 'native-qa-saved', savedManifest('workspace native QA'), {}),
     mkdir(invalidSaved, { recursive: true }).then(() => writeFile(join(invalidSaved, 'workflow.json'), '{invalid json', 'utf8')),
     writeFile(globalBundleManifest, JSON.stringify(canonicalManifest(
       'Native global bundle',
       [scriptNode('global', 'scripts/native-global.ts')],
     )), 'utf8'),
     writeFile(globalBundleScript, [
       'const result: string = "global-bundle";',
       'process.stdout.write(result);',
    ].join('\n'), 'utf8'),
    writeFile(join(deps.workspaceFolder, 'scripts', 'native-global.ts'),
      'process.stdout.write("workspace-shadow");', 'utf8'),
    writeFile(join(deps.workspaceFolder, 'native-produce.js'), [
      // The metacharacter arrives as argv, so the assertion below proves the executor
      // passes args literally with no shell expansion. Hard-coding it in the output
      // would have passed without argv ever being exercised.
      "process.stdout.write('native-alpha\\n|' + process.argv[2]);",
      "process.stderr.write('native diagnostic');",
       'process.exitCode = 0;',
    ].join('\n'), 'utf8'),
    writeFile(join(deps.workspaceFolder, 'native-consume.js'), [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const parsed = JSON.parse(input);",
      "  process.stdout.write(parsed.dep.value + '|exit=' + parsed.dep.exitCode);",
      "});",
    ].join('\n'), 'utf8'),
    writeFile(join(deps.workspaceFolder, 'native-empty.js'),
      "process.stderr.write('empty native note')", 'utf8'),
    writeFile(join(deps.workspaceFolder, 'native-prev-producer.js'), [
      "const fs = require('node:fs');",
      "const file = process.cwd() + '/' + process.argv[2];",
      "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(file, String(count));",
      "process.stdout.write('native-prev-v' + count);",
    ].join('\n'), 'utf8'),
    writeFile(join(deps.workspaceFolder, 'native-prev-check.js'), [
      "const fs = require('node:fs');",
      "const file = process.cwd() + '/' + process.argv[2];",
      "const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;",
      "fs.writeFileSync(file, String(count));",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const parsed = JSON.parse(input);",
      "  if (count === 1) {",
      "    process.stderr.write('native PREV diagnostic only');",
      "    process.exitCode = 9;",
      "    return;",
      "  }",
      "  if (parsed.candidate.value !== 'native-prev-v2') throw new Error('native feedback revision missing');",
      "  process.stdout.write('native-prev-accepted');",
      "});",
    ].join('\n'), 'utf8'),
    writeFile(join(deps.workspaceFolder, 'native-fail.js'),
      "process.stderr.write('failure native note'); process.exitCode = 9;", 'utf8'),
  ]);

  let hostRunRestored = false;
  try {
    const listed = await invoke(
      deps,
      credential,
      'list_predefined_workflows',
      { kind: 'list_predefined_workflows' },
    ) as {
       workflows?: Array<{ workflowRef: string; name: string; description: string; scope: string; packageKind: string }>;
      diagnostics?: Array<{ file: string; code: string }>;
    };
    const selected = listed.workflows?.find((entry) => entry.name === savedName);
    assertQa(selected?.scope === 'workspace', 'workspace catalog did not shadow global');
    assertQa(selected.description === 'workspace native QA', 'workspace catalog metadata lost');
    assertQa(
     listed.diagnostics?.some((entry) =>
         entry.file === 'native-qa-invalid' && entry.code === 'invalid_workflow_file'),
      'invalid catalog file was not diagnosed',
    );
    assertQa(!JSON.stringify(listed).includes(deps.workspaceFolder), 'catalog list leaked a path');
    const globalBundleEntryRef = listed.workflows?.find((entry) => entry.name === 'Native global bundle');
    assertQa(
      globalBundleEntryRef?.scope === 'global' &&
      globalBundleEntryRef.packageKind === 'bundle',
      'global bundle was not discoverable as a bundle',
    );
    const loaded = await invoke(
      deps,
      credential,
      'get_predefined_workflow',
      { kind: 'get_predefined_workflow', workflowRef: selected.workflowRef },
     ) as { name?: unknown; description?: unknown; body?: unknown; provenance?: unknown };
     assertQa(loaded.name === savedName, 'opaque catalog ref returned wrong metadata');
     assertQa(loaded.description === 'workspace native QA', 'catalog metadata was not explicit');
     assertQa(loaded.body === undefined && loaded.provenance === undefined, 'catalog returned package body');
     await writeFile(join(workspaceSaved, 'workflow.json'), JSON.stringify(savedManifest('workspace native QA changed')), 'utf8');
    const stale = await deps.engine.handleToolCall(
      credential,
      'get_predefined_workflow',
      { kind: 'get_predefined_workflow', workflowRef: selected.workflowRef },
    );
    assertQa(!stale.ok && /not found or changed/.test(stale.error), 'stale catalog ref was accepted');

     const dataflowDefinition = route('define_workflow', {
       manifest: canonicalManifest(
         `Native script dataflow ${rootId}`,
         [
           scriptNode('produce', 'native-produce.js', ['a;$(literal)']),
           scriptNode('consume', 'native-consume.js'),
         ],
         [{ from: 'produce', to: 'consume', inputRef: 'dep' }],
         [],
         [{ name: 'result', kind: 'result', from: 'consume' }],
       ),
     }, credential);
     assertQa(dataflowDefinition.kind === 'define_workflow', 'dataflow definition route failed');
     assertQa('definitionId' in dataflowDefinition, 'inline dataflow definition returned no identity');
     await invoke(deps, credential, 'define_workflow', dataflowDefinition);
    const dataflowStart = route('start_workflow', {
      workflow: `${dataflowDefinition.definitionId}@1`,
      goal: 'Native dataflow QA',
    }, credential);
    assertQa(dataflowStart.kind === 'start_workflow', 'dataflow start route failed');

    await deps.setHostRun(false);
    const denied = await deps.engine.handleToolCall(
      credential,
      'start_workflow',
      dataflowStart,
    );
    assertQa(!denied.ok && /host_run_disabled/.test(denied.error), 'disabled hostRun did not deny start');
    // The error string alone would also appear if the run had been created and then
    // rejected downstream. Denial must leave no run, no node and no materialized task.
    const deniedRuns = await deps.client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workflow_runs
        WHERE workspace_id = ? AND definition_id = ?`,
      [deps.workspaceId, dataflowDefinition.definitionId],
    );
    assertQa(deniedRuns?.count === 0, 'denied start persisted a workflow run');
    const deniedTasks = await deps.client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM tasks
        WHERE workspace_id = ? AND parent_id = ? AND id != ?`,
      [deps.workspaceId, rootId, rootId],
    );
    assertQa(deniedTasks?.count === 0, 'denied start materialized a node task');

    await deps.setHostRun(true);
    const dataflowResult = await invoke(
      deps,
      credential,
      'start_workflow',
      dataflowStart,
    ) as { runId?: unknown; entryTaskId?: unknown };
    assertQa(typeof dataflowResult.runId === 'string', 'dataflow start returned no runId');
    assertQa(typeof dataflowResult.entryTaskId === 'string', 'dataflow start returned no entry task');
    assertQa(
      await waitForRun(deps.repository, dataflowResult.runId, rootId) === 'succeeded',
      'continue dataflow did not succeed',
    );

     const globalBundleRun = await defineAndStart(deps, credential, {
       predefinedWorkflowRef: globalBundleEntryRef!.workflowRef,
     }, 'Native global bundle QA');
    assertQa(
      await waitForRun(deps.repository, globalBundleRun.runId, rootId) === 'succeeded',
      'global bundle workflow did not succeed',
    );
    const globalBundleArtifact = await deps.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result' LIMIT 1`,
      [deps.workspaceId, globalBundleRun.runId],
    );
    assertQa(
      JSON.parse(globalBundleArtifact!.payload_json).result === 'global-bundle',
      'global bundle resolved the workspace shadow instead of its package script',
    );
    await writeFile(globalBundleScript, [
      'const result: string = "changed-global-bundle";',
      'process.stdout.write(result);',
    ].join('\n'), 'utf8');
     const staleGlobalBundleStart = route('start_workflow', {
      workflow: `${globalBundleRun.definitionId}@1`,
      goal: 'Native changed package rejection',
    }, credential);
    assertQa(staleGlobalBundleStart.kind === 'start_workflow', 'stale global bundle start route failed');
    const staleGlobalBundleResult = await invoke(
      deps,
      credential,
      'start_workflow',
      staleGlobalBundleStart,
    ) as { runId?: unknown };
    assertQa(typeof staleGlobalBundleResult.runId === 'string', 'stale global bundle start returned no runId');
    await waitForRejectedPackageRun(deps, staleGlobalBundleResult.runId, rootId);
    const staleGlobalBundleArtifact = await deps.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
         WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result' LIMIT 1`,
      [deps.workspaceId, staleGlobalBundleResult.runId],
    );
    assertQa(!staleGlobalBundleArtifact, 'changed global bundle produced a successful artifact');
    const artifacts = await deps.client.all<{
      producer_node_id: string;
      payload_json: string;
    }>(
      `SELECT producer_node_id, payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'`,
      [deps.workspaceId, dataflowResult.runId],
    );
    const producerArtifact = JSON.parse(
      artifacts.find((entry) => entry.producer_node_id === 'produce')!.payload_json,
    ) as Record<string, unknown>;
    const consumerArtifact = JSON.parse(
      artifacts.find((entry) => entry.producer_node_id === 'consume')!.payload_json,
    ) as Record<string, unknown>;
    assertQa(
      producerArtifact.result === 'native-alpha\n|a;$(literal)',
      'producer stdout was not preserved exactly',
    );
    assertQa(
      JSON.stringify(producerArtifact).includes('"exitCode":0'),
      'NEXT exit metadata was not persisted',
    );
    assertQa(
      consumerArtifact.result === 'native-alpha\n|a;$(literal)|exit=0',
      'downstream stdin dataflow lost stdout or exit metadata',
    );
    assertQa(!JSON.stringify(artifacts).includes('native diagnostic'), 'stderr leaked into an artifact');
    const nodeTasks = await deps.client.all<{ node_id: string; task_id: string | null }>(
      `SELECT node_id, task_id FROM workflow_nodes
        WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
      [deps.workspaceId, dataflowResult.runId],
    );
    const producerTaskId = nodeTasks.find((entry) => entry.node_id === 'produce')?.task_id;
    assertQa(typeof producerTaskId === 'string', 'producer task was not materialized');
    const producerTurns = await deps.repository.listTurns(producerTaskId);
    assertQa(
      producerTurns.some((entry) =>
        entry.executionResult?.stderr === 'native diagnostic' &&
        entry.executionResult.exitCode === 0),
      'stderr was not retained on the producing turn',
    );
    const sessionClaims = await deps.client.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM session_claims claim
        JOIN turns turn_row
          ON turn_row.workspace_id = claim.workspace_id AND turn_row.id = claim.turn_id
        WHERE claim.workspace_id = ? AND turn_row.task_id IN (
          SELECT task_id FROM workflow_nodes WHERE workspace_id = ? AND run_id = ?
        )`,
      [deps.workspaceId, deps.workspaceId, dataflowResult.runId],
    );
    assertQa(sessionClaims?.count === 0, 'script nodes created ACP session claims');
    const graph = await deps.repository.getWorkflowGraphForTask(dataflowResult.entryTaskId);
    assertQa(graph?.nodes.length === 2 && graph.edges.length === 1, 'script graph projection was incomplete');

     const empty = await defineAndStart(deps, credential, {
       manifest: canonicalManifest(
         `Native empty stdout ${rootId}`,
         [scriptNode('empty', 'native-empty.js')],
         [],
         [],
         [{ name: 'result', kind: 'result', from: 'empty' }],
       ),
     }, 'Native empty stdout QA');
    assertQa(await waitForRun(deps.repository, empty.runId, rootId) === 'succeeded', 'empty stdout failed');
    const emptyArtifact = await deps.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result' LIMIT 1`,
      [deps.workspaceId, empty.runId],
    );
    assertQa(
      JSON.parse(emptyArtifact!.payload_json).result === '',
      'empty stdout was dropped from the artifact',
    );

    const producerCounter = `.native-prev-producer-${rootId}.count`;
    const checkCounter = `.native-prev-check-${rootId}.count`;
    const corrected = await defineAndStart(deps, credential, {
      manifest: canonicalManifest(
        `Native PREV correction ${rootId}`,
        [
          scriptNode('producer', 'native-prev-producer.js', [producerCounter]),
          {
            nodeKey: 'check',
            title: 'Native PREV check',
            script: { interpreter: 'node', file: 'native-prev-check.js', args: [checkCounter] },
            outcome: prevExitOutcome(['candidate']),
          },
        ],
        [{ from: 'producer', to: 'check', inputRef: 'candidate' }],
        [],
        [{ name: 'result', kind: 'result', from: 'check' }],
      ),
    }, 'Native PREV correction QA');
    assertQa(
      await waitForRun(deps.repository, corrected.runId, rootId) === 'succeeded',
      'declared nonzero PREV correction did not succeed',
    );
    const correctedNodes = await deps.client.all<{ node_id: string; task_id: string | null }>(
      `SELECT node_id, task_id FROM workflow_nodes
        WHERE workspace_id = ? AND run_id = ? ORDER BY node_id`,
      [deps.workspaceId, corrected.runId],
    );
    const checkTaskId = correctedNodes.find((entry) => entry.node_id === 'check')?.task_id;
    assertQa(typeof checkTaskId === 'string', 'PREV check task was not materialized');
    const checkTurns = await deps.repository.listTurns(checkTaskId);
    const prevTurn = checkTurns.find((entry) => entry.disposition?.kind === 'workflow_prev');
    assertQa(checkTurns.length === 2 && prevTurn, 'PREV check did not settle exactly once per activation');
    assertQa(
      prevTurn.disposition?.kind === 'workflow_prev' &&
      prevTurn.disposition.targets !== 'all' &&
      prevTurn.disposition.targets.length === 1 &&
      prevTurn.disposition.targets[0] === 'candidate',
      'nonzero PREV did not preserve the declared target',
    );
    assertQa(
      prevTurn.disposition?.kind === 'workflow_prev' &&
      prevTurn.disposition.note?.includes('Native PREV check') &&
      prevTurn.disposition.note.includes('code 9') &&
      !prevTurn.disposition.note.includes('native PREV diagnostic only'),
      'empty stdout did not synthesize diagnostic-safe PREV feedback',
    );
    const correctedRounds = await deps.client.all<{ status: string }>(
      'SELECT status FROM workflow_feedback_rounds WHERE workspace_id = ? AND run_id = ?',
      [deps.workspaceId, corrected.runId],
    );
    assertQa(
      correctedRounds.length === 1 && correctedRounds[0]?.status === 'consumed',
      'PREV feedback round did not complete exactly once',
    );
    const correctedArtifact = await deps.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'check' AND kind = 'next_result'`,
      [deps.workspaceId, corrected.runId],
    );
    assertQa(
      correctedArtifact !== undefined &&
      JSON.parse(correctedArtifact.payload_json).result === 'native-prev-accepted',
      'PREV resume did not consume the revised producer artifact',
    );

     const failed = await defineAndStart(deps, credential, {
       manifest: canonicalManifest(
         `Native fail run ${rootId}`,
         [scriptNode('fail', 'native-fail.js')],
         [],
         [],
         [{ name: 'result', kind: 'result', from: 'fail' }],
       ),
     }, 'Native fail QA');
    assertQa(await waitForRun(deps.repository, failed.runId, rootId) === 'failed', 'declared nonzero FAIL succeeded');
    assertQa((await deps.repository.listTurns(failed.entryTaskId)).length === 1, 'declared nonzero FAIL retried');

    await deps.setHostRun(false);
    hostRunRestored = true;
    return {
      ok: true,
      kind: SCRIPT_WORKFLOW_UAT_RESULT_KIND,
      schemaVersion: 1,
      catalog: {
        workspaceShadowsGlobal: true,
        invalidFileDiagnosed: true,
        opaqueRefResolved: true,
        staleRefRejected: true,
        pathsRedacted: true,
      },
      policy: {
        disabledStartRejected: true,
        enabledStartAccepted: true,
      },
      runtime: {
        graphSucceeded: true,
        globalBundleExecuted: true,
        packageIntegrityRejected: true,
        exactStdoutPreserved: true,
        nextExitMetadataPreserved: true,
        nonzeroPrevCorrected: true,
        emptyPrevFeedbackSynthesized: true,
        stderrDiagnosticOnly: true,
        emptyStdoutSucceeded: true,
        nonzeroFailFailedOnce: true,
        noAcpSessionClaims: true,
        graphProjected: true,
      },
    };
  } finally {
    if (!hostRunRestored) await deps.setHostRun(false).catch(() => undefined);
  }
}
