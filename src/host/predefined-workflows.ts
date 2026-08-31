import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import type {
  ScriptInterpreter,
  WorkflowCatalogRootKind,
  WorkflowPackageKind,
  WorkflowPackageSource,
  WorkflowScriptSource,
} from '../task/workflow-types';

export const PREDEFINED_WORKFLOW_CATALOG_DIRECTORY = 'workflows';
export const PREDEFINED_WORKFLOW_LEGACY_DIRECTORY = 'workflow';
export const PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE = 128;
export const PREDEFINED_WORKFLOW_MAX_FILE_BYTES = 256 * 1024;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES = 1024 * 1024;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_FILES = 256;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_DIRECTORIES = 256;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_ENTRIES = 512;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_DEPTH = 32;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const PREDEFINED_WORKFLOW_MAX_BODY_CHARS = 120_000;
export const PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS = 32;

export type PredefinedWorkflowScope = 'workspace' | 'global';
export type PredefinedWorkflowPackageKind = WorkflowPackageKind;

export interface PredefinedWorkflowSummary {
  workflowRef: string;
  name: string;
  description: string;
  scope: PredefinedWorkflowScope;
  packageKind: PredefinedWorkflowPackageKind;
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
  /** Explicit catalog root, primarily for hosts/tests with an isolated home. */
  globalWorkflowFolder?: string;
}

export interface ResolvedPredefinedWorkflow {
  document: PredefinedWorkflowDocument;
  source: WorkflowPackageSource;
  /** Canonical package root, retained only inside the host resolution path. */
  packageRoot: string;
}

interface CatalogEntry extends PredefinedWorkflowDocument {
  source: WorkflowPackageSource;
  packageRoot: string;
  collisionKey: string;
}

interface CatalogCandidate {
  name: string;
  packageKind: PredefinedWorkflowPackageKind;
  packageRoot: string;
  entryFile?: string;
}

interface ScopeScan {
  present: boolean;
  entries: CatalogEntry[];
  diagnostics: PredefinedWorkflowDiagnostic[];
}

class CatalogFileError extends Error {}

function compareBytes(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function boundedFileLabel(file: string): string {
  return basename(file).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || '(unnamed)';
}

function boundedDiagnosticMessage(error: unknown): string {
  if (error instanceof CatalogFileError) return error.message.slice(0, 240);
  return 'unable to read workflow package';
}

function stripSymmetricQuotes(value: string): string {
  if (value.length >= 2 && (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) return value.slice(1, -1);
  return value;
}

function digestBytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && !rel.split(/[\\/]/).includes('..'));
}

async function pathHasNoSymlinkComponents(root: string, candidate: string): Promise<boolean> {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return false;
  let current = root;
  for (const part of rel.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return false;
  }
  return true;
}

function normalizedRelativePath(value: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    /[\0\r\n]/.test(value)
  ) return undefined;
  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) return undefined;
  const parts = portable.split('/');
  if (parts.some((part) => part === '..' || part === '' || /[\x00-\x1f\x7f]/.test(part))) return undefined;
  return parts.join('/');
}

