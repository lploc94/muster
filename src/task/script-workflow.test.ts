import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('script workflow runtime', () => {
  it('defines, authorizes, and executes a script graph through the public tool path', async () => {
    const ctx = await fixture('public-path');
    writeFileSync(join(ctx.dir, 'public-produce.js'), [
      "process.stdout.write('public-alpha\\n');",
      "process.stderr.write('public diagnostic');",
      'process.exitCode = 4;',
    ].join('\n'));
    writeFileSync(join(ctx.dir, 'public-consume.js'), [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const parsed = JSON.parse(input);",
      "  process.stdout.write(parsed.dep.value + 'exit=' + parsed.dep.exitCode);",
      "});",
    ].join('\n'));
    const catalogFolder = join(ctx.dir, '.muster', 'workflow');
    mkdirSync(catalogFolder, { recursive: true });
    writeFileSync(join(catalogFolder, 'public.md'), [
      '---',
      'name: Public QA workflow',
      'description: Public discovery path',
      '---',
      'Run the deterministic public QA workflow.',
    ].join('\n'));

    let hostRun = false;
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    cleanups.push(async () => { releaseRoot(); });
    const engine = await TaskEngine.loadAsync({
      repository: ctx.repository,
      workspaceId: 'ws',
      workspaceFolder: ctx.dir,
      makeBackend,
      isWorkspaceTrusted: () => true,
      allowHostVerification: () => hostRun,
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
    const root = await engine.startNewTask({
      goal: 'public script QA coordinator',
      backend: 'grok',
      role: 'coordinator',
      cwd: ctx.dir,
    });
    if (!root.ok) throw new Error(`public QA root failed: ${root.reason}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ctx.repository.getTurn(root.value.turnId))?.status === 'running') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const toolContext: CredentialContext = {
      credentialId: 'script-public-qa',
      rootId: root.value.taskId,
      callerTaskId: root.value.taskId,
      turnId: root.value.turnId,
      attemptId: 'script-public-attempt',
      allowedActions: new Set([
        'list_predefined_workflows',
        'get_predefined_workflow',
        'define_workflow',
        'start_workflow',
      ]),
      expiry: Date.now() + 60_000,
    };

    const listed = await engine.handleToolCall(
      toolContext,
      'list_predefined_workflows',
      { kind: 'list_predefined_workflows' },
    );
    expect(listed).toMatchObject({
      ok: true,
      result: {
        workflows: [expect.objectContaining({ name: 'Public QA workflow', scope: 'workspace' })],
      },
    });
    if (!listed.ok) return;
    const workflowRef = (listed.result as { workflows: Array<{ workflowRef: string }> })
      .workflows[0]!.workflowRef;
    await expect(engine.handleToolCall(
      toolContext,
      'get_predefined_workflow',
      { kind: 'get_predefined_workflow', workflowRef },
    )).resolves.toMatchObject({
      ok: true,
      result: {
        body: 'Run the deterministic public QA workflow.',
        provenance: 'user-authored-untrusted',
      },
    });

    const routedDefinition = dispatch('define_workflow', {
      name: 'Public script dataflow',
      nodes: [
        {
          nodeKey: 'produce',
          script: {
            interpreter: 'node',
            file: 'public-produce.js',
            onFailure: 'continue',
          },
        },
        {
          nodeKey: 'consume',
          script: {
            interpreter: 'node',
            file: 'public-consume.js',
          },
        },
      ],
      edges: [{ from: 'produce', to: 'consume', as: 'dep' }],
    }, toolContext);
    expect(routedDefinition.ok).toBe(true);
    if (!routedDefinition.ok || routedDefinition.command.kind !== 'define_workflow') return;
    await expect(engine.handleToolCall(
      toolContext,
      'define_workflow',
      routedDefinition.command,
    )).resolves.toMatchObject({ ok: true });

    const workflow = `${routedDefinition.command.definitionId}@1`;
    const routedStart = dispatch('start_workflow', {
      workflow,
      goal: 'run public script graph',
    }, toolContext);
    if (!routedStart.ok) throw new Error(`public QA start parse failed: ${routedStart.toolError}`);
    if (routedStart.command.kind !== 'start_workflow') return;
    await expect(engine.handleToolCall(
      toolContext,
      'start_workflow',
      routedStart.command,
    )).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('host_run_disabled'),
    });

    hostRun = true;
    const started = await engine.handleToolCall(
      toolContext,
      'start_workflow',
      routedStart.command,
    );
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const runId = (started.result as { runId: string }).runId;
    expect(await waitForRun(ctx.client, runId)).toBe('succeeded');
    const terminal = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'consume'`,
      ['ws', runId],
    );
    expect(JSON.parse(terminal!.payload_json)).toHaveProperty(
      'result',
      'public-alpha\nexit=4',
    );
    releaseRoot();
  }, 30_000);

  it('feeds exact stdout and exit metadata downstream while retaining stderr only on the turn', async () => {
    const ctx = await fixture('dataflow');
    writeFileSync(join(ctx.dir, 'produce.js'), [
      "process.stdout.write('alpha');",
      "process.stderr.write('producer diagnostic');",
      'process.exitCode = 3;',
    ].join('\n'));
    writeFileSync(join(ctx.dir, 'consume.js'), [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  const parsed = JSON.parse(input);",
      "  process.stdout.write(parsed.dep.value + '|' + parsed.dep.exitCode);",
      "});",
    ].join('\n'));

    const createdAt = new Date().toISOString();
    await ctx.repository.execute({
      kind: 'defineWorkflowVersion',
      workspaceId: 'ws',
      definitionId: 'wf-script-dataflow',
      version: 1,
      name: 'script dataflow',
      topology: {
        kind: 'graph_v1',
        nodes: [
          {
            nodeId: 'produce', backend: 'script',
            execution: {
              kind: 'script', interpreter: 'node', file: 'produce.js', args: [], onFailure: 'continue',
            },
          },
          {
            nodeId: 'consume', backend: 'script',
            execution: {
              kind: 'script', interpreter: 'node', file: 'consume.js', args: [], onFailure: 'fail_run',
            },
          },
        ],
        edges: [{ fromNodeId: 'produce', toNodeId: 'consume', inputRef: 'dep' }],
      },
      createdAt,
    });
    const started = await ctx.repository.execute({
      kind: 'startWorkflowRun',
      workspaceId: 'ws',
      definitionId: 'wf-script-dataflow',
      version: 1,
      startIdempotencyKey: 'script-dataflow-1',
      createdAt,
      goal: 'run scripts',
      backend: 'grok',
    });
    const start = started.operation!.result.data as {
      runId: string;
      entryTaskId: string;
      activationTurnId: string;
    };

    const engine = await TaskEngine.loadAsync({
      repository: ctx.repository,
      workspaceId: 'ws',
      workspaceFolder: ctx.dir,
      makeBackend,
      isWorkspaceTrusted: () => true,
      allowHostVerification: true,
    });
    ctx.setEngine(engine);
    expect(await waitForRun(ctx.client, start.runId)).toBe('succeeded');

    const producerTurn = await ctx.repository.getTurn(start.activationTurnId);
    expect(producerTurn).toMatchObject({
      status: 'succeeded',
      disposition: {
        kind: 'workflow_next',
        result: 'alpha',
        execution: { kind: 'script', exitCode: 3 },
      },
      executionResult: { kind: 'script', exitCode: 3, stderr: 'producer diagnostic' },
    });
    const artifacts = await ctx.client.all<{ producer_node_id: string; payload_json: string }>(
      `SELECT producer_node_id, payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result'
        ORDER BY producer_node_id`,
      ['ws', start.runId],
    );
    const producerArtifact = JSON.parse(
      artifacts.find((artifact) => artifact.producer_node_id === 'produce')!.payload_json,
    );
    expect(producerArtifact).toMatchObject({
      result: 'alpha',
      execution: { kind: 'script', exitCode: 3 },
    });
    expect(producerArtifact).not.toHaveProperty('stderr');
    expect(JSON.stringify(producerArtifact)).not.toContain('producer diagnostic');

    const consumerArtifact = artifacts
      .map((artifact) => JSON.parse(artifact.payload_json))
      .find((artifact) => artifact.result === 'alpha|3');
    expect(consumerArtifact).toMatchObject({ result: 'alpha|3' });
    await expect(ctx.repository.getWorkflowGraphForTask(start.entryTaskId)).resolves.toMatchObject({
      runId: start.runId,
      nodes: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'produce' }),
        expect.objectContaining({ nodeId: 'consume' }),
      ]),
    });
  }, 30_000);

  it('executes a global bundle script from its package root instead of the workspace shadow', async () => {
    const ctx = await fixture('global-bundle');
    const bundle = join(ctx.globalWorkflowFolder, 'workflow_a');
    mkdirSync(join(bundle, 'scripts'), { recursive: true });
    writeFileSync(join(bundle, 'workflow_a.md'), [
      '---',
      'name: Global bundle QA workflow',
      'description: Executes a package-local TypeScript script',
      '---',
      'Run the package-local script.',
    ].join('\n'));
    writeFileSync(join(bundle, 'scripts', 'node_1.ts'), [
      'const result: string = "global-package";',
      'process.stdout.write(result + "|" + process.cwd());',
    ].join('\n'));
    mkdirSync(join(ctx.dir, 'scripts'), { recursive: true });
    writeFileSync(join(ctx.dir, 'scripts', 'node_1.ts'), 'process.stdout.write("workspace-shadow");');

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
    const root = await engine.startNewTask({
      goal: 'global bundle coordinator',
      backend: 'grok',
      role: 'coordinator',
      cwd: ctx.dir,
    });
    if (!root.ok) throw new Error(`global bundle root failed: ${root.reason}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ctx.repository.getTurn(root.value.turnId))?.status === 'running') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const toolContext: CredentialContext = {
      credentialId: 'script-global-bundle',
      rootId: root.value.taskId,
      callerTaskId: root.value.taskId,
      turnId: root.value.turnId,
      attemptId: 'script-global-bundle-attempt',
      allowedActions: new Set([
        'list_predefined_workflows',
        'get_predefined_workflow',
        'define_workflow',
        'start_workflow',
      ]),
      expiry: Date.now() + 60_000,
    };

    const listed = await engine.handleToolCall(
      toolContext,
      'list_predefined_workflows',
      { kind: 'list_predefined_workflows' },
    );
    expect(listed).toMatchObject({
      ok: true,
      result: {
        workflows: [expect.objectContaining({
          name: 'Global bundle QA workflow',
          scope: 'global',
          packageKind: 'bundle',
        })],
      },
    });
    if (!listed.ok) return;
    const workflowRef = (listed.result as { workflows: Array<{ workflowRef: string }> })
      .workflows[0]!.workflowRef;
    const routedDefinition = dispatch('define_workflow', {
      name: 'Global bundle execution',
      predefinedWorkflowRef: workflowRef,
      nodes: [{
        nodeKey: 'run',
        script: {
          interpreter: 'node',
          file: 'scripts/node_1.ts',
        },
      }],
    }, toolContext);
    expect(routedDefinition.ok).toBe(true);
    if (!routedDefinition.ok || routedDefinition.command.kind !== 'define_workflow') return;
    expect(routedDefinition.command.predefinedWorkflowRef).toBe(workflowRef);
    const defined = await engine.handleToolCall(
      toolContext,
      'define_workflow',
      routedDefinition.command,
    );
    expect(defined).toMatchObject({ ok: true });
    const stored = await ctx.repository.getWorkflowDefinition(
      routedDefinition.command.definitionId,
      1,
    );
    expect(stored?.topology.nodes[0]?.execution).toMatchObject({
      kind: 'script',
      source: {
        scope: 'global',
        packageKind: 'bundle',
        packagePath: 'workflow_a',
        entryFile: 'workflow_a.md',
        scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const routedStart = dispatch('start_workflow', {
      workflow: `${routedDefinition.command.definitionId}@1`,
      goal: 'run global bundle script',
    }, toolContext);
    if (!routedStart.ok || routedStart.command.kind !== 'start_workflow') return;
    const started = await engine.handleToolCall(toolContext, 'start_workflow', routedStart.command);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const runId = (started.result as { runId: string }).runId;
    expect(await waitForRun(ctx.client, runId)).toBe('succeeded');
    const artifact = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
         WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'run' AND kind = 'next_result'`,
      ['ws', runId],
    );
    expect(JSON.parse(artifact!.payload_json)).toHaveProperty(
      'result',
      `global-package|${realpathSync(ctx.dir)}`,
    );

    writeFileSync(join(bundle, 'README.txt'), 'package changed after definition');
    const staleStart = dispatch('start_workflow', {
      opId: 'start-after-package-change',
      workflow: `${routedDefinition.command.definitionId}@1`,
      goal: 'reject changed global package',
    }, toolContext);
    if (!staleStart.ok || staleStart.command.kind !== 'start_workflow') return;
    const stale = await engine.handleToolCall(toolContext, 'start_workflow', staleStart.command);
    expect(stale).toMatchObject({ ok: true });
    if (stale.ok) {
      const staleRunId = (stale.result as { runId: string }).runId;
      expect(await waitForRun(ctx.client, staleRunId)).toBe('failed');
    }
    releaseRoot();
  }, 30_000);

  it('runs flat packages in both scopes, a workspace bundle, and preserves sources across reload', async () => {
    const ctx = await fixture('scope-matrix');
    const workspaceCatalog = join(ctx.dir, '.muster', 'workflows');
    const workspaceBundle = join(workspaceCatalog, 'workspace_bundle');
    mkdirSync(join(workspaceBundle, 'scripts'), { recursive: true });
    mkdirSync(join(workspaceCatalog, 'scripts'), { recursive: true });
    writeFileSync(join(workspaceCatalog, 'workspace-flat.md'), [
      '---',
      'name: Workspace flat workflow',
      'description: Workspace flat package',
      '---',
      'Run the workspace flat script.',
    ].join('\n'));
    writeFileSync(join(workspaceCatalog, 'scripts', 'workspace-flat.js'),
      'process.stdout.write("workspace-flat|" + process.cwd());');
    writeFileSync(join(workspaceBundle, 'workspace_bundle.md'), [
      '---',
      'name: Workspace bundle workflow',
      'description: Workspace bundle package',
      '---',
      'Run the workspace bundle script.',
    ].join('\n'));
    writeFileSync(join(workspaceBundle, 'scripts', 'workspace-bundle.js'),
      'process.stdout.write("workspace-bundle|" + process.cwd());');
    mkdirSync(join(ctx.globalWorkflowFolder, 'scripts'), { recursive: true });
    writeFileSync(join(ctx.globalWorkflowFolder, 'global-flat.md'), [
      '---',
      'name: Global flat workflow',
      'description: Global flat package',
      '---',
      'Run the global flat script.',
    ].join('\n'));
    writeFileSync(join(ctx.globalWorkflowFolder, 'scripts', 'global-flat.js'),
      'process.stdout.write("global-flat|" + process.cwd());');

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
    const root = await engine.startNewTask({
      goal: 'scope matrix coordinator',
      backend: 'grok',
      role: 'coordinator',
      cwd: ctx.dir,
    });
    if (!root.ok) throw new Error(`scope matrix root failed: ${root.reason}`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ctx.repository.getTurn(root.value.turnId))?.status === 'running') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    const toolContext: CredentialContext = {
      credentialId: 'script-scope-matrix',
      rootId: root.value.taskId,
      callerTaskId: root.value.taskId,
      turnId: root.value.turnId,
      attemptId: 'script-scope-matrix-attempt',
      allowedActions: new Set([
        'list_predefined_workflows',
        'define_workflow',
        'start_workflow',
      ]),
      expiry: Date.now() + 60_000,
    };

    const listed = await engine.handleToolCall(
      toolContext,
      'list_predefined_workflows',
      { kind: 'list_predefined_workflows' },
    );
    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) return;
    const workflows = (listed.result as {
      workflows: Array<{ workflowRef: string; name: string; scope: string; packageKind: string }>;
    }).workflows;
    expect(workflows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Global flat workflow', scope: 'global', packageKind: 'file' }),
      expect.objectContaining({ name: 'Workspace flat workflow', scope: 'workspace', packageKind: 'file' }),
      expect.objectContaining({ name: 'Workspace bundle workflow', scope: 'workspace', packageKind: 'bundle' }),
    ]));

    const definitions = new Map<string, string>();
    const define = async (name: string, workflowRef: string, file: string): Promise<string> => {
      const routed = dispatch('define_workflow', {
        name: `${name} execution`,
        predefinedWorkflowRef: workflowRef,
        nodes: [{ nodeKey: 'run', script: { interpreter: 'node', file } }],
      }, toolContext);
      expect(routed.ok).toBe(true);
      if (!routed.ok || routed.command.kind !== 'define_workflow') throw new Error('scope matrix define parse failed');
      const defined = await engine.handleToolCall(toolContext, 'define_workflow', routed.command);
      expect(defined).toMatchObject({ ok: true });
      definitions.set(name, routed.command.definitionId);
      return routed.command.definitionId;
    };
    const byName = (name: string) => workflows.find((workflow) => workflow.name === name)!.workflowRef;
    await define('global-flat', byName('Global flat workflow'), 'scripts/global-flat.js');
    await define('workspace-flat', byName('Workspace flat workflow'), 'scripts/workspace-flat.js');
    await define('workspace-bundle', byName('Workspace bundle workflow'), 'scripts/workspace-bundle.js');

    const publicStart = dispatch('start_workflow', {
      workflow: `${definitions.get('workspace-bundle')}@1`,
      goal: 'run workspace bundle after define',
    }, toolContext);
    if (!publicStart.ok || publicStart.command.kind !== 'start_workflow') throw new Error('scope matrix start parse failed');
    const started = await engine.handleToolCall(toolContext, 'start_workflow', publicStart.command);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const publicRunId = (started.result as { runId: string }).runId;
    expect(await waitForRun(ctx.client, publicRunId)).toBe('succeeded');
    const publicArtifact = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
         WHERE workspace_id = ? AND run_id = ? AND producer_node_id = 'run' AND kind = 'next_result'`,
      ['ws', publicRunId],
    );
    expect(JSON.parse(publicArtifact!.payload_json)).toHaveProperty(
      'result',
      `workspace-bundle|${realpathSync(ctx.dir)}`,
    );

    releaseRoot();
    await engine.shutdown();
    const reloaded = await TaskEngine.loadAsync({
      repository: ctx.repository,
      workspaceId: 'ws',
      workspaceFolder: ctx.dir,
      globalWorkflowFolder: ctx.globalWorkflowFolder,
      makeBackend,
      isWorkspaceTrusted: () => true,
      allowHostVerification: true,
    });
    ctx.setEngine(reloaded);

    for (const name of ['global-flat', 'workspace-flat']) {
      const createdAt = new Date().toISOString();
      const startResult = await reloaded.getRepository().execute({
        kind: 'startWorkflowRun',
        workspaceId: 'ws',
        definitionId: definitions.get(name)!,
        version: 1,
        startIdempotencyKey: `scope-matrix-${name}`,
        createdAt,
        goal: `run ${name} after reload`,
        backend: 'grok',
        ownerRootTaskId: root.value.taskId,
        callerTaskId: root.value.taskId,
        callerTurnId: root.value.turnId,
      });
      expect(startResult).toMatchObject({ ok: true, operation: { result: { ok: true } } });
      const start = startResult.operation!.result.data as { runId: string };
      expect(await waitForRun(ctx.client, start.runId)).toBe('succeeded');
    }
  }, 60_000);

  it('keeps empty stdout successful and fails non-zero fail_run without retrying', async () => {
    const ctx = await fixture('terminal-semantics');
    writeFileSync(join(ctx.dir, 'empty.js'), "process.stderr.write('empty note')");
    writeFileSync(join(ctx.dir, 'fail.js'), "process.stderr.write('failure note'); process.exitCode = 9;");
    const createdAt = new Date().toISOString();

    for (const [definitionId, file] of [['wf-empty', 'empty.js'], ['wf-fail', 'fail.js']] as const) {
      await ctx.repository.execute({
        kind: 'defineWorkflowVersion', workspaceId: 'ws', definitionId, version: 1, name: definitionId,
        topology: {
          kind: 'one_node_v1', entryNodeId: 'script',
          nodes: [{
            nodeId: 'script', backend: 'script',
            execution: { kind: 'script', interpreter: 'node', file, args: [], onFailure: 'fail_run' },
          }],
        },
        createdAt,
      });
    }
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
      status: 'succeeded',
      disposition: { kind: 'workflow_next', result: '' },
    });
    const emptyArtifact = await ctx.client.get<{ payload_json: string }>(
      `SELECT payload_json FROM workflow_artifacts
        WHERE workspace_id = ? AND run_id = ? AND kind = 'next_result' LIMIT 1`,
      ['ws', empty.runId],
    );
    expect(JSON.parse(emptyArtifact!.payload_json)).toHaveProperty('result', '');

    expect(await waitForRun(ctx.client, failed.runId)).toBe('failed');
    expect(await ctx.repository.listTurns(failed.entryTaskId)).toHaveLength(1);
  }, 30_000);
});
