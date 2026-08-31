import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeBackend } from '../backends';
import type { CredentialContext } from '../bridge/credentials';
import { dispatch } from './coordinator-tools';
import { TaskEngine } from './engine';
import { SqliteTaskRepository } from './repository';
import { DbClient } from './sqlite/client';

const cleanups: Array<() => Promise<void>> = [];

async function fixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `muster-script-workflow-${label}-`));
  const globalWorkflowFolder = mkdtempSync(join(tmpdir(), `muster-script-workflow-global-${label}-`));
  const client = new DbClient({
    workerPath: join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(join(dir, 'muster.sqlite3'));
  await client.run(
    `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['ws', `script-workflow-${label}`, 'Script workflow test', 'now', 'now'],
  );
  const repository = new SqliteTaskRepository(client, 'ws');
  let engine: TaskEngine | undefined;
  cleanups.push(async () => {
    await engine?.shutdown().catch(() => undefined);
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(globalWorkflowFolder, { recursive: true, force: true });
  });
  return {
    dir,
    globalWorkflowFolder,
    client,
    repository,
    setEngine(value: TaskEngine) { engine = value; },
  };
}

async function waitForRun(client: DbClient, runId: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const row = await client.get<{ status: string }>(
      'SELECT status FROM workflow_runs WHERE workspace_id = ? AND run_id = ?',
      ['ws', runId],
    );
    if (row?.status !== 'running') return row?.status;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

function exitOutcome() {
  return {
    kind: 'exit',
    next: { when: { exitCode: 0 } },
    fail: { when: { exitCode: 'nonzero' } },
  };
}

function workflowManifest(
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

function scriptManifestNode(nodeKey: string, file: string): Record<string, unknown> {
  return {
    nodeKey,
    script: { interpreter: 'node', file, args: [] },
    outcome: exitOutcome(),
  };
}

function writePackage(
  root: string,
  packageName: string,
  value: Record<string, unknown>,
  assets: Record<string, string>,
): string {
  const packageRoot = join(root, packageName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'workflow.json'), JSON.stringify(value));
  for (const [relative, content] of Object.entries(assets)) {
    const file = join(packageRoot, ...relative.split('/'));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  return packageRoot;
}

function toolContext(rootId: string, turnId: string, label: string): CredentialContext {
  return {
    credentialId: `script-${label}`,
    rootId,
    callerTaskId: rootId,
    turnId,
    attemptId: `script-${label}-attempt`,
    allowedActions: new Set([
      'list_predefined_workflows',
      'get_predefined_workflow',
      'define_workflow',
      'start_workflow',
    ]),
    expiry: Date.now() + 60_000,
  };
}

async function coordinator(
  ctx: Awaited<ReturnType<typeof fixture>>,
  label: string,
): Promise<{ engine: TaskEngine; root: { taskId: string; turnId: string }; context: CredentialContext; release: () => void }> {
  let releaseRoot!: () => void;
  const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
  const engine = await TaskEngine.loadAsync({
    repository: ctx.repository,
    workspaceId: 'ws',
    workspaceFolder: ctx.dir,
    globalWorkflowFolder: ctx.globalWorkflowFolder,
    makeBackend,
    isWorkspaceTrusted: () => true,
    allowHostVerification: true,
    runTurn: async function* (backend, options) {
      if (backend.name === 'script') {
        yield* backend.run(options);
        return;
      }
      await rootGate;
      yield { type: 'turnCompleted' };
    },
  });
  ctx.setEngine(engine);
  const started = await engine.startNewTask({
    goal: `${label} coordinator`,
    backend: 'grok',
    role: 'coordinator',
    cwd: ctx.dir,
  });
  if (!started.ok) throw new Error(`${label} root failed: ${started.reason}`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await ctx.repository.getTurn(started.value.turnId))?.status === 'running') break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return {
    engine,
    root: { taskId: started.value.taskId, turnId: started.value.turnId },
    context: toolContext(started.value.taskId, started.value.turnId, label),
    release: releaseRoot,
  };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('script workflow runtime', () => {
  it('defines and executes a canonical saved package through the public host path', async () => {
    const ctx = await fixture('public-path');
    const packageRoot = join(ctx.dir, '.muster', 'workflows');
    writePackage(
      packageRoot,
      'public',
      workflowManifest(
        'Public QA workflow',
        [
          scriptManifestNode('produce', 'scripts/produce.js'),
          scriptManifestNode('consume', 'scripts/consume.js'),
        ],
        [{ from: 'produce', to: 'consume', inputRef: 'dep' }],
        [{ name: 'request', kind: 'request', to: 'produce', inputRef: 'request' }],
        [{ name: 'result', kind: 'result', from: 'consume' }],
      ),
      {
        'scripts/produce.js': [
          "process.stdout.write('public-alpha\\n');",
          "process.stderr.write('public diagnostic');",
        ].join('\n'),
        'scripts/consume.js': [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', chunk => input += chunk);",
          "process.stdin.on('end', () => {",
          "  const parsed = JSON.parse(input);",
          "  process.stdout.write(parsed.dep.value + 'exit=' + parsed.dep.exitCode);",
          '});',
        ].join('\n'),
      },
    );
    writePackage(
      packageRoot,
      'invalid-freeze',
      workflowManifest('Invalid freeze package', [{
        nodeKey: 'run',
        taskType: 'review',
        instructions: { file: 'prompts/missing.md' },
      }]),
      {},
    );
    const swapPackageRoot = writePackage(
      packageRoot,
      'symlink-swap',
      workflowManifest('Symlink swap package', [{
        nodeKey: 'run',
        taskType: 'review',
        instructions: { file: 'prompts/check.md' },
      }]),
      { 'prompts/check.md': 'original prompt' },
    );
    const running = await coordinator(ctx, 'public-path');
    const listed = await running.engine.handleToolCall(
      running.context,
      'list_predefined_workflows',
      { kind: 'list_predefined_workflows' },
    );
    expect(listed).toMatchObject({
      ok: true,
      result: {
        workflows: expect.arrayContaining([
          expect.objectContaining({ name: 'Public QA workflow', packageKind: 'bundle' }),
        ]),
      },
    });
    if (!listed.ok) return;
    const listedWorkflows = (listed.result as { workflows: Array<{ workflowRef: string; name: string }> }).workflows;
    const invalidRef = listedWorkflows.find((workflow) => workflow.name === 'Invalid freeze package')!.workflowRef;
    const definitionsBeforeInvalidDefine = await ctx.client.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id = ?',
      ['ws'],
    );
    const invalidDefine = dispatch('define_workflow', { predefinedWorkflowRef: invalidRef }, running.context);
    if (!invalidDefine.ok || invalidDefine.command.kind !== 'define_workflow') return;
    await expect(running.engine.handleToolCall(running.context, 'define_workflow', invalidDefine.command)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('predefined_workflow_asset_invalid'),
    });
    const definitionsAfterInvalidDefine = await ctx.client.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id = ?',
      ['ws'],
    );
    expect(definitionsAfterInvalidDefine?.count).toBe(definitionsBeforeInvalidDefine?.count);

    if (process.platform !== 'win32') {
      const originalPrompt = join(swapPackageRoot, 'prompts', 'check.md');
      renameSync(originalPrompt, join(swapPackageRoot, 'prompts', 'check.real.md'));
      const outsidePrompt = join(ctx.dir, 'outside-prompt.md');
      writeFileSync(outsidePrompt, 'outside prompt');
      symlinkSync(outsidePrompt, originalPrompt);
      const swapRef = listedWorkflows.find((workflow) => workflow.name === 'Symlink swap package')!.workflowRef;
      const definitionsBeforeSwapDefine = await ctx.client.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id = ?',
        ['ws'],
      );
      const swapDefine = dispatch('define_workflow', { predefinedWorkflowRef: swapRef }, running.context);
      if (!swapDefine.ok || swapDefine.command.kind !== 'define_workflow') return;
      await expect(running.engine.handleToolCall(running.context, 'define_workflow', swapDefine.command)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('predefined_workflow_stale'),
      });
      const definitionsAfterSwapDefine = await ctx.client.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM workflow_definitions WHERE workspace_id = ?',
        ['ws'],
      );
      expect(definitionsAfterSwapDefine?.count).toBe(definitionsBeforeSwapDefine?.count);
    }

    const workflowRef = listedWorkflows.find((workflow) => workflow.name === 'Public QA workflow')!.workflowRef;
    await expect(running.engine.handleToolCall(
      running.context,
      'get_predefined_workflow',
      { kind: 'get_predefined_workflow', workflowRef },
    )).resolves.toMatchObject({
      ok: true,
      result: { name: 'Public QA workflow', packageKind: 'bundle' },
    });

    const routedDefinition = dispatch('define_workflow', { predefinedWorkflowRef: workflowRef }, running.context);
    expect(routedDefinition.ok).toBe(true);
    if (!routedDefinition.ok || routedDefinition.command.kind !== 'define_workflow') return;
    expect(routedDefinition.command).toEqual({
      kind: 'define_workflow',
      opId: expect.any(String),
      predefinedWorkflowRef: workflowRef,
    });
    const defined = await running.engine.handleToolCall(running.context, 'define_workflow', routedDefinition.command);
    expect(defined).toMatchObject({ ok: true });
    if (!defined.ok) return;
    const definitionId = (defined.result as { definitionId: string }).definitionId;
    expect(await ctx.repository.getWorkflowDefinition(definitionId, 1)).toMatchObject({
      name: 'Public QA workflow',
      topology: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            execution: expect.objectContaining({
              source: expect.objectContaining({ packagePath: 'public' }),
            }),
          }),
        ]),
      },
    });

    const startCommand = dispatch('start_workflow', {
      workflow: `${definitionId}@1`,
      goal: 'run public package',
      inputs: [{ name: 'request', value: 'public request' }],
    }, running.context);
    expect(startCommand.ok).toBe(true);
    if (!startCommand.ok || startCommand.command.kind !== 'start_workflow') return;
    const started = await running.engine.handleToolCall(running.context, 'start_workflow', startCommand.command);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const runId = (started.result as { runId: string }).runId;
    expect(await waitForRun(ctx.client, runId)).toBe('succeeded');
    const terminal = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
         WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'consume'`,
      ['ws', runId],
    );
    expect(JSON.parse(terminal!.payload_json)).toHaveProperty('result', 'public-alpha\nexit=0');
    expect(JSON.stringify(await ctx.repository.getWorkflowDefinition(definitionId, 1))).not.toContain(packageRoot);
    running.release();
  }, 30_000);

  it('feeds exact canonical script stdout and exit metadata downstream while keeping stderr diagnostic-only', async () => {
    const ctx = await fixture('dataflow');
    writeFileSync(join(ctx.dir, 'produce.js'), [
      "process.stdout.write('alpha');",
      "process.stderr.write('producer diagnostic');",
    ].join('\n'));
    writeFileSync(join(ctx.dir, 'consume.js'), [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const parsed = JSON.parse(input);",
      "  process.stdout.write(parsed.dep.value + '|' + parsed.dep.exitCode);",
      '});',
    ].join('\n'));
    const createdAt = new Date().toISOString();
    const topology = {
      kind: 'workflow',
      inputs: [],
      outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'consume' }],
      nodes: [
        { nodeId: 'produce', backend: 'script', execution: { kind: 'script', interpreter: 'node', file: 'produce.js', args: [] }, outcome: exitOutcome() },
        { nodeId: 'consume', backend: 'script', execution: { kind: 'script', interpreter: 'node', file: 'consume.js', args: [] }, outcome: exitOutcome() },
      ],
      edges: [{ fromNodeId: 'produce', toNodeId: 'consume', inputRef: 'dep', expectedArtifactKind: 'next_result' }],
    };
    await ctx.repository.execute({
      kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId: 'wf-script-dataflow', version: 1,
      name: 'script dataflow', topology, entryContracts: [], createdAt,
    });
    const started = await ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-script-dataflow', version: 1,
      startIdempotencyKey: 'script-dataflow-1', createdAt, goal: 'run scripts', backend: 'grok',
    });
    const start = started.operation!.result.data as { runId: string; entryTaskId: string; activationTurnId: string };
    const engine = await TaskEngine.loadAsync({
      repository: ctx.repository, workspaceId: 'ws', workspaceFolder: ctx.dir, makeBackend,
      isWorkspaceTrusted: () => true, allowHostVerification: true,
    });
    ctx.setEngine(engine);
    expect(await waitForRun(ctx.client, start.runId)).toBe('succeeded');
    const producerTurn = await ctx.repository.getTurn(start.activationTurnId);
    expect(producerTurn).toMatchObject({
      status: 'succeeded',
      disposition: { kind: 'workflow_next', result: 'alpha', execution: { kind: 'script', exitCode: 0 } },
      executionResult: { kind: 'script', exitCode: 0, stderr: 'producer diagnostic' },
    });
    const artifacts = await ctx.client.all<{ producer_node_id: string; payload_json: string }>(
      `SELECT producer_node_id, payload_json FROM workflow_artifacts
         WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result' ORDER BY producer_node_id`,
      ['ws', start.runId],
    );
    const producerArtifact = JSON.parse(artifacts.find((artifact) => artifact.producer_node_id === 'produce')!.payload_json);
    expect(producerArtifact).toMatchObject({ result: 'alpha', execution: { kind: 'script', exitCode: 0 } });
    expect(producerArtifact).not.toHaveProperty('stderr');
    expect(JSON.stringify(producerArtifact)).not.toContain('producer diagnostic');
    expect(artifacts.map((artifact) => JSON.parse(artifact.payload_json))).toEqual(
      expect.arrayContaining([expect.objectContaining({ result: 'alpha|0' })]),
    );
  }, 30_000);

  it('executes a global canonical package from its package root while process cwd remains the workspace', async () => {
    const ctx = await fixture('global-bundle');
    const bundle = writePackage(
      ctx.globalWorkflowFolder,
      'workflow-a',
      workflowManifest('Global package QA workflow', [scriptManifestNode('run', 'scripts/node_1.ts')]),
      { 'scripts/node_1.ts': 'process.stdout.write("global-package|" + process.cwd());' },
    );
    mkdirSync(join(ctx.dir, 'scripts'), { recursive: true });
    writeFileSync(join(ctx.dir, 'scripts', 'node_1.ts'), 'process.stdout.write("workspace-shadow");');
    const running = await coordinator(ctx, 'global-bundle');
    const listed = await running.engine.handleToolCall(running.context, 'list_predefined_workflows', { kind: 'list_predefined_workflows' });
    expect(listed).toMatchObject({
      ok: true,
      result: { workflows: [expect.objectContaining({ name: 'Global package QA workflow', scope: 'global', packageKind: 'bundle' })] },
    });
    if (!listed.ok) return;
    const ref = (listed.result as { workflows: Array<{ workflowRef: string }> }).workflows[0]!.workflowRef;
    const routed = dispatch('define_workflow', { predefinedWorkflowRef: ref }, running.context);
    if (!routed.ok || routed.command.kind !== 'define_workflow') return;
    const defined = await running.engine.handleToolCall(running.context, 'define_workflow', routed.command);
    expect(defined).toMatchObject({ ok: true });
    if (!defined.ok) return;
    const definitionId = (defined.result as { definitionId: string }).definitionId;
    const stored = await ctx.repository.getWorkflowDefinition(definitionId, 1);
    expect(stored?.topology.nodes[0]?.execution).toMatchObject({
      kind: 'script',
      source: { scope: 'global', packageKind: 'bundle', packagePath: 'workflow-a', entryFile: 'workflow.json', scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const start = dispatch('start_workflow', { workflow: `${definitionId}@1` }, running.context);
    if (!start.ok || start.command.kind !== 'start_workflow') return;
    const started = await running.engine.handleToolCall(running.context, 'start_workflow', start.command);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const runId = (started.result as { runId: string }).runId;
    expect(await waitForRun(ctx.client, runId)).toBe('succeeded');
    const artifact = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'run' AND kind = 'next_result'`,
      ['ws', runId],
    );
    expect(JSON.parse(artifact!.payload_json)).toHaveProperty('result', `global-package|${realpathSync(ctx.dir)}`);

    writeFileSync(join(bundle, 'README.txt'), 'package changed after definition');
    const stale = dispatch('start_workflow', { opId: 'stale-start', workflow: `${definitionId}@1` }, running.context);
    if (!stale.ok || stale.command.kind !== 'start_workflow') return;
    const staleResult = await running.engine.handleToolCall(running.context, 'start_workflow', stale.command);
    expect(staleResult).toMatchObject({ ok: true });
    if (staleResult.ok) {
      expect(await waitForRun(ctx.client, (staleResult.result as { runId: string }).runId)).toBe('failed');
    }
    running.release();
  }, 30_000);

  it('lists canonical packages in both scopes and preserves package provenance across reload', async () => {
    const ctx = await fixture('scope-matrix');
    const workspaceCatalog = join(ctx.dir, '.muster', 'workflows');
    writePackage(workspaceCatalog, 'workspace-flat', workflowManifest('Workspace package workflow', [scriptManifestNode('run', 'scripts/run.js')]), {
      'scripts/run.js': 'process.stdout.write("workspace-package|" + process.cwd());',
    });
    writePackage(workspaceCatalog, 'workspace-bundle', workflowManifest('Workspace bundle workflow', [scriptManifestNode('run', 'scripts/run.js')]), {
      'scripts/run.js': 'process.stdout.write("workspace-bundle|" + process.cwd());',
    });
    writePackage(ctx.globalWorkflowFolder, 'global-package', workflowManifest('Global package workflow', [scriptManifestNode('run', 'scripts/run.js')]), {
      'scripts/run.js': 'process.stdout.write("global-package|" + process.cwd());',
    });
    const running = await coordinator(ctx, 'scope-matrix');
    const listed = await running.engine.handleToolCall(running.context, 'list_predefined_workflows', { kind: 'list_predefined_workflows' });
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    const workflows = (listed.result as { workflows: Array<{ workflowRef: string; name: string; scope: string; packageKind: string }> }).workflows;
    expect(workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Global package workflow', scope: 'global', packageKind: 'bundle' }),
      expect.objectContaining({ name: 'Workspace package workflow', scope: 'workspace', packageKind: 'bundle' }),
      expect.objectContaining({ name: 'Workspace bundle workflow', scope: 'workspace', packageKind: 'bundle' }),
    ]));

    const definitions = new Map<string, string>();
    for (const workflow of workflows) {
      const routed = dispatch('define_workflow', { predefinedWorkflowRef: workflow.workflowRef }, running.context);
      if (!routed.ok || routed.command.kind !== 'define_workflow') throw new Error('scope matrix define parse failed');
      const defined = await running.engine.handleToolCall(running.context, 'define_workflow', routed.command);
      expect(defined).toMatchObject({ ok: true });
      if (!defined.ok) return;
      definitions.set(workflow.name, (defined.result as { definitionId: string }).definitionId);
    }
    const publicWorkflow = definitions.get('Workspace bundle workflow')!;
    const publicStart = dispatch('start_workflow', { workflow: `${publicWorkflow}@1` }, running.context);
    if (!publicStart.ok || publicStart.command.kind !== 'start_workflow') return;
    const started = await running.engine.handleToolCall(running.context, 'start_workflow', publicStart.command);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const publicRunId = (started.result as { runId: string }).runId;
    expect(await waitForRun(ctx.client, publicRunId)).toBe('succeeded');
    const publicArtifact = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'run' AND kind = 'next_result'`,
      ['ws', publicRunId],
    );
    expect(JSON.parse(publicArtifact!.payload_json)).toHaveProperty('result', `workspace-bundle|${realpathSync(ctx.dir)}`);
    running.release();
    await running.engine.shutdown();
    const reloaded = await TaskEngine.loadAsync({
      repository: ctx.repository, workspaceId: 'ws', workspaceFolder: ctx.dir,
      globalWorkflowFolder: ctx.globalWorkflowFolder, makeBackend,
      isWorkspaceTrusted: () => true, allowHostVerification: true,
    });
    ctx.setEngine(reloaded);
    const globalDefinition = definitions.get('Global package workflow')!;
    const stored = await ctx.repository.getWorkflowDefinition(globalDefinition, 1);
    expect(stored?.topology.nodes[0]?.execution?.source).toMatchObject({ packagePath: 'global-package', entryFile: 'workflow.json' });
  }, 60_000);

  it('keeps empty stdout successful and fails a canonical nonzero script without retrying', async () => {
    const ctx = await fixture('terminal-semantics');
    writeFileSync(join(ctx.dir, 'empty.js'), "process.stderr.write('empty note')");
    writeFileSync(join(ctx.dir, 'fail.js'), "process.stderr.write('failure note'); process.exitCode = 9;");
    const createdAt = new Date().toISOString();
    const define = async (definitionId: string, file: string) => ctx.repository.execute({
      kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId, version: 1, name: definitionId,
      topology: {
        kind: 'workflow', inputs: [],
        outputs: [{ name: 'result', semanticKind: 'result', terminalNodeId: 'script' }],
        nodes: [{ nodeId: 'script', backend: 'script', execution: { kind: 'script', interpreter: 'node', file, args: [] }, outcome: exitOutcome() }],
        edges: [],
      },
      entryContracts: [], createdAt,
    });
    await define('wf-empty', 'empty.js');
    await define('wf-fail', 'fail.js');
    const emptyStart = await ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-empty', version: 1,
      startIdempotencyKey: 'empty-1', createdAt, goal: 'empty', backend: 'grok',
    });
    const empty = emptyStart.operation!.result.data as { runId: string; activationTurnId: string };
    const failStart = await ctx.repository.execute({
      kind: 'startWorkflowRun', workspaceId: 'ws', definitionId: 'wf-fail', version: 1,
      startIdempotencyKey: 'fail-1', createdAt: new Date().toISOString(), goal: 'fail', backend: 'grok',
    });
    const failed = failStart.operation!.result.data as { runId: string; entryTaskId: string };
    const engine = await TaskEngine.loadAsync({
      repository: ctx.repository, workspaceId: 'ws', workspaceFolder: ctx.dir, makeBackend,
      isWorkspaceTrusted: () => true, allowHostVerification: true,
    });
    ctx.setEngine(engine);
    expect(await waitForRun(ctx.client, empty.runId)).toBe('succeeded');
    await expect(ctx.repository.getTurn(empty.activationTurnId)).resolves.toMatchObject({
      status: 'succeeded', disposition: { kind: 'workflow_next', result: '' },
    });
    const emptyArtifact = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result' LIMIT 1`,
      ['ws', empty.runId],
    );
    expect(JSON.parse(emptyArtifact!.payload_json)).toHaveProperty('result', '');
    expect(await waitForRun(ctx.client, failed.runId)).toBe('failed');
    expect(await ctx.repository.listTurns(failed.entryTaskId)).toHaveLength(1);
  }, 30_000);
});