function sourceDescriptorValid(source: WorkflowPackageSource): boolean {
  const packagePath = normalizedRelativePath(source.packagePath);
  const entryFile = normalizedRelativePath(source.entryFile);
  return source.kind === 'predefined' &&
    (source.scope === 'workspace' || source.scope === 'global') &&
    (source.packageKind === 'file' || source.packageKind === 'bundle') &&
    (source.catalogRootKind === 'canonical' || source.catalogRootKind === 'legacy' || source.catalogRootKind === 'custom') &&
    (source.catalogRootKind !== 'custom' || (source.scope === 'global' && source.catalogRootKind === 'custom')) &&
    typeof source.packagePath === 'string' && source.packagePath.length <= 1_024 &&
    typeof source.entryFile === 'string' && source.entryFile.length <= 1_024 &&
    packagePath !== undefined &&
    entryFile !== undefined &&
    !entryFile.includes('/') &&
    (source.packageKind === 'file' ? source.packagePath === '.' : source.packagePath !== '.') &&
    (source.packageKind === 'file' ? source.packagePath === '.' : !packagePath.includes('/')) &&
    /^pwf_[a-f0-9]{32}$/.test(source.workflowRef) &&
    /^[a-f0-9]{64}$/.test(source.packageSha256);
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

async function directoryExists(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function readBoundedFile(file: string, maxBytes: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const linkInfo = await lstat(file);
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
      throw new CatalogFileError('symbolic links and non-regular files are not allowed');
    }
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new CatalogFileError('not a regular file');
    if (info.size > maxBytes) throw new CatalogFileError('file exceeds the package size limit');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new CatalogFileError('file exceeds the package size limit');
    return Buffer.from(buffer.subarray(0, offset));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface PackageFile {
  relativePath: string;
  content: Buffer;
}

async function readBundleFiles(root: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];
  let totalBytes = 0;
  let directoryCount = 0;
  let entryCount = 0;

  const walk = async (folder: string, prefix: string, depth: number): Promise<void> => {
    directoryCount += 1;
    if (directoryCount > PREDEFINED_WORKFLOW_MAX_BUNDLE_DIRECTORIES) {
      throw new CatalogFileError('workflow bundle contains too many directories');
    }
    if (depth > PREDEFINED_WORKFLOW_MAX_BUNDLE_DEPTH) {
      throw new CatalogFileError('workflow bundle is nested too deeply');
    }
    const entries: Array<{ name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }> = [];
    const directory = await opendir(folder);
    try {
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > PREDEFINED_WORKFLOW_MAX_BUNDLE_ENTRIES) {
          throw new CatalogFileError('workflow bundle contains too many entries');
        }
        const kind = entry.isSymbolicLink()
          ? 'symlink'
          : entry.isFile()
            ? 'file'
            : entry.isDirectory()
              ? 'directory'
              : 'other';
        entries.push({ name: entry.name, kind });
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    entries.sort((left, right) => compareBytes(left.name, right.name));
    for (const entry of entries) {
      if (entry.kind === 'symlink') throw new CatalogFileError('symbolic links are not allowed in workflow bundles');
      if (entry.kind === 'other') throw new CatalogFileError('non-regular files are not allowed in workflow bundles');
      const rawRelativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const relativePath = normalizedRelativePath(rawRelativePath);
      if (!relativePath) throw new CatalogFileError('workflow bundle contains an invalid relative path');
      const fullPath = join(folder, entry.name);
      if (entry.kind === 'directory') {
        await walk(fullPath, relativePath, depth + 1);
        continue;
      }
      if (files.length >= PREDEFINED_WORKFLOW_MAX_BUNDLE_FILES) {
        throw new CatalogFileError('workflow bundle contains too many files');
      }
      const content = await readBoundedFile(fullPath, PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES);
      totalBytes += content.byteLength;
      if (totalBytes > PREDEFINED_WORKFLOW_MAX_BUNDLE_BYTES) {
        throw new CatalogFileError('workflow bundle exceeds the aggregate size limit');
      }
      files.push({ relativePath, content });
    }
  };

  await walk(root, '', 0);
  files.sort((left, right) => compareBytes(left.relativePath, right.relativePath));
  return files;
}

function packageDigest(files: readonly PackageFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(file.content);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex');
}

async function bundleCandidate(
  root: string,
  directoryName: string,
): Promise<{ entryFile: string; files: PackageFile[] }> {
  const files = await readBundleFiles(root);
  const markdown = files.filter((file) =>
    file.relativePath.toLowerCase().endsWith('.md') && !file.relativePath.includes('/'));
  const preferred = `${directoryName}.md`;
  const entry = markdown.find((file) => file.relativePath === preferred) ??
    (markdown.length === 1 ? markdown[0] : undefined);
  if (!entry) {
    throw new CatalogFileError(
      markdown.length === 0
        ? 'workflow bundle must contain an entry Markdown file'
        : 'workflow bundle has more than one possible entry Markdown file',
    );
  }
  return { entryFile: entry.relativePath, files };
}

function makeWorkflowRef(
  scope: PredefinedWorkflowScope,
  packageKind: PredefinedWorkflowPackageKind,
  packagePath: string,
  entryFile: string,
  packageSha256: string,
): string {
  return `pwf_${createHash('sha256')
    .update(scope).update('\0')
    .update(packageKind).update('\0')
    .update(packagePath).update('\0')
    .update(entryFile).update('\0')
    .update(packageSha256)
    .digest('hex').slice(0, 32)}`;
}

async function scanScope(
  folder: string,
  scope: PredefinedWorkflowScope,
  catalogRootKind: WorkflowCatalogRootKind,
): Promise<ScopeScan> {
  if (!(await directoryExists(folder))) return { present: false, entries: [], diagnostics: [] };
  const diagnostics: PredefinedWorkflowDiagnostic[] = [];
  const candidates: CatalogCandidate[] = [];
  let truncated = false;
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await opendir(folder);
  } catch {
    return {
      present: true,
      entries: [],
      diagnostics: [{
        file: '(scope)',
        code: 'scope_unavailable',
        message: `unable to read ${scope} workflow catalog`,
      }],
    };
  }
  try {
    for await (const entry of directory) {
      let candidate: CatalogCandidate | undefined;
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        candidate = {
          name: entry.name,
          packageKind: 'file',
          packageRoot: folder,
          entryFile: entry.name,
        };
      } else if (entry.isDirectory()) {
        candidate = {
          name: entry.name,
          packageKind: 'bundle',
          packageRoot: join(folder, entry.name),
        };
      }
      if (candidate) {
        candidates.push(candidate);
        candidates.sort((left, right) => compareBytes(left.name, right.name));
        if (candidates.length > PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE) {
          candidates.pop();
          truncated = true;
        }
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (truncated) {
    diagnostics.push({
      file: '(scope)',
      code: 'scope_truncated',
      message: `more than ${PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE} workflow entries in ${scope} scope; lexicographically later entries ignored`,
    });
  }
  candidates.sort((left, right) => compareBytes(left.name, right.name));

  const entries: CatalogEntry[] = [];
  for (const candidate of candidates) {
    try {
      let entryFile: string;
      let entryContent: Buffer;
      let files: PackageFile[];
      if (candidate.packageKind === 'file') {
        entryFile = candidate.entryFile!;
        entryContent = await readBoundedFile(join(candidate.packageRoot, entryFile), PREDEFINED_WORKFLOW_MAX_FILE_BYTES);
        files = [{ relativePath: entryFile, content: entryContent }];
      } else {
        const bundle = await bundleCandidate(candidate.packageRoot, candidate.name);
        entryFile = bundle.entryFile;
        files = bundle.files;
        entryContent = files.find((file) => file.relativePath === entryFile)!.content;
      }
      const parsed = parsePredefinedWorkflowMarkdown(entryContent.toString('utf8'));
      if (!parsed.ok) throw new CatalogFileError(parsed.reason);
      const packagePath = candidate.packageKind === 'file' ? '.' : candidate.name;
      const packageSha256 = packageDigest(files);
      const workflowRef = makeWorkflowRef(
        scope,
        candidate.packageKind,
        packagePath,
        entryFile,
        packageSha256,
      );
      const source: WorkflowPackageSource = {
        kind: 'predefined',
        scope,
        packageKind: candidate.packageKind,
        catalogRootKind,
        packagePath,
        entryFile,
        workflowRef,
        packageSha256,
      };
      if (!sourceDescriptorValid(source)) throw new CatalogFileError('invalid workflow package identity');
      entries.push({
        workflowRef,
        name: parsed.name,
        description: parsed.description,
        scope,
        packageKind: candidate.packageKind,
        body: parsed.body,
        provenance: 'user-authored-untrusted',
        source,
        packageRoot: candidate.packageRoot,
        collisionKey: parsed.name.trim().toLowerCase(),
      });
    } catch (error) {
      if (diagnostics.length < PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS) {
        diagnostics.push({
          file: boundedFileLabel(candidate.name),
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
        file: boundedFileLabel(entry.source.entryFile),
        code: 'duplicate_workflow_name',
        message: `duplicate workflow name in ${scope} scope; lexicographically first entry wins`,
      });
    }
  }
  return { present: true, entries: [...unique.values()], diagnostics };
}

async function selectedRoot(
  scope: PredefinedWorkflowScope,
  options: PredefinedWorkflowCatalogOptions,
): Promise<{ folder: string; kind: WorkflowCatalogRootKind }> {
  if (scope === 'global' && options.globalWorkflowFolder) {
    return { folder: options.globalWorkflowFolder, kind: 'custom' };
  }
  const base = scope === 'global' ? homedir() : options.workspaceFolder;
  const canonical = scope === 'global'
    ? join(base, '.muster', PREDEFINED_WORKFLOW_CATALOG_DIRECTORY)
    : join(base, '.muster', PREDEFINED_WORKFLOW_CATALOG_DIRECTORY);
  if (await directoryExists(canonical)) return { folder: canonical, kind: 'canonical' };
  return {
    folder: scope === 'global'
      ? join(base, '.muster', PREDEFINED_WORKFLOW_LEGACY_DIRECTORY)
      : join(base, '.muster', PREDEFINED_WORKFLOW_LEGACY_DIRECTORY),
    kind: 'legacy',
  };
}

async function scanCatalog(options: PredefinedWorkflowCatalogOptions): Promise<{
  entries: CatalogEntry[];
  diagnostics: PredefinedWorkflowDiagnostic[];
}> {
  const [globalRoot, workspaceRoot] = await Promise.all([
    selectedRoot('global', options),
    selectedRoot('workspace', options),
  ]);
  const [global, workspace] = await Promise.all([
    scanScope(globalRoot.folder, 'global', globalRoot.kind),
    scanScope(workspaceRoot.folder, 'workspace', workspaceRoot.kind),
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
      compareBytes(left.name, right.name) ||
      compareBytes(left.scope, right.scope) ||
      compareBytes(left.source.entryFile, right.source.entryFile)),
    diagnostics,
  };
}

export async function listPredefinedWorkflows(options: PredefinedWorkflowCatalogOptions): Promise<{
  workflows: readonly PredefinedWorkflowSummary[];
  diagnostics: readonly PredefinedWorkflowDiagnostic[];
}> {
  const catalog = await scanCatalog(options);
  return {
    workflows: catalog.entries.map(({ workflowRef, name, description, scope, packageKind }) => ({
      workflowRef, name, description, scope, packageKind,
    })),
    diagnostics: catalog.diagnostics,
  };
}

export async function resolvePredefinedWorkflow(
  options: PredefinedWorkflowCatalogOptions,
  ref: string,
): Promise<ResolvedPredefinedWorkflow | undefined> {
  if (!/^pwf_[a-f0-9]{32}$/.test(ref)) return undefined;
  const catalog = await scanCatalog(options);
  const entry = catalog.entries.find((candidate) => candidate.workflowRef === ref);
  if (!entry) return undefined;
  const { source, packageRoot, workflowRef, name, description, scope, packageKind, body, provenance } = entry;
  return {
    document: { workflowRef, name, description, scope, packageKind, body, provenance },
    source,
    packageRoot,
  };
}

function catalogRootForSource(
  options: PredefinedWorkflowCatalogOptions,
  source: WorkflowPackageSource,
): string | undefined {
  if (source.catalogRootKind === 'custom') {
    return source.scope === 'global' ? options.globalWorkflowFolder : undefined;
  }
  const base = source.scope === 'global' ? homedir() : options.workspaceFolder;
  return join(
    base,
    '.muster',
    source.catalogRootKind === 'canonical'
      ? PREDEFINED_WORKFLOW_CATALOG_DIRECTORY
      : PREDEFINED_WORKFLOW_LEGACY_DIRECTORY,
  );
}

/** Resolve a persisted package source without consulting current shadowing or catalog truncation. */
export async function resolvePredefinedWorkflowSource(
  options: PredefinedWorkflowCatalogOptions,
  source: WorkflowPackageSource,
): Promise<ResolvedPredefinedWorkflow | undefined> {
  if (!sourceDescriptorValid(source)) return undefined;
  const catalogRoot = catalogRootForSource(options, source);
  if (!catalogRoot) return undefined;
  try {
    const rootInfo = await lstat(catalogRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
    const root = await realpath(catalogRoot);
    const packageRoot = source.packageKind === 'file'
      ? root
      : resolve(root, source.packagePath);
    if (!isWithin(root, packageRoot) || !(await pathHasNoSymlinkComponents(root, packageRoot))) {
      return undefined;
    }
    if (source.packageKind === 'bundle') {
      const packageInfo = await lstat(packageRoot);
      if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) return undefined;
    }

    let files: PackageFile[];
    let entryContent: Buffer;
    if (source.packageKind === 'file') {
      const entryPath = resolve(root, source.entryFile);
      if (!isWithin(root, entryPath) || !(await pathHasNoSymlinkComponents(root, entryPath))) return undefined;
      entryContent = await readBoundedFile(entryPath, PREDEFINED_WORKFLOW_MAX_FILE_BYTES);
      files = [{ relativePath: source.entryFile, content: entryContent }];
    } else {
      const bundle = await bundleCandidate(packageRoot, source.packagePath);
      if (bundle.entryFile !== source.entryFile) return undefined;
      files = bundle.files;
      const entry = files.find((file) => file.relativePath === source.entryFile);
      if (!entry) return undefined;
      entryContent = entry.content;
    }

    const packageSha256 = packageDigest(files);
    const workflowRef = makeWorkflowRef(
      source.scope,
      source.packageKind,
      source.packagePath,
      source.entryFile,
      packageSha256,
    );
    if (packageSha256 !== source.packageSha256 || workflowRef !== source.workflowRef) return undefined;
    const parsed = parsePredefinedWorkflowMarkdown(entryContent.toString('utf8'));
    if (!parsed.ok) return undefined;
    return {
      document: {
        workflowRef: source.workflowRef,
        name: parsed.name,
        description: parsed.description,
        scope: source.scope,
        packageKind: source.packageKind,
        body: parsed.body,
        provenance: 'user-authored-untrusted',
      },
      source,
      packageRoot,
    };
  } catch {
    return undefined;
  }
}

export async function getPredefinedWorkflow(
  options: PredefinedWorkflowCatalogOptions,
  ref: string,
): Promise<PredefinedWorkflowDocument | undefined> {
  return (await resolvePredefinedWorkflow(options, ref))?.document;
}

export async function resolvePredefinedWorkflowScript(
  resolved: ResolvedPredefinedWorkflow,
  file: string,
  interpreter: ScriptInterpreter,
): Promise<WorkflowScriptSource | undefined> {
  const normalized = normalizedRelativePath(file);
  if (!normalized) return undefined;
  const packageInfo = await lstat(resolved.packageRoot).catch(() => undefined);
  if (!packageInfo?.isDirectory() || packageInfo.isSymbolicLink()) return undefined;
  const packageRoot = await realpath(resolved.packageRoot).catch(() => undefined);
  if (!packageRoot) return undefined;
  const unresolved = resolve(packageRoot, normalized);
  if (!isWithin(packageRoot, unresolved)) return undefined;
  if (!(await pathHasNoSymlinkComponents(packageRoot, unresolved))) return undefined;
  const script = await realpath(unresolved).catch(() => undefined);
  if (!script || !isWithin(packageRoot, script)) return undefined;
  const info = await stat(script).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const lower = extname(script).toLowerCase();
  const validExtension = interpreter === 'node'
    ? ['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'].includes(lower)
    : lower === '.py';
  if (!validExtension) return undefined;
  const content = await readBoundedFile(script, PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES).catch(() => undefined);
  if (!content) return undefined;
  return {
    ...resolved.source,
    scriptSha256: digestBytes(content),
  };
}
