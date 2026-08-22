import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { open, opendir } from 'node:fs/promises';

export const PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE = 128;
export const PREDEFINED_WORKFLOW_MAX_FILE_BYTES = 256 * 1024;
export const PREDEFINED_WORKFLOW_MAX_BODY_CHARS = 120_000;
export const PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS = 32;

export type PredefinedWorkflowScope = 'workspace' | 'global';

export interface PredefinedWorkflowSummary {
  workflowRef: string;
  name: string;
  description: string;
  scope: PredefinedWorkflowScope;
}

export interface PredefinedWorkflowDiagnostic {
  file: string;
  code: string;
  message: string;
}

export interface PredefinedWorkflowDocument extends PredefinedWorkflowSummary {
  body: string;
  provenance: 'user-authored-untrusted';
}

export interface PredefinedWorkflowCatalogOptions {
  workspaceFolder: string;
  globalWorkflowFolder?: string;
}

interface CatalogEntry extends PredefinedWorkflowDocument {
  file: string;
  collisionKey: string;
}

function boundedFileLabel(file: string): string {
  return basename(file).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || '(unnamed)';
}

/**
 * Filesystem errors embed the absolute path in their message. The catalog contract
 * keeps list/get responses free of host paths, so I/O failures collapse to a fixed
 * label and only parser reasons (which never see a path) pass through verbatim.
 */
function boundedDiagnosticMessage(error: unknown): string {
  if (error instanceof CatalogFileError) return error.message.slice(0, 240);
  return 'unable to read workflow file';
}

/** Marker for catalog rejections whose message is authored here, not by Node. */
class CatalogFileError extends Error {}

function stripSymmetricQuotes(value: string): string {
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) return value.slice(1, -1);
  return value;
}

export function parsePredefinedWorkflowMarkdown(
  source: string,
): { ok: true; name: string; description: string; body: string } | { ok: false; reason: string } {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return { ok: false, reason: 'frontmatter must start on the first line' };
  const close = lines.indexOf('---', 1);
  if (close < 0) return { ok: false, reason: 'frontmatter closing delimiter is missing' };

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, close)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { ok: false, reason: 'frontmatter must use key: value lines' };
    const key = line.slice(0, colon).trim();
    if (key !== 'name' && key !== 'description') {
      return { ok: false, reason: `unsupported frontmatter field: ${key || '(empty)'}` };
    }
    if (fields.has(key)) return { ok: false, reason: `duplicate frontmatter field: ${key}` };
    const value = stripSymmetricQuotes(line.slice(colon + 1).trim());
    if (!value || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      return { ok: false, reason: `invalid frontmatter value: ${key}` };
    }
    fields.set(key, value);
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || name.length > 200) return { ok: false, reason: 'name is required and must be at most 200 characters' };
  if (!description || description.length > 1_000) {
    return { ok: false, reason: 'description is required and must be at most 1000 characters' };
  }
  const body = lines.slice(close + 1).join('\n').trim();
  if (!body) return { ok: false, reason: 'workflow body is empty' };
  if (body.length > PREDEFINED_WORKFLOW_MAX_BODY_CHARS) {
    return { ok: false, reason: 'workflow body exceeds the catalog limit' };
  }
  return { ok: true, name, description, body };
}

function workflowRef(scope: PredefinedWorkflowScope, file: string, content: Buffer): string {
  return `pwf_${createHash('sha256')
    .update(scope).update('\0').update(basename(file)).update('\0').update(content)
    .digest('hex').slice(0, 32)}`;
}

