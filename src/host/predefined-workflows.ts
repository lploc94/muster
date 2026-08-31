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
import { decodeWorkflowManifest } from '../task/workflow-codec';
import {
  WORKFLOW_DESCRIPTION_MAX_LENGTH,
  WORKFLOW_INSTRUCTIONS_MAX_LENGTH,
  WORKFLOW_NAME_MAX_LENGTH,
  WORKFLOW_PACKAGE_PATH_MAX_LENGTH,
  WORKFLOW_SCHEMA,
  isValidWorkflowScriptFile,
  type ScriptInterpreter,
  type WorkflowCatalogRootKind,
  type WorkflowEntryContract,
  type WorkflowPackageKind,
  type WorkflowScriptSource,
  type WorkflowTopology,
  type WorkflowPackageSource,
} from '../task/workflow-types';

export const PREDEFINED_WORKFLOW_CATALOG_DIRECTORY = 'workflows';
export const PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE = 128;
export const PREDEFINED_WORKFLOW_MAX_FILE_BYTES = 256 * 1024;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES = 1024 * 1024;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_FILES = 256;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_DIRECTORIES = 256;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_ENTRIES = 512;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_DEPTH = 32;
export const PREDEFINED_WORKFLOW_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
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

export type PredefinedWorkflowDocument = PredefinedWorkflowSummary;

export interface PredefinedWorkflowDiagnostic {
  file: string;
  code: string;
  message: string;
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
  /** Normalized manifest retained inside the host resolution path. */
  manifest: {
    name: string;
    topology: WorkflowTopology;
    entryContracts: WorkflowEntryContract[];
  };
}

export type FrozenPredefinedWorkflowDefinition = {
  name: string;
  topology: WorkflowTopology;
  entryContracts: WorkflowEntryContract[];
  source: WorkflowPackageSource;
  packageRoot: string;
};

export type PredefinedWorkflowDefinitionResolution =
  | ({ ok: true } & FrozenPredefinedWorkflowDefinition)
  | { ok: false; code: 'predefined_workflow_stale' | 'predefined_workflow_asset_invalid'; reason: string };

interface CatalogEntry {
  document: PredefinedWorkflowDocument;
  source: WorkflowPackageSource;
  collisionKey: string;
}

interface CatalogCandidate {
  name: string;
  packageRoot: string;
  kind: 'directory' | 'symlink';
}

interface ScopeScan {
  present: boolean;
  entries: CatalogEntry[];
  diagnostics: PredefinedWorkflowDiagnostic[];
}

interface PackageFile {
  relativePath: string;
  content: Buffer;
}

interface CanonicalBundle {
  files: PackageFile[];
  manifestContent: Buffer;
}

interface CanonicalManifestMetadata {
  name: string;
  description: string;
}

const packageFiles = new WeakMap<ResolvedPredefinedWorkflow, readonly PackageFile[]>();

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

function normalizedRelativePath(value: string, allowDot = false): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return undefined;
  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) return undefined;
  const parts = portable.split('/');
  if (parts.some((part) => part === '..' || part === '' || (!allowDot && part === '.') || /[\x00-\x1f\x7f]/.test(part))) {
    return undefined;
  }
  return parts.join('/');
}

function sourceDescriptorValid(source: WorkflowPackageSource): boolean {
  const packagePath = normalizedRelativePath(source.packagePath);
  const entryFile = normalizedRelativePath(source.entryFile);
  return source.kind === 'predefined' &&
    (source.scope === 'workspace' || source.scope === 'global') &&
    source.packageKind === 'bundle' &&
    (source.catalogRootKind === 'canonical' || source.catalogRootKind === 'custom') &&
    (source.catalogRootKind !== 'custom' || source.scope === 'global') &&
    typeof source.packagePath === 'string' && source.packagePath.length <= WORKFLOW_PACKAGE_PATH_MAX_LENGTH &&
    typeof source.entryFile === 'string' && source.entryFile === 'workflow.json' &&
    packagePath !== undefined &&
    entryFile === 'workflow.json' &&
    !source.packagePath.includes('/') &&
    !source.packagePath.includes('\\') &&
    /^pwf_[a-f0-9]{32}$/.test(source.workflowRef) &&
    /^[a-f0-9]{64}$/.test(source.packageSha256);
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
  hash.update('muster.workflow.package/v2\0', 'utf8');
  const fileCount = Buffer.allocUnsafe(4);
  fileCount.writeUInt32BE(files.length);
  hash.update(fileCount);
  const updateFramed = (value: Buffer): void => {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    hash.update(length);
    hash.update(value);
  };
  for (const file of files) {
    updateFramed(Buffer.from(file.relativePath, 'utf8'));
    updateFramed(file.content);
  }
  return hash.digest('hex');
}

