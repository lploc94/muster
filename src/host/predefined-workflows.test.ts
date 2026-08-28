import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPredefinedWorkflow,
  listPredefinedWorkflows,
  parsePredefinedWorkflowMarkdown,
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
function markdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('predefined workflow catalog', () => {
  it('parses BOM/CRLF and preserves colons in frontmatter values', () => {
    expect(parsePredefinedWorkflowMarkdown(
      '\uFEFF---\r\nname: Build: check\r\ndescription: "Run: checks"\r\n---\r\nDo the work.',
    )).toEqual({ ok: true, name: 'Build: check', description: 'Run: checks', body: 'Do the work.' });
  });

  it('lists valid files, diagnoses invalid files, and lets workspace shadow global', async () => {
    const workspace = temp('workspace');
    const global = temp('global');
    const localFolder = join(workspace, '.muster', 'workflow');
    mkdirSync(localFolder, { recursive: true });
    writeFileSync(join(global, 'review.md'), markdown('Review', 'global description', 'Global body'));
    writeFileSync(join(localFolder, 'review.md'), markdown('Review', 'workspace description', 'Workspace body'));
    writeFileSync(join(localFolder, 'messy.md'), '\uFEFF---\r\nname: Messy\r\ndescription: still valid\r\n---\r\nVague prose.');
    writeFileSync(join(localFolder, 'invalid.md'), 'missing frontmatter');

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'Messy', scope: 'workspace' }),
      expect.objectContaining({ name: 'Review', description: 'workspace description', scope: 'workspace' }),
    ]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ file: 'invalid.md', code: 'invalid_workflow_file' }),
    ]);
    const review = listed.workflows.find((entry) => entry.name === 'Review')!;
    await expect(getPredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global },
      review.workflowRef,
    )).resolves.toMatchObject({ body: 'Workspace body', provenance: 'user-authored-untrusted' });
  });

  it('invalidates stale refs after the file content changes and never exposes a path', async () => {
    const workspace = temp('stale');
    const global = temp('empty-global');
    const folder = join(workspace, '.muster', 'workflow');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'one.md');
    writeFileSync(file, markdown('One', 'first', 'Body one'));
    const first = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    const ref = first.workflows[0]!.workflowRef;
    expect(JSON.stringify(first)).not.toContain(workspace);
    writeFileSync(file, markdown('One', 'second', 'Body two'));
    await expect(getPredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global }, ref,
    )).resolves.toBeUndefined();
  });

  it('uses the lexicographically first file for duplicate names in one scope', async () => {
    const workspace = temp('duplicates');
    const global = temp('duplicates-global');
    const folder = join(workspace, '.muster', 'workflow');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'z-last.md'), markdown('Deploy', 'later file', 'Later body'));
    writeFileSync(join(folder, 'a-first.md'), markdown('deploy', 'first file', 'First body'));

    const listed = await listPredefinedWorkflows({
      workspaceFolder: workspace,
      globalWorkflowFolder: global,
    });
    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'deploy', description: 'first file' }),
    ]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ file: 'z-last.md', code: 'duplicate_workflow_name' }),
    ]);
  });

  it('discovers a global directory bundle and resolves its scripts from the bundle root', async () => {
    const workspace = temp('bundle-workspace');
    const global = temp('bundle-global');
    const bundle = join(global, 'workflow_a');
    mkdirSync(join(bundle, 'scripts'), { recursive: true });
    writeFileSync(join(bundle, 'workflow_a.md'), markdown(
      'Global bundle',
      'A workflow with package-local scripts',
      'Run the package script.',
    ));
    writeFileSync(join(bundle, 'scripts', 'node_1.ts'), 'const result: string = "bundle"; process.stdout.write(result);');
    mkdirSync(join(workspace, 'scripts'), { recursive: true });
    writeFileSync(join(workspace, 'scripts', 'node_1.ts'), 'process.stdout.write("workspace-shadow");');

    const listed = await listPredefinedWorkflows({
      workspaceFolder: workspace,
      globalWorkflowFolder: global,
    });
    expect(listed.workflows).toEqual([
      expect.objectContaining({
        name: 'Global bundle',
        scope: 'global',
        packageKind: 'bundle',
      }),
    ]);
    const ref = listed.workflows[0]!.workflowRef;
    const resolved = await resolvePredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global },
      ref,
    );
    expect(resolved).toMatchObject({
      source: {
        packageKind: 'bundle',
        packagePath: 'workflow_a',
        entryFile: 'workflow_a.md',
        catalogRootKind: 'custom',
      },
    });
    expect(JSON.stringify(await getPredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global },
      ref,
    ))).not.toContain(global);
    const scriptSource = await resolvePredefinedWorkflowScript(
      resolved!,
      'scripts/node_1.ts',
      'node',
    );
    expect(scriptSource).toMatchObject({
      packagePath: 'workflow_a',
      entryFile: 'workflow_a.md',
      scriptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await resolvePredefinedWorkflowScript(resolved!, '../node_1.ts', 'node')).toBeUndefined();

    writeFileSync(join(bundle, 'scripts', 'node_1.ts'), 'const result: string = "changed"; process.stdout.write(result);');
    await expect(resolvePredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global },
      ref,
    )).resolves.toBeUndefined();
  });

  it('uses the canonical plural workspace root and falls back to the legacy singular root', async () => {
    const workspace = temp('root-names');
    const global = temp('root-names-global');
    const canonical = join(workspace, '.muster', 'workflows');
    const legacy = join(workspace, '.muster', 'workflow');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(canonical, 'canonical.md'), markdown('Canonical', 'new root', 'Body'));
    writeFileSync(join(legacy, 'legacy.md'), markdown('Legacy', 'fallback root', 'Body'));
    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows.map((workflow) => workflow.name)).toEqual(['Canonical']);

    rmSync(canonical, { recursive: true, force: true });
    await expect(listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global }))
      .resolves.toMatchObject({ workflows: [expect.objectContaining({ name: 'Legacy', scope: 'workspace' })] });
  });

  it('resolves a frozen global source directly after a workspace shadow is added', async () => {
    const workspace = temp('frozen-shadow-workspace');
    const global = temp('frozen-shadow-global');
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    writeFileSync(join(global, 'review.md'), markdown('Review', 'global', 'Global body'));
    const listed = await listPredefinedWorkflows(options);
    const ref = listed.workflows[0]!.workflowRef;
    const original = await resolvePredefinedWorkflow(options, ref);
    expect(original?.source.scope).toBe('global');

    const workspaceRoot = join(workspace, '.muster', 'workflows');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, 'review.md'), markdown('Review', 'workspace', 'Workspace body'));

    await expect(resolvePredefinedWorkflowSource(options, original!.source)).resolves.toMatchObject({
      document: { body: 'Global body', scope: 'global' },
      source: original!.source,
    });
  });

  it('resolves a legacy frozen source after the canonical root appears', async () => {
    const workspace = temp('frozen-legacy-workspace');
    const global = temp('frozen-legacy-global');
    const options = { workspaceFolder: workspace, globalWorkflowFolder: global };
    const legacy = join(workspace, '.muster', 'workflow');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'legacy.md'), markdown('Legacy', 'old root', 'Legacy body'));
    const listed = await listPredefinedWorkflows(options);
    const source = (await resolvePredefinedWorkflow(options, listed.workflows[0]!.workflowRef))!.source;
    expect(source.catalogRootKind).toBe('legacy');

    const canonical = join(workspace, '.muster', 'workflows');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'canonical.md'), markdown('Canonical', 'new root', 'Canonical body'));

    await expect(resolvePredefinedWorkflowSource(options, source)).resolves.toMatchObject({
      document: { name: 'Legacy', body: 'Legacy body' },
      source,
    });
  });

  it('rejects ambiguous and invalid bundle contents', async () => {
    const workspace = temp('invalid-bundles-workspace');
    const global = temp('invalid-bundles-global');
    const ambiguous = join(global, 'ambiguous');
    mkdirSync(ambiguous, { recursive: true });
    writeFileSync(join(ambiguous, 'first.md'), markdown('Ambiguous', 'one', 'Body'));
    writeFileSync(join(ambiguous, 'second.md'), markdown('Ambiguous', 'two', 'Body'));
    const invalidName = join(global, 'invalid-name');
    mkdirSync(invalidName, { recursive: true });
    writeFileSync(join(invalidName, 'invalid-name.md'), markdown('Invalid', 'control', 'Body'));
    writeFileSync(join(invalidName, 'bad\x01.js'), 'process.stdout.write("bad")');

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ file: 'ambiguous', code: 'invalid_workflow_file' }),
      expect.objectContaining({ file: 'invalid-name', code: 'invalid_workflow_file' }),
    ]);
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks in nested bundle paths and flat script paths', async () => {
    const workspace = temp('symlink-workspace');
    const global = temp('symlink-global');
    const bundle = join(global, 'symlink-bundle');
    mkdirSync(join(bundle, 'scripts'), { recursive: true });
    writeFileSync(join(bundle, 'symlink-bundle.md'), markdown('Symlink bundle', 'invalid', 'Body'));
    writeFileSync(join(bundle, 'scripts', 'real.js'), 'process.stdout.write("real")');
    symlinkSync(join(bundle, 'scripts', 'real.js'), join(bundle, 'scripts', 'link.js'));
    const bundled = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(bundled.workflows).toEqual([]);

    const flatRoot = join(workspace, '.muster', 'workflows');
    mkdirSync(join(flatRoot, 'scripts'), { recursive: true });
    writeFileSync(join(flatRoot, 'flat.md'), markdown('Flat', 'script', 'Body'));
    writeFileSync(join(flatRoot, 'scripts', 'real.js'), 'process.stdout.write("real")');
    symlinkSync(join(flatRoot, 'scripts'), join(flatRoot, 'alias'), 'dir');
    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    const flat = listed.workflows.find((entry) => entry.name === 'Flat')!;
    const resolved = await resolvePredefinedWorkflow(
      { workspaceFolder: workspace, globalWorkflowFolder: global },
      flat.workflowRef,
    );
    await expect(resolvePredefinedWorkflowScript(resolved!, 'alias/real.js', 'node')).resolves.toBeUndefined();
  });

  it('uses UTF-8 byte ordering for duplicate workflow candidates', async () => {
    const workspace = temp('utf8-order-workspace');
    const global = temp('utf8-order-global');
    const root = join(workspace, '.muster', 'workflows');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '\u{10000}.md'), markdown('Deploy', 'astral', 'Astral body'));
    writeFileSync(join(root, '\uE000.md'), markdown('deploy', 'bmp', 'BMP body'));

    const listed = await listPredefinedWorkflows({ workspaceFolder: workspace, globalWorkflowFolder: global });
    expect(listed.workflows).toEqual([
      expect.objectContaining({ name: 'deploy', description: 'bmp' }),
    ]);
    expect(listed.diagnostics).toEqual([
      expect.objectContaining({ file: '\u{10000}.md', code: 'duplicate_workflow_name' }),
    ]);
  });
});
