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
    continueExitMetadataPreserved: true;
    stderrDiagnosticOnly: true;
    emptyStdoutSucceeded: true;
    failRunFailedOnce: true;
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
  await invoke(deps, credential, 'define_workflow', definition);
  const start = route('start_workflow', {
    workflow: `${definition.definitionId}@1`,
    goal,
  }, credential);
  assertQa(start.kind === 'start_workflow', 'start route returned the wrong command');
  const result = await invoke(deps, credential, 'start_workflow', start) as {
    runId?: unknown;
    entryTaskId?: unknown;
  };
  assertQa(typeof result.runId === 'string', 'start returned no runId');
  assertQa(typeof result.entryTaskId === 'string', 'start returned no entryTaskId');
  return { definitionId: definition.definitionId, runId: result.runId, entryTaskId: result.entryTaskId };
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
   const globalBundleEntry = join(globalBundle, 'native-qa-bundle.md');
   const globalBundleScript = join(globalBundle, 'scripts', 'native-global.ts');
  await Promise.all([
    mkdir(workspaceCatalog, { recursive: true }),
    mkdir(globalCatalog, { recursive: true }),
    mkdir(join(globalBundle, 'scripts'), { recursive: true }),
    mkdir(join(deps.workspaceFolder, 'scripts'), { recursive: true }),
  ]);
  const savedName = `Native QA Saved Workflow ${randomUUID()}`;
  const workspaceSaved = join(workspaceCatalog, 'native-qa-saved.md');
  const globalSaved = join(globalCatalog, 'native-qa-saved.md');
  const invalidSaved = join(workspaceCatalog, 'native-qa-invalid.md');
  const markdown = (description: string, body: string) => [
    '---',
    `name: ${savedName}`,
    `description: ${description}`,
    '---',
    body,
  ].join('\n');
  await Promise.all([
    writeFile(globalSaved, markdown('global native QA', 'Global native QA body'), 'utf8'),
    writeFile(workspaceSaved, markdown('workspace native QA', 'Workspace native QA body'), 'utf8'),
    writeFile(invalidSaved, 'invalid workflow without frontmatter', 'utf8'),
    writeFile(globalBundleEntry, [
      '---',
      'name: Native global bundle',
      'description: Global bundle package-root proof',
      '---',
      'Run the global package script.',
    ].join('\n'), 'utf8'),
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
      'process.exitCode = 3;',
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
        entry.file === 'native-qa-invalid.md' && entry.code === 'invalid_workflow_file'),
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
    ) as { body?: unknown; provenance?: unknown };
    assertQa(loaded.body === 'Workspace native QA body', 'opaque catalog ref returned wrong body');
    assertQa(loaded.provenance === 'user-authored-untrusted', 'catalog provenance was not explicit');
    await writeFile(workspaceSaved, markdown('workspace native QA changed', 'Changed body'), 'utf8');
    const stale = await deps.engine.handleToolCall(
      credential,
      'get_predefined_workflow',
      { kind: 'get_predefined_workflow', workflowRef: selected.workflowRef },
    );
    assertQa(!stale.ok && /not found or changed/.test(stale.error), 'stale catalog ref was accepted');

    const dataflowDefinition = route('define_workflow', {
      name: `Native script dataflow ${rootId}`,
      nodes: [
        {
          nodeKey: 'produce',
          script: {
            interpreter: 'node',
            file: 'native-produce.js',
            // Shell metacharacters as a real argv entry: the producer echoes
            // `process.argv[2]`, so the downstream assertion fails if the executor
            // ever expands or re-quotes an argument.
            args: ['a;$(literal)'],
            onFailure: 'continue',
          },
        },
        {
          nodeKey: 'consume',
          script: { interpreter: 'node', file: 'native-consume.js' },
        },
      ],
      edges: [{ from: 'produce', to: 'consume', as: 'dep' }],
    }, credential);
    assertQa(dataflowDefinition.kind === 'define_workflow', 'dataflow definition route failed');
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
      name: `Native global bundle execution ${rootId}`,
      predefinedWorkflowRef: globalBundleEntryRef!.workflowRef,
      nodes: [{
        nodeKey: 'global',
        script: { interpreter: 'node', file: 'scripts/native-global.ts' },
      }],
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
      JSON.stringify(producerArtifact).includes('"exitCode":3'),
      'continue exit metadata was not persisted',
    );
    assertQa(
      consumerArtifact.result === 'native-alpha\n|a;$(literal)|exit=3',
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
        entry.executionResult.exitCode === 3),
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
      name: `Native empty stdout ${rootId}`,
      nodes: [{
        nodeKey: 'empty',
        script: { interpreter: 'node', file: 'native-empty.js' },
      }],
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

    const failed = await defineAndStart(deps, credential, {
      name: `Native fail run ${rootId}`,
      nodes: [{
        nodeKey: 'fail',
        script: {
          interpreter: 'node',
          file: 'native-fail.js',
          onFailure: 'fail_run',
        },
      }],
    }, 'Native fail_run QA');
    assertQa(await waitForRun(deps.repository, failed.runId, rootId) === 'failed', 'fail_run succeeded');
    assertQa((await deps.repository.listTurns(failed.entryTaskId)).length === 1, 'fail_run retried');

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
        continueExitMetadataPreserved: true,
        stderrDiagnosticOnly: true,
        emptyStdoutSucceeded: true,
        failRunFailedOnce: true,
        noAcpSessionClaims: true,
        graphProjected: true,
      },
    };
  } finally {
    if (!hostRunRestored) await deps.setHostRun(false).catch(() => undefined);
  }
}