function makeWorkflowRef(
  scope: PredefinedWorkflowScope,
  packagePath: string,
  packageSha256: string,
): string {
  return `pwf_${createHash('sha256')
    .update(scope).update('\0')
    .update('bundle').update('\0')
    .update(packagePath).update('\0')
    .update('workflow.json').update('\0')
    .update(packageSha256)
    .digest('hex').slice(0, 32)}`;
}

function parseCanonicalJson(content: Buffer): Record<string, unknown> {
  if (content.byteLength > PREDEFINED_WORKFLOW_MAX_FILE_BYTES) {
    throw new CatalogFileError('workflow manifest exceeds the package size limit');
  }
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) {
    throw new CatalogFileError('workflow.json is not valid UTF-8');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CatalogFileError('workflow.json is malformed JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CatalogFileError('workflow.json must contain an object');
  }
  return raw as Record<string, unknown>;
}

function parseCanonicalManifestMetadata(content: Buffer): CanonicalManifestMetadata {
  const raw = parseCanonicalJson(content);
  const allowed = new Set(['schema', 'name', 'description', 'inputs', 'outputs', 'nodes', 'edges']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new CatalogFileError('invalid workflow manifest metadata');
  }
  if (raw.schema !== WORKFLOW_SCHEMA) throw new CatalogFileError('unsupported workflow schema');
  if (
    typeof raw.name !== 'string' || raw.name.length === 0 ||
    raw.name.length > WORKFLOW_NAME_MAX_LENGTH || raw.name.includes('\0')
  ) {
    throw new CatalogFileError('invalid workflow name');
  }
  if (
    raw.description !== undefined &&
    (
      typeof raw.description !== 'string' || raw.description.length === 0 ||
      raw.description.length > WORKFLOW_DESCRIPTION_MAX_LENGTH || raw.description.includes('\0')
    )
  ) throw new CatalogFileError('invalid workflow description');
  if (!Array.isArray(raw.inputs) || !Array.isArray(raw.outputs) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new CatalogFileError('workflow manifest arrays are required');
  }
  return {
    name: raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
  };
}

function parseCanonicalManifest(content: Buffer): ResolvedPredefinedWorkflow['manifest'] {
  const raw = parseCanonicalJson(content);
  const decoded = decodeWorkflowManifest(raw, 'saved');
  if (!decoded.ok) throw new CatalogFileError(`invalid workflow manifest: ${decoded.reason}`);
  return {
    name: decoded.name,
    topology: decoded.topology,
    entryContracts: decoded.entryContracts,
  };
}

async function readCanonicalBundle(root: string): Promise<CanonicalBundle> {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new CatalogFileError('workflow package must be a regular directory');
  }
  const files = await readBundleFiles(root);
  const manifests = files.filter((file) =>
    file.relativePath.toLowerCase().split('/').at(-1) === 'workflow.json');
  const authoritative = files.find((file) => file.relativePath === 'workflow.json');
  if (manifests.length !== 1 || !authoritative) {
    throw new CatalogFileError(
      manifests.length === 0
        ? 'workflow bundle must contain one authoritative workflow.json'
        : 'workflow bundle must contain exactly one authoritative workflow.json',
    );
  }
  return { files, manifestContent: authoritative.content };
}

function makeResolvedPredefinedWorkflow(input: {
  source: WorkflowPackageSource;
  packageRoot: string;
  manifest: ResolvedPredefinedWorkflow['manifest'];
  files: readonly PackageFile[];
}): ResolvedPredefinedWorkflow {
  const resolved: ResolvedPredefinedWorkflow = {
    document: {
      workflowRef: input.source.workflowRef,
      name: input.manifest.name,
      description: input.manifest.topology.description ?? '',
      scope: input.source.scope,
      packageKind: 'bundle',
    },
    source: input.source,
    packageRoot: input.packageRoot,
    manifest: input.manifest,
  };
  packageFiles.set(resolved, input.files);
  return resolved;
}

