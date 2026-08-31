import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  freezePredefinedWorkflowDefinition,
  getPredefinedWorkflow,
  listPredefinedWorkflows,
  PREDEFINED_WORKFLOW_MAX_BUNDLE_BYTES,
  PREDEFINED_WORKFLOW_MAX_BUNDLE_DEPTH,
  PREDEFINED_WORKFLOW_MAX_BUNDLE_DIRECTORIES,
  PREDEFINED_WORKFLOW_MAX_BUNDLE_ENTRIES,
  PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES,
  PREDEFINED_WORKFLOW_MAX_BUNDLE_FILES,
  resolvePredefinedWorkflow,
  resolvePredefinedWorkflowScript,
  resolvePredefinedWorkflowSource,
} from './predefined-workflows';

const dirs: string[] = [];

function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `muster-workflows-${label}-`));
  dirs.push(dir);
  return dir;
}

function manifest(
  name: string,
  description = 'A canonical workflow',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'muster.workflow/v2',
    name,
    description,
    inputs: [{ name: 'request', kind: 'request', to: 'check', inputRef: 'request' }],
    outputs: [{ name: 'result', kind: 'result', from: 'check' }],
    nodes: [{
      nodeKey: 'check',
      taskType: 'review',
      title: 'Display title only',
      instructions: { file: 'prompts/check.md' },
    }],
    edges: [],
    ...overrides,
  };
}

