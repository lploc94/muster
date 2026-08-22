import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getPredefinedWorkflow,
  listPredefinedWorkflows,
  parsePredefinedWorkflowMarkdown,
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
});