async function scanScope(
  folder: string,
  scope: PredefinedWorkflowScope,
  catalogRootKind: WorkflowCatalogRootKind,
): Promise<ScopeScan> {
  const rootInfo = await lstat(folder).catch(() => undefined);
  if (!rootInfo) return { present: false, entries: [], diagnostics: [] };
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return {
      present: true,
      entries: [],
      diagnostics: [{
        file: '(scope)',
        code: 'invalid_catalog_root',
        message: `unable to read ${scope} workflow catalog`,
      }],
    };
  }

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
      const kind = entry.isSymbolicLink()
        ? 'symlink'
        : entry.isDirectory()
          ? 'directory'
          : undefined;
      if (!kind) continue;
      candidates.push({ name: entry.name, packageRoot: join(folder, entry.name), kind });
      candidates.sort((left, right) => compareBytes(left.name, right.name));
      if (candidates.length > PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE) {
        candidates.pop();
        truncated = true;
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (truncated) {
    diagnostics.push({
      file: '(scope)',
      code: 'scope_truncated',
      message: `more than ${PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE} workflow packages in ${scope} scope; lexicographically later entries ignored`,
    });
  }
  candidates.sort((left, right) => compareBytes(left.name, right.name));

  const entries: CatalogEntry[] = [];
  for (const candidate of candidates) {
    try {
      if (
        candidate.kind !== 'directory' ||
        !candidate.name ||
        candidate.name.length > WORKFLOW_PACKAGE_PATH_MAX_LENGTH ||
        !normalizedRelativePath(candidate.name)
      ) {
        throw new CatalogFileError('workflow package name is unsafe');
      }
      const bundle = await readCanonicalBundle(candidate.packageRoot);
      const metadata = parseCanonicalManifestMetadata(bundle.manifestContent);
      const packagePath = candidate.name;
      const packageSha256 = packageDigest(bundle.files);
      const workflowRef = makeWorkflowRef(scope, packagePath, packageSha256);
      const source: WorkflowPackageSource = {
        kind: 'predefined',
        scope,
        packageKind: 'bundle',
        catalogRootKind,
        packagePath,
        entryFile: 'workflow.json',
        workflowRef,
        packageSha256,
      };
      if (!sourceDescriptorValid(source)) throw new CatalogFileError('invalid workflow package identity');
      const entry: CatalogEntry = {
        document: {
          workflowRef,
          name: metadata.name,
          description: metadata.description,
          scope,
          packageKind: 'bundle',
        },
        source,
        collisionKey: metadata.name.trim().toLowerCase(),
      };
      entries.push(entry);
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
        file: boundedFileLabel(entry.source.packagePath),
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
  return {
    folder: join(base, '.muster', PREDEFINED_WORKFLOW_CATALOG_DIRECTORY),
    kind: 'canonical',
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
      compareBytes(left.document.name, right.document.name) ||
      compareBytes(left.source.scope, right.source.scope) ||
      compareBytes(left.source.packagePath, right.source.packagePath)),
    diagnostics,
  };
}

export async function listPredefinedWorkflows(options: PredefinedWorkflowCatalogOptions): Promise<{
  workflows: readonly PredefinedWorkflowSummary[];
  diagnostics: readonly PredefinedWorkflowDiagnostic[];
}> {
  const catalog = await scanCatalog(options);
  return {
    workflows: catalog.entries.map(({ document }) => ({ ...document })),
    diagnostics: catalog.diagnostics,
  };
}

export async function resolvePredefinedWorkflow(
  options: PredefinedWorkflowCatalogOptions,
  ref: string,
): Promise<ResolvedPredefinedWorkflow | undefined> {
  if (!/^pwf_[a-f0-9]{32}$/.test(ref)) return undefined;
  const catalog = await scanCatalog(options);
  const entry = catalog.entries.find((candidate) => candidate.source.workflowRef === ref);
  return entry ? resolvePredefinedWorkflowSource(options, entry.source) : undefined;
}

function catalogRootForSource(
  options: PredefinedWorkflowCatalogOptions,
  source: WorkflowPackageSource,
): string | undefined {
  if (source.catalogRootKind === 'custom') {
    return source.scope === 'global' ? options.globalWorkflowFolder : undefined;
  }
  const base = source.scope === 'global' ? homedir() : options.workspaceFolder;
  return join(base, '.muster', PREDEFINED_WORKFLOW_CATALOG_DIRECTORY);
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
    const packageRoot = resolve(root, source.packagePath);
    if (
      !isWithin(root, packageRoot) ||
      relative(root, packageRoot).split(/[\\/]/).length !== 1 ||
      !(await pathHasNoSymlinkComponents(root, packageRoot))
    ) return undefined;
    const bundle = await readCanonicalBundle(packageRoot);
    const packageSha256 = packageDigest(bundle.files);
    const workflowRef = makeWorkflowRef(source.scope, source.packagePath, packageSha256);
    if (packageSha256 !== source.packageSha256 || workflowRef !== source.workflowRef) return undefined;
    const manifest = parseCanonicalManifest(bundle.manifestContent);
    return makeResolvedPredefinedWorkflow({
      source,
      packageRoot,
      manifest,
      files: bundle.files,
    });
  } catch {
    return undefined;
  }
}

export async function getPredefinedWorkflow(
  options: PredefinedWorkflowCatalogOptions,
  ref: string,
): Promise<PredefinedWorkflowDocument | undefined> {
  if (!/^pwf_[a-f0-9]{32}$/.test(ref)) return undefined;
  const catalog = await scanCatalog(options);
  const entry = catalog.entries.find((candidate) => candidate.source.workflowRef === ref);
  return entry ? { ...entry.document } : undefined;
}