function writePackage(
  root: string,
  packageName: string,
  value: Record<string, unknown>,
  assets: Record<string, string> = { 'prompts/check.md': 'Run the check.' },
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

function workspaceRoot(workspace: string): string {
  return join(workspace, '.muster', 'workflows');
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('predefined workflow catalog', () => {
  it('lists only direct-child canonical workflow.json bundles', async () => {
    const workspace = temp('authority-workspace');
    const global = temp('authority-global');
    const root = workspaceRoot(workspace);
    mkdirSync(root, { recursive: true });
    writePackage(root, 'canonical', manifest('Canonical', 'workspace package'));
    writeFileSync(join(root, 'flat.md'), '---\nname: Flat\ndescription: no\n---\nlegacy');
    writeFileSync(join(root, 'flat.json'), JSON.stringify(manifest('Flat json')));
    mkdirSync(join(root, 'nested', 'child'), { recursive: true });
    writeFileSync(join(root, 'nested', 'child', 'workflow.json'), JSON.stringify(manifest('Nested')));
    writePackage(global, 'global-valid', manifest('Global valid'));

    const listed = await listPredefinedWorkflows({
      workspaceFolder: workspace,
      globalWorkflowFolder: global,
    });

    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'Canonical', scope: 'workspace', packageKind: 'bundle' }),
      expect.objectContaining({ name: 'Global valid', scope: 'global', packageKind: 'bundle' }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(workspace);
    expect(JSON.stringify(listed)).not.toContain('Run the check');
  });

  it('uses workspace-over-global precedence and keeps catalog results metadata-only', async () => {
    const workspace = temp('shadow-workspace');
    const global = temp('shadow-global');
    writePackage(workspaceRoot(workspace), 'workspace-review', manifest('Review', 'workspace description'));
    writePackage(global, 'global-review', manifest('Review', 'global description'));

    const listed = await listPredefinedWorkflows({
      workspaceFolder: workspace,
      globalWorkflowFolder: global,
    });
    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'Review', description: 'workspace description', scope: 'workspace' }),
    ]);

    const workflow = await getPredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global },
      listed.workflows[0]!.workflowRef,
    );
    expect(workflow).toEqual(expect.objectContaining({
      name: 'Review',
      description: 'workspace description',
      packageKind: 'bundle',
    }));
    expect(workflow).not.toHaveProperty('body');
    expect(workflow).not.toHaveProperty('manifest');
    expect(workflow).not.toHaveProperty('packageRoot');
  });

  it('lists bounded manifest metadata without compiling topology until resolution', async () => {
    const workspace = temp('metadata-workspace');
    const global = temp('metadata-global');
    writePackage(
      workspaceRoot(workspace),
      'deferred',
      manifest('Deferred topology', 'metadata remains available', {
        nodes: [{ nodeKey: 'check', taskType: 'review', unexpected: true }],
      }),
    );
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };

    const listed = await listPredefinedWorkflows(options);
    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'Deferred topology', description: 'metadata remains available' }),
    ]);
    expect(listed.diagnostics).toEqual([]);
    await expect(resolvePredefinedWorkflow(options, listed.workflows[0]!.workflowRef)).resolves.toBeUndefined();
  });

  it('changes the opaque ref for any package byte change, including prompt bytes', async () => {
    const workspace = temp('digest-workspace');
    const global = temp('digest-global');
    const root = workspaceRoot(workspace);
    const firstRoot = writePackage(root, 'first', manifest('Same manifest'), { 'prompts/check.md': 'one' });
    const secondRoot = writePackage(root, 'second', manifest('Same manifest'), { 'prompts/check.md': 'two' });

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    const refs = listed.workflows.map((entry) => entry.workflowRef);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^pwf_[a-f0-9]{32}$/);

    const originalRef = refs[0]!;
    writeFileSync(join(firstRoot, 'prompts', 'check.md'), 'changed');
    const changed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(changed.workflows[0]!.workflowRef).not.toBe(originalRef);

    rmSync(secondRoot, { recursive: true, force: true });
  });

  it('frames package paths and bytes so NUL-bearing assets cannot preserve a stale ref', async () => {
    const workspace = temp('digest-framing-workspace');
    const global = temp('digest-framing-global');
    const root = workspaceRoot(workspace);
    const packageRoot = writePackage(
      root,
      'framing',
      manifest('Digest framing', 'digest framing package', {
        nodes: [{
          nodeKey: 'check',
          taskType: 'review',
          instructions: { file: 'prompts/a.md' },
        }],
      }),
      { 'prompts/a.md': 'hello\0prompts/b.md\0world' },
    );
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    const first = await listPredefinedWorkflows(options);
    const originalRef = first.workflows[0]!.workflowRef;

    writeFileSync(join(packageRoot, 'prompts', 'a.md'), 'hello');
    writeFileSync(join(packageRoot, 'prompts', 'b.md'), 'world');

    const changed = await listPredefinedWorkflows(options);
    expect(changed.workflows[0]!.workflowRef).not.toBe(originalRef);
    await expect(resolvePredefinedWorkflow(options, originalRef)).resolves.toBeUndefined();
  });

  it('rejects stale manifest, prompt, and script references before resolution', async () => {
    const workspace = temp('stale-workspace');
    const global = temp('stale-global');
    const root = workspaceRoot(workspace);
    const packageRoot = writePackage(
      root,
      'stale',
      manifest('Stale', 'stale package', {
        nodes: [{
          nodeKey: 'check',
          script: { interpreter: 'node', file: 'scripts/check.js', args: [] },
          outcome: {
            kind: 'exit',
            next: { when: { exitCode: 0 } },
            fail: { when: { exitCode: 'nonzero' } },
          },
        }],
      }),
      { 'scripts/check.js': 'process.stdout.write("ok")' },
    );
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    const first = await listPredefinedWorkflows(options);
    const ref = first.workflows[0]!.workflowRef;

    writeFileSync(join(packageRoot, 'workflow.json'), JSON.stringify(manifest('Stale changed')));
    await expect(resolvePredefinedWorkflow(options, ref)).resolves.toBeUndefined();

    const second = await listPredefinedWorkflows(options);
    const secondRef = second.workflows[0]!.workflowRef;
    writeFileSync(join(packageRoot, 'scripts', 'check.js'), 'process.stdout.write("changed")');
    await expect(resolvePredefinedWorkflowSource(options, {
      kind: 'predefined',
      scope: 'workspace',
      packageKind: 'bundle',
      catalogRootKind: 'canonical',
      packagePath: 'stale',
      entryFile: 'workflow.json',
      workflowRef: secondRef,
      packageSha256: '0'.repeat(64),
    })).resolves.toBeUndefined();
  });

  it('freezes file instructions and script provenance from the captured package bytes', async () => {
    const workspace = temp('freeze-workspace');
    const global = temp('freeze-global');
    const root = workspaceRoot(workspace);
    const packageRoot = writePackage(
      root,
      'freeze',
      manifest('Freeze me', 'freeze description', {
        nodes: [{
          nodeKey: 'check',
          title: 'Never execute this title',
          taskType: 'review',
          instructions: { file: 'prompts/check.md' },
        }],
      }),
      { 'prompts/check.md': 'frozen prompt' },
    );
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    const listed = await listPredefinedWorkflows(options);
    const resolved = await resolvePredefinedWorkflow(options, listed.workflows[0]!.workflowRef);
    expect(resolved).toBeDefined();

    const frozen = await freezePredefinedWorkflowDefinition(resolved!);
    expect(frozen).toMatchObject({ ok: true, name: 'Freeze me' });
    if (!frozen.ok) return;
    expect(frozen.topology.nodes[0]?.instructions).toMatchObject({
      kind: 'file',
      file: 'prompts/check.md',
      content: 'frozen prompt',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(frozen.topology.nodes[0]?.title).toBe('Never execute this title');
    expect(frozen.entryContracts).toEqual([{
      entryNodeId: 'check', inputRef: 'request', expectedArtifactKind: 'workflow_input',
    }]);

    writeFileSync(join(packageRoot, 'prompts', 'check.md'), 'mutated after capture');
    expect(frozen.topology.nodes[0]?.instructions).toMatchObject({ content: 'frozen prompt' });
  });

  it('freezes package-local scripts and rejects unsafe or missing assets', async () => {
    const workspace = temp('assets-workspace');
    const global = temp('assets-global');
    const root = workspaceRoot(workspace);
    const packageRoot = writePackage(
      root,
      'scripts',
      manifest('Scripts', 'script package', {
        nodes: [{
          nodeKey: 'check',
          script: { interpreter: 'node', file: 'scripts/check.js', args: ['literal value'] },
          outcome: {
            kind: 'exit',
            next: { when: { exitCode: 0 } },
            fail: { when: { exitCode: 'nonzero' } },
          },
        }],
      }),
      { 'scripts/check.js': 'process.stdout.write("ok")' },
    );
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    const listed = await listPredefinedWorkflows(options);
    const resolved = await resolvePredefinedWorkflow(options, listed.workflows[0]!.workflowRef);
    expect(resolved).toBeDefined();
    const script = await resolvePredefinedWorkflowScript(resolved!, 'scripts/check.js', 'node');
    expect(script).toMatchObject({
      packageKind: 'bundle',
      packagePath: 'scripts',
      entryFile: 'workflow.json',
      scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const frozen = await freezePredefinedWorkflowDefinition(resolved!);
    expect(frozen).toMatchObject({ ok: true });
    if (frozen.ok) {
      expect(frozen.topology.nodes[0]?.execution).toMatchObject({
        file: 'scripts/check.js',
        args: ['literal value'],
        source: { scriptSha256: script!.scriptSha256 },
      });
    }

    rmSync(join(packageRoot, 'scripts', 'check.js'));
    await expect(resolvePredefinedWorkflow(options, listed.workflows[0]!.workflowRef)).resolves.toBeUndefined();
  });

  it('allows an empty package-local script', async () => {
    const workspace = temp('empty-script-workspace');
    const global = temp('empty-script-global');
    const root = workspaceRoot(workspace);
    writePackage(
      root,
      'empty-script',
      manifest('Empty script', 'empty script package', {
        nodes: [{
          nodeKey: 'check',
          script: { interpreter: 'node', file: 'scripts/empty.js', args: [] },
          outcome: {
            kind: 'exit',
            next: { when: { exitCode: 0 } },
            fail: { when: { exitCode: 'nonzero' } },
          },
        }],
      }),
      { 'scripts/empty.js': '' },
    );

    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    const listed = await listPredefinedWorkflows(options);
    const resolved = await resolvePredefinedWorkflow(options, listed.workflows[0]!.workflowRef);
    expect(resolved).toBeDefined();
    await expect(freezePredefinedWorkflowDefinition(resolved!)).resolves.toMatchObject({ ok: true });
  });

  it('keeps duplicate-name selection deterministic by UTF-8 package name order', async () => {
    const workspace = temp('duplicate-workspace');
    const global = temp('duplicate-global');
    const root = workspaceRoot(workspace);
    writePackage(root, '\u{10000}', manifest('Deploy', 'astral package'));
    writePackage(root, '\uE000', manifest('deploy', 'bmp package'));

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'deploy', description: 'bmp package' }),
    ]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ file: '\u{10000}', code: 'duplicate_workflow_name' }),
    ]);
  });

  it('reports malformed, ambiguous, unsafe, symlinked, and legacy forms without compiling them', async () => {
    const workspace = temp('invalid-workspace');
    const global = temp('invalid-global');
    const root = workspaceRoot(workspace);
    mkdirSync(root, { recursive: true });
    const malformed = join(root, 'malformed');
    mkdirSync(malformed, { recursive: true });
    writeFileSync(join(malformed, 'workflow.json'), '{not json');
    const malformedUtf8 = join(root, 'malformed-utf8');
    mkdirSync(malformedUtf8, { recursive: true });
    const malformedUtf8Manifest = Buffer.from(JSON.stringify(manifest('Utf8')));
    const utf8Marker = malformedUtf8Manifest.indexOf(Buffer.from('Utf8'));
    expect(utf8Marker).toBeGreaterThan(-1);
    malformedUtf8Manifest[utf8Marker] = 0xff;
    writeFileSync(join(malformedUtf8, 'workflow.json'), malformedUtf8Manifest);
    writePackage(root, 'nul-metadata', manifest('Unsafe\0name', 'Unsafe\0description'));
    const ambiguous = join(root, 'ambiguous');
    mkdirSync(ambiguous, { recursive: true });
    writeFileSync(join(ambiguous, 'workflow.json'), JSON.stringify(manifest('Ambiguous')));
    mkdirSync(join(ambiguous, 'nested'), { recursive: true });
    writeFileSync(join(ambiguous, 'nested', 'workflow.json'), JSON.stringify(manifest('Ambiguous')));
    const unsafe = join(root, 'unsafe\x7f');
    mkdirSync(unsafe, { recursive: true });
    writeFileSync(join(unsafe, 'workflow.json'), JSON.stringify(manifest('Unsafe')));
    const symlinked = join(root, 'symlinked');
    mkdirSync(symlinked, { recursive: true });
    writeFileSync(join(symlinked, 'workflow.json'), JSON.stringify(manifest('Symlinked')));
    symlinkSync(join(symlinked, 'workflow.json'), join(symlinked, 'prompts-link.json'));
    writeFileSync(join(root, 'legacy.md'), '---\nname: Legacy\ndescription: old\n---\nold body');
    mkdirSync(join(workspace, '.muster', 'workflow'), { recursive: true });
    writePackage(join(workspace, '.muster', 'workflow'), 'legacy-root', manifest('Legacy root'));

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([]);
    expect(listed.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
      'ambiguous', 'malformed', 'malformed-utf8', 'nul-metadata', 'symlinked', 'unsafe',
    ]);
    expect(listed.diagnostics.every((diagnostic) => !diagnostic.message.includes(workspace))).toBe(true);
  });

  it('rejects package bounds at discovery without unbounded traversal', async () => {
    const workspace = temp('bounds-workspace');
    const global = temp('bounds-global');
    const root = workspaceRoot(workspace);
    mkdirSync(root, { recursive: true });

    const oversizedFile = join(root, 'oversized-file');
    mkdirSync(oversizedFile, { recursive: true });
    writeFileSync(join(oversizedFile, 'workflow.json'), JSON.stringify(manifest('Oversized file')));
    writeFileSync(
      join(oversizedFile, 'oversized.bin'),
      Buffer.alloc(PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES + 1),
    );

    const tooManyFiles = join(root, 'too-many-files');
    mkdirSync(tooManyFiles, { recursive: true });
    writeFileSync(join(tooManyFiles, 'workflow.json'), JSON.stringify(manifest('Too many files')));
    for (let index = 0; index < PREDEFINED_WORKFLOW_MAX_BUNDLE_FILES; index += 1) {
      writeFileSync(join(tooManyFiles, `asset-${index}.txt`), 'x');
    }

    const tooManyEntries = join(root, 'too-many-entries');
    mkdirSync(tooManyEntries, { recursive: true });
    writeFileSync(join(tooManyEntries, 'workflow.json'), JSON.stringify(manifest('Too many entries')));
    for (let index = 0; index < PREDEFINED_WORKFLOW_MAX_BUNDLE_ENTRIES; index += 1) {
      writeFileSync(join(tooManyEntries, `entry-${index}.txt`), 'x');
    }

    const tooManyDirectories = join(root, 'too-many-directories');
    mkdirSync(tooManyDirectories, { recursive: true });
    writeFileSync(join(tooManyDirectories, 'workflow.json'), JSON.stringify(manifest('Too many directories')));
    for (let index = 0; index < PREDEFINED_WORKFLOW_MAX_BUNDLE_DIRECTORIES; index += 1) {
      mkdirSync(join(tooManyDirectories, `directory-${index}`));
    }

    const tooDeep = join(root, 'too-deep');
    let current = tooDeep;
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'workflow.json'), JSON.stringify(manifest('Too deep')));
    for (let depth = 0; depth <= PREDEFINED_WORKFLOW_MAX_BUNDLE_DEPTH; depth += 1) {
      current = join(current, `level-${depth}`);
      mkdirSync(current);
    }

    const tooLarge = join(root, 'too-large');
    mkdirSync(tooLarge, { recursive: true });
    writeFileSync(join(tooLarge, 'workflow.json'), JSON.stringify(manifest('Too large')));
    const aggregateChunk = Buffer.alloc(PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES);
    for (let index = 0; index < Math.ceil(PREDEFINED_WORKFLOW_MAX_BUNDLE_BYTES / PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES); index += 1) {
      writeFileSync(join(tooLarge, `chunk-${index}.bin`), aggregateChunk);
    }

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([]);
    expect(listed.diagnostics.map((diagnostic) => diagnostic.file)).toEqual([
      'oversized-file', 'too-deep', 'too-large', 'too-many-directories', 'too-many-entries', 'too-many-files',
    ]);
  });

  it('accepts package file, count, directory, depth, and aggregate bounds exactly', async () => {
    const workspace = temp('exact-bounds-workspace');
    const global = temp('exact-bounds-global');
    const root = workspaceRoot(workspace);

    const exactFileSize = writePackage(root, 'exact-file-size', manifest('Exact file size'));
    writeFileSync(join(exactFileSize, 'exact.bin'), Buffer.alloc(PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES));

    const exactFileCount = writePackage(root, 'exact-file-count', manifest('Exact file count'));
    for (let index = 0; index < PREDEFINED_WORKFLOW_MAX_BUNDLE_FILES - 2; index += 1) {
      writeFileSync(join(exactFileCount, `asset-${index}.txt`), 'x');
    }

    const exactDirectories = writePackage(root, 'exact-directories', manifest('Exact directories'));
    for (let index = 0; index < PREDEFINED_WORKFLOW_MAX_BUNDLE_DIRECTORIES - 2; index += 1) {
      mkdirSync(join(exactDirectories, `directory-${index}`));
    }

    const exactDepth = writePackage(root, 'exact-depth', manifest('Exact depth'));
    let current = exactDepth;
    for (let depth = 0; depth < PREDEFINED_WORKFLOW_MAX_BUNDLE_DEPTH; depth += 1) {
      current = join(current, `level-${depth}`);
      mkdirSync(current);
    }

    const exactAggregateManifest = manifest('Exact aggregate', 'exact aggregate', {
      nodes: [{ nodeKey: 'check', taskType: 'review' }],
    });
    const exactAggregate = writePackage(root, 'exact-aggregate', exactAggregateManifest, {});
    const manifestBytes = Buffer.byteLength(JSON.stringify(exactAggregateManifest));
    let remaining = PREDEFINED_WORKFLOW_MAX_BUNDLE_BYTES - manifestBytes;
    let chunk = 0;
    while (remaining > 0) {
      const size = Math.min(remaining, PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES);
      writeFileSync(join(exactAggregate, `chunk-${chunk}.bin`), Buffer.alloc(size));
      remaining -= size;
      chunk += 1;
    }

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.diagnostics).toEqual([]);
    expect(listed.workflows.map((workflow) => workflow.name)).toEqual([
      'Exact aggregate', 'Exact depth', 'Exact directories', 'Exact file count', 'Exact file size',
    ]);
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked package roots and nested asset paths', async () => {
    const workspace = temp('symlink-root-workspace');
    const global = temp('symlink-root-global');
    const root = workspaceRoot(workspace);
    mkdirSync(root, { recursive: true });
    const outside = temp('outside');
    writePackage(outside, 'real', manifest('Outside'));
    symlinkSync(join(outside, 'real'), join(root, 'linked-package'), 'dir');
    const nested = writePackage(root, 'nested-link', manifest('Nested link'));
    symlinkSync(join(outside, 'real', 'prompts', 'check.md'), join(nested, 'linked.md'));

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ file: 'linked-package', code: 'invalid_workflow_file' }),
      expect.objectContaining({ file: 'nested-link', code: 'invalid_workflow_file' }),
    ]);
  });
});