async function scanScope(
  folder: string,
  scope: PredefinedWorkflowScope,
): Promise<{ entries: CatalogEntry[]; diagnostics: PredefinedWorkflowDiagnostic[] }> {
  const diagnostics: PredefinedWorkflowDiagnostic[] = [];
  const entries: CatalogEntry[] = [];
  // Stream the directory instead of materializing every dirent: a very large
  // `.muster/workflow` would otherwise allocate the whole listing in the extension
  // host before the per-scope bound is ever applied.
  const files: string[] = [];
  let truncated = false;
  try {
    const dir = await opendir(folder);
    try {
      for await (const entry of dir) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
        if (files.length >= PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE) {
          truncated = true;
          break;
        }
        files.push(entry.name);
      }
    } finally {
      // Breaking out of `for await` closes the handle; closing twice is not an error
      // worth surfacing.
      await dir.close().catch(() => undefined);
    }
  } catch {
    return { entries: [], diagnostics: [] };
  }
  if (truncated) {
    diagnostics.push({
      file: '(scope)',
      code: 'scope_truncated',
      message: `more than ${PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE} workflow files in ${scope} scope; later files ignored`,
    });
  }
  // Byte-wise order so the same catalog resolves duplicates identically on every
  // host: `localeCompare` varies with the active locale.
  files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const file of files) {
    const fullPath = join(folder, file);
    try {
      const handle = await open(fullPath, 'r');
      let content: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new CatalogFileError('not a regular file');
        if (info.size > PREDEFINED_WORKFLOW_MAX_FILE_BYTES) {
          throw new CatalogFileError('file exceeds the catalog size limit');
        }
        // Read one byte past the bound from the same handle that was stat'd, so a
        // file growing between stat and read is rejected rather than allocated whole.
        const buffer = Buffer.allocUnsafe(PREDEFINED_WORKFLOW_MAX_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > PREDEFINED_WORKFLOW_MAX_FILE_BYTES) {
          throw new CatalogFileError('file exceeds the catalog size limit');
        }
        content = Buffer.from(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close().catch(() => undefined);
      }
      const parsed = parsePredefinedWorkflowMarkdown(content.toString('utf8'));
      if (!parsed.ok) throw new CatalogFileError(parsed.reason);
      entries.push({
        workflowRef: workflowRef(scope, file, content),
        name: parsed.name,
        description: parsed.description,
        scope,
        body: parsed.body,
        provenance: 'user-authored-untrusted',
        file,
        collisionKey: parsed.name.trim().toLowerCase(),
      });
    } catch (error) {
      if (diagnostics.length < PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS) {
        diagnostics.push({
          file: boundedFileLabel(file),
          code: 'invalid_workflow_file',
          message: boundedDiagnosticMessage(error),
        });
      }
    }
  }
  const unique = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.collisionKey)) {
      unique.set(entry.collisionKey, entry);
    } else if (diagnostics.length < PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS) {
      diagnostics.push({
        file: boundedFileLabel(entry.file),
        code: 'duplicate_workflow_name',
        message: `duplicate workflow name in ${scope} scope; lexicographically first file wins`,
      });
    }
  }
  return { entries: [...unique.values()], diagnostics };
}

async function scanCatalog(options: PredefinedWorkflowCatalogOptions): Promise<{
  entries: CatalogEntry[];
  diagnostics: PredefinedWorkflowDiagnostic[];
}> {
  const [global, workspace] = await Promise.all([
    scanScope(options.globalWorkflowFolder ?? join(homedir(), '.muster', 'workflow'), 'global'),
    scanScope(join(options.workspaceFolder, '.muster', 'workflow'), 'workspace'),
  ]);
  const diagnostics = [...global.diagnostics, ...workspace.diagnostics]
    .slice(0, PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS);
  const selected = new Map<string, CatalogEntry>();
  for (const entry of global.entries) {
    if (!selected.has(entry.collisionKey)) selected.set(entry.collisionKey, entry);
  }
  for (const entry of workspace.entries) selected.set(entry.collisionKey, entry);
  return {
    entries: [...selected.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope) || left.file.localeCompare(right.file)),
    diagnostics,
  };
}

export async function listPredefinedWorkflows(options: PredefinedWorkflowCatalogOptions): Promise<{
  workflows: readonly PredefinedWorkflowSummary[];
  diagnostics: readonly PredefinedWorkflowDiagnostic[];
}> {
  const catalog = await scanCatalog(options);
  return {
    workflows: catalog.entries.map(({ workflowRef, name, description, scope }) => ({
      workflowRef, name, description, scope,
    })),
    diagnostics: catalog.diagnostics,
  };
}

export async function getPredefinedWorkflow(
  options: PredefinedWorkflowCatalogOptions,
  ref: string,
): Promise<PredefinedWorkflowDocument | undefined> {
  if (!/^pwf_[a-f0-9]{32}$/.test(ref)) return undefined;
  const catalog = await scanCatalog(options);
  const entry = catalog.entries.find((candidate) => candidate.workflowRef === ref);
  if (!entry) return undefined;
  const { workflowRef, name, description, scope, body, provenance } = entry;
  return { workflowRef, name, description, scope, body, provenance };
}