function utf8Asset(
  content: Buffer,
  file: string,
  kind: 'instruction' | 'script',
  allowEmpty = false,
): string {
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content)) {
    throw new CatalogFileError(`predefined workflow ${kind} is not valid UTF-8: ${file}`);
  }
  if (!allowEmpty && content.byteLength === 0) {
    throw new CatalogFileError(`predefined workflow ${kind} is empty: ${file}`);
  }
  return text;
}

export async function freezePredefinedWorkflowDefinition(
  resolved: ResolvedPredefinedWorkflow,
): Promise<
  | { ok: true; name: string; topology: WorkflowTopology; entryContracts: WorkflowEntryContract[] }
  | { ok: false; reason: string }
> {
  try {
    const files = packageFiles.get(resolved);
    if (!files) return { ok: false, reason: 'predefined workflow package is unavailable' };
    if (packageDigest(files) !== resolved.source.packageSha256) {
      return { ok: false, reason: 'predefined workflow package changed after resolution' };
    }
    const byPath = new Map(files.map((file) => [file.relativePath, file.content] as const));
    const nodes = resolved.manifest.topology.nodes.map((node) => {
      let instructions = node.instructions;
      if (instructions?.kind === 'file') {
        const normalized = normalizedRelativePath(instructions.file);
        const content = normalized ? byPath.get(normalized) : undefined;
        if (!content) throw new CatalogFileError(`predefined workflow asset is missing: ${instructions.file}`);
        const text = utf8Asset(content, instructions.file, 'instruction');
        if (
          content.byteLength > PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES ||
          text.length > WORKFLOW_INSTRUCTIONS_MAX_LENGTH
        ) throw new CatalogFileError(`predefined workflow instruction exceeds the package limit: ${instructions.file}`);
        instructions = {
          kind: 'file',
          file: instructions.file,
          content: text,
          sha256: digestBytes(content),
        };
      }

      let execution = node.execution;
      if (execution?.kind === 'script') {
        const normalized = normalizedRelativePath(execution.file);
        const content = normalized ? byPath.get(normalized) : undefined;
        if (!content) throw new CatalogFileError(`predefined workflow asset is missing: ${execution.file}`);
        if (!isValidWorkflowScriptFile(execution.file, execution.interpreter)) {
          throw new CatalogFileError(`predefined workflow script is invalid: ${execution.file}`);
        }
        utf8Asset(content, execution.file, 'script', true);
        if (content.byteLength > PREDEFINED_WORKFLOW_MAX_BUNDLE_FILE_BYTES) {
          throw new CatalogFileError(`predefined workflow script exceeds the package limit: ${execution.file}`);
        }
        execution = {
          ...execution,
          source: {
            ...resolved.source,
            scriptSha256: digestBytes(content),
          } satisfies WorkflowScriptSource,
        };
      }
      return {
        ...node,
        ...(instructions ? { instructions } : {}),
        ...(execution ? { execution } : {}),
      };
    });
    return {
      ok: true,
      name: resolved.manifest.name,
      topology: { ...resolved.manifest.topology, nodes },
      entryContracts: resolved.manifest.entryContracts.map((contract) => ({ ...contract })),
    };
  } catch (error) {
    return { ok: false, reason: boundedDiagnosticMessage(error) };
  }
}

/** Resolve, revalidate, and freeze one package immediately before persistence. */
export async function resolvePredefinedWorkflowDefinition(
  options: PredefinedWorkflowCatalogOptions,
  ref: string,
): Promise<PredefinedWorkflowDefinitionResolution> {
  const listed = await resolvePredefinedWorkflow(options, ref);
  if (!listed) {
    return {
      ok: false,
      code: 'predefined_workflow_stale',
      reason: 'predefined workflow is not found or changed; list the catalog again',
    };
  }
  const frozen = await freezePredefinedWorkflowDefinition(listed);
  if (!frozen.ok) {
    return { ok: false, code: 'predefined_workflow_asset_invalid', reason: frozen.reason };
  }
  return {
    ok: true,
    name: frozen.name,
    topology: frozen.topology,
    entryContracts: frozen.entryContracts,
    source: listed.source,
    packageRoot: listed.packageRoot,
  };
}

export async function resolvePredefinedWorkflowScript(
  resolved: ResolvedPredefinedWorkflow,
  file: string,
  interpreter: ScriptInterpreter,
): Promise<WorkflowScriptSource | undefined> {
  const normalized = normalizedRelativePath(file);
  if (!normalized || !isValidWorkflowScriptFile(normalized, interpreter)) return undefined;
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
