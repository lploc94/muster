/**
 * Shared workflow catalog host↔webview contract.
 * Pure data validation only: no VS Code, repository, filesystem, or MCP imports.
 */

export const WORKFLOW_CATALOG_REQUEST_ID_MAX = 128;
/** Predefined refs use `pwf_` plus 32 lowercase hex chars (36); this allows headroom. */
export const WORKFLOW_CATALOG_REF_MAX = 64;
/** Mirrors the canonical workflow manifest name bound. */
export const WORKFLOW_CATALOG_NAME_MAX = 200;
/** Mirrors the canonical workflow manifest description bound. */
export const WORKFLOW_CATALOG_DESCRIPTION_MAX = 4_096;
/** Per-payload wire budget; the host's 128-file limit is per scope across two scopes, and the route clamps and reports truncation. */
export const WORKFLOW_CATALOG_WORKFLOWS_MAX = 128;
/** Mirrors PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS. */
export const WORKFLOW_CATALOG_DIAGNOSTICS_MAX = 32;
/** boundedFileLabel caps at 160, boundedDiagnosticMessage at 240. */
export const WORKFLOW_CATALOG_DIAGNOSTIC_FILE_MAX = 160;
export const WORKFLOW_CATALOG_DIAGNOSTIC_CODE_MAX = 64;
export const WORKFLOW_CATALOG_DIAGNOSTIC_MESSAGE_MAX = 240;

export const WORKFLOW_CATALOG_ERROR_CODES = ['unavailable', 'invalidRequest'] as const;
export type WorkflowCatalogErrorCode = (typeof WORKFLOW_CATALOG_ERROR_CODES)[number];

export const WORKFLOW_CATALOG_REASONS = ['initial', 'reload'] as const;
export type WorkflowCatalogReason = (typeof WORKFLOW_CATALOG_REASONS)[number];

export type WorkflowCatalogWireScope = 'workspace' | 'global';
export type WorkflowCatalogWirePackageKind = 'bundle';

export interface WorkflowCatalogWireEntry {
  workflowRef: string;
  name: string;
  description: string;
  scope: WorkflowCatalogWireScope;
  packageKind: WorkflowCatalogWirePackageKind;
  inputCount?: number;
  outputCount?: number;
  nodeCount?: number;
}

export interface WorkflowCatalogWireDetail extends WorkflowCatalogWireEntry {
  inputs: readonly { name: string; kind: string; entryNodeId: string; inputRef: string }[];
  outputs: readonly { name: string; kind: string; role: 'terminal' | 'checkpoint' }[];
  nodes: readonly { nodeKey: string; title?: string; kind: 'agent' | 'exit' | 'script'; decision: { next: boolean; prev: boolean; fail: boolean }; assetRefs?: readonly string[] }[];
  edges: readonly { fromNodeKey: string; toNodeKey: string; inputRef: string }[];
}

export interface WorkflowCatalogWireDiagnostic {
  file: string;
  code: string;
  message: string;
}

export interface WorkflowCatalogWire {
  reason: WorkflowCatalogReason;
  workflows: readonly WorkflowCatalogWireEntry[];
  diagnostics: readonly WorkflowCatalogWireDiagnostic[];
}

export interface RequestWorkflowCatalog {
  type: 'requestWorkflowCatalog';
  requestId: string;
  reason: WorkflowCatalogReason;
}

export interface RequestWorkflowCatalogDetail {
  type: 'requestWorkflowCatalogDetail';
  requestId: string;
  workflowRef: string;
}

export type WorkflowCatalogResult =
  | { type: 'workflowCatalogResult'; requestId: string; ok: true; catalog: WorkflowCatalogWire }
  | { type: 'workflowCatalogResult'; requestId: string; ok: false; code: WorkflowCatalogErrorCode };

export type WorkflowCatalogDetailResult =
  | { type: 'workflowCatalogDetailResult'; requestId: string; ok: true; detail: WorkflowCatalogWireDetail }
  | { type: 'workflowCatalogDetailResult'; requestId: string; ok: false; code: WorkflowCatalogErrorCode };

/** Route-facing classification preserves safe correlation for a bounded error reply. */
export type ParsedRequestWorkflowCatalog =
  | { ok: true; requestId: string; reason: WorkflowCatalogReason }
  | { ok: false; silent: true }
  | { ok: false; silent: false; requestId: string; code: 'invalidRequest' };

const ERROR_CODES = new Set<string>(WORKFLOW_CATALOG_ERROR_CODES);
const REASONS = new Set<string>(WORKFLOW_CATALOG_REASONS);
const SCOPES = new Set<string>(['workspace', 'global']);
const PACKAGE_KINDS = new Set<string>(['bundle']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && own.every((key) => keys.includes(key));
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

const UNSAFE_DIAGNOSTIC_FILE = /[\\/\x00-\x1f\x7f]/;

function isSafeWorkflowAssetRef(value: unknown): value is string {
  if (!isBoundedString(value, 1024)) return false;
  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable) || /[\x00-\x1f\x7f]/.test(portable)) return false;
  return !portable.split('/').some((part) => part === '' || part === '.' || part === '..');
}

/** Diagnostic file labels are basenames or reserved host labels, never paths. */
export function isSafeWorkflowCatalogDiagnosticFile(value: unknown): value is string {
  return isBoundedString(value, WORKFLOW_CATALOG_DIAGNOSTIC_FILE_MAX)
    && !UNSAFE_DIAGNOSTIC_FILE.test(value);
}

/** Same bounds as isBoundedString but tolerates ''; the host currently always sends a non-empty description, and the wire deliberately tolerates '' so a future optional-description workflow cannot break the panel. */
function isBoundedOrEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0');
}

function parseList<T>(value: unknown, maximum: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const parsed: T[] = [];
  for (const item of value) {
    const next = parse(item);
    if (next === null) return null;
    parsed.push(next);
  }
  return parsed;
}

/**
 * Exact webview request parser. Unsafe/missing correlation is silent; an exact
 * type with safe correlation but a malformed reason receives invalidRequest.
 */
export function parseRequestWorkflowCatalogMessage(raw: unknown): ParsedRequestWorkflowCatalog {
  if (!isRecord(raw) || raw.type !== 'requestWorkflowCatalog') return { ok: false, silent: true };
  const { requestId, reason } = raw;
  if (!isBoundedString(requestId, WORKFLOW_CATALOG_REQUEST_ID_MAX)) return { ok: false, silent: true };
  if (!hasExactKeys(raw, ['type', 'requestId', 'reason'])) {
    return { ok: false, silent: false, requestId, code: 'invalidRequest' };
  }
  if (typeof reason !== 'string' || !REASONS.has(reason)) {
    return { ok: false, silent: false, requestId, code: 'invalidRequest' };
  }
  return { ok: true, requestId, reason: reason as WorkflowCatalogReason };
}

function parseEntry(raw: unknown): WorkflowCatalogWireEntry | null {
  if (!isRecord(raw)) return null;
  const baseKeys = ['workflowRef', 'name', 'description', 'scope', 'packageKind'];
  const countKeys = ['inputCount', 'outputCount', 'nodeCount'];
  if (!hasExactKeys(raw, baseKeys) && !hasExactKeys(raw, [...baseKeys, ...countKeys])) return null;
  const { workflowRef, name, description, scope, packageKind } = raw;
  if (!isBoundedString(workflowRef, WORKFLOW_CATALOG_REF_MAX)) return null;
  if (!isBoundedString(name, WORKFLOW_CATALOG_NAME_MAX)) return null;
  if (!isBoundedOrEmptyString(description, WORKFLOW_CATALOG_DESCRIPTION_MAX)) return null;
  if (typeof scope !== 'string' || !SCOPES.has(scope)) return null;
  if (typeof packageKind !== 'string' || !PACKAGE_KINDS.has(packageKind)) return null;
  const counts = countKeys.map((key) => raw[key]);
  if (counts.some((value, index) => value !== undefined && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > (index === 0 ? 128 : 64)))) return null;
  return {
    workflowRef, name, description,
    scope: scope as WorkflowCatalogWireScope,
    packageKind: packageKind as WorkflowCatalogWirePackageKind,
    ...(counts[0] !== undefined ? { inputCount: counts[0] as number } : {}),
    ...(counts[1] !== undefined ? { outputCount: counts[1] as number } : {}),
    ...(counts[2] !== undefined ? { nodeCount: counts[2] as number } : {}),
  };
}

/**
 * `code` is validated as a bounded identifier, not a closed union: the host
 * types PredefinedWorkflowDiagnostic.code as string, so closing the set here
 * would reject the whole snapshot whenever the host adds a diagnostic.
 */
function parseDiagnostic(raw: unknown): WorkflowCatalogWireDiagnostic | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['file', 'code', 'message'])) return null;
  const { file, code, message } = raw;
  if (!isSafeWorkflowCatalogDiagnosticFile(file)) return null;
  if (!isBoundedString(code, WORKFLOW_CATALOG_DIAGNOSTIC_CODE_MAX)) return null;
  if (!isBoundedOrEmptyString(message, WORKFLOW_CATALOG_DIAGNOSTIC_MESSAGE_MAX)) return null;
  return { file, code, message };
}

function parseCatalog(raw: unknown): WorkflowCatalogWire | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ['reason', 'workflows', 'diagnostics'])) return null;
  const { reason } = raw;
  if (typeof reason !== 'string' || !REASONS.has(reason)) return null;
  const workflows = parseList(raw.workflows, WORKFLOW_CATALOG_WORKFLOWS_MAX, parseEntry);
  if (workflows === null) return null;
  const workflowRefs = new Set(workflows.map((workflow) => workflow.workflowRef));
  if (workflowRefs.size !== workflows.length) return null;
  const diagnostics = parseList(raw.diagnostics, WORKFLOW_CATALOG_DIAGNOSTICS_MAX, parseDiagnostic);
  if (diagnostics === null) return null;
  return { reason: reason as WorkflowCatalogReason, workflows, diagnostics };
}

/** Fail-closed host→webview parser: any malformed or extra field rejects the whole result. */
export function parseWorkflowCatalogResult(raw: unknown): WorkflowCatalogResult | null {
  if (!isRecord(raw) || raw.type !== 'workflowCatalogResult') return null;
  const { requestId, ok } = raw;
  if (!isBoundedString(requestId, WORKFLOW_CATALOG_REQUEST_ID_MAX)) return null;
  if (ok === true) {
    if (!hasExactKeys(raw, ['type', 'requestId', 'ok', 'catalog'])) return null;
    const catalog = parseCatalog(raw.catalog);
    return catalog === null ? null : { type: 'workflowCatalogResult', requestId, ok: true, catalog };
  }
  if (ok === false) {
    if (!hasExactKeys(raw, ['type', 'requestId', 'ok', 'code'])) return null;
    const { code } = raw;
    if (typeof code !== 'string' || !ERROR_CODES.has(code)) return null;
    return {
      type: 'workflowCatalogResult', requestId, ok: false,
      code: code as WorkflowCatalogErrorCode,
    };
  }
  return null;
}

function parseDetail(raw: unknown): WorkflowCatalogWireDetail | null {
  if (!isRecord(raw)) return null;
  const allowedKeys = ['workflowRef', 'name', 'description', 'scope', 'packageKind', 'inputCount', 'outputCount', 'nodeCount', 'inputs', 'outputs', 'nodes', 'edges'];
  if (Object.keys(raw).some((key) => !allowedKeys.includes(key)) || !('inputs' in raw) || !('outputs' in raw) || !('nodes' in raw) || !('edges' in raw)) return null;
  const base = parseEntry({
    workflowRef: raw.workflowRef,
    name: raw.name,
    description: raw.description,
    scope: raw.scope,
    packageKind: raw.packageKind,
    ...(raw.inputCount !== undefined ? { inputCount: raw.inputCount } : {}),
    ...(raw.outputCount !== undefined ? { outputCount: raw.outputCount } : {}),
    ...(raw.nodeCount !== undefined ? { nodeCount: raw.nodeCount } : {}),
  });
  if (!base) return null;
  const inputs = parseList(raw.inputs, 128, (item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['name', 'kind', 'entryNodeId', 'inputRef']) || !isBoundedString(item.name, 128) || !isBoundedString(item.kind, 128) || !isBoundedString(item.entryNodeId, 128) || !isBoundedString(item.inputRef, 128)) return null;
    return { name: item.name, kind: item.kind, entryNodeId: item.entryNodeId, inputRef: item.inputRef };
  });
  const outputs = parseList(raw.outputs, 64, (item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['name', 'kind', 'role']) || !isBoundedString(item.name, 128) || !isBoundedString(item.kind, 128) || (item.role !== 'terminal' && item.role !== 'checkpoint')) return null;
    return { name: item.name, kind: item.kind, role: item.role as 'terminal' | 'checkpoint' };
  });
  const nodes = parseList(raw.nodes, 64, (item) => {
    if (!isRecord(item) || !isRecord(item.decision) || !hasExactKeys(item, ['nodeKey', 'kind', 'decision', ...('title' in item ? ['title'] : []), ...('assetRefs' in item ? ['assetRefs'] : [])]) || !isBoundedString(item.nodeKey, 128) || (item.kind !== 'agent' && item.kind !== 'exit' && item.kind !== 'script') || ('title' in item && !isBoundedString(item.title, 200)) || !hasExactKeys(item.decision, ['next', 'prev', 'fail']) || typeof item.decision.next !== 'boolean' || typeof item.decision.prev !== 'boolean' || typeof item.decision.fail !== 'boolean') return null;
    const assetRefs = 'assetRefs' in item ? parseList(item.assetRefs, 8, (value) => isSafeWorkflowAssetRef(value) ? value : null) : undefined;
    if ('assetRefs' in item && !assetRefs) return null;
    return { nodeKey: item.nodeKey, ...(typeof item.title === 'string' ? { title: item.title } : {}), kind: item.kind as 'agent' | 'exit' | 'script', decision: { next: item.decision.next, prev: item.decision.prev, fail: item.decision.fail }, ...(assetRefs ? { assetRefs } : {}) };
  });
  const edges = parseList(raw.edges, 128, (item) => {
    if (!isRecord(item) || !hasExactKeys(item, ['fromNodeKey', 'toNodeKey', 'inputRef']) || !isBoundedString(item.fromNodeKey, 128) || !isBoundedString(item.toNodeKey, 128) || !isBoundedString(item.inputRef, 128)) return null;
    return { fromNodeKey: item.fromNodeKey, toNodeKey: item.toNodeKey, inputRef: item.inputRef };
  });
  if (!inputs || !outputs || !nodes || !edges) return null;
  if ((base.inputCount !== undefined && base.inputCount !== inputs.length) ||
      (base.outputCount !== undefined && base.outputCount !== outputs.length) ||
      (base.nodeCount !== undefined && base.nodeCount !== nodes.length)) return null;
  return { ...base, inputs, outputs, nodes, edges };
}

export function parseRequestWorkflowCatalogDetailMessage(raw: unknown): { ok: true; requestId: string; workflowRef: string } | { ok: false; silent: true } | { ok: false; silent: false; requestId: string; code: 'invalidRequest' } {
  if (!isRecord(raw) || raw.type !== 'requestWorkflowCatalogDetail') return { ok: false, silent: true };
  const requestId = raw.requestId;
  const workflowRef = raw.workflowRef;
  if (!isBoundedString(requestId, WORKFLOW_CATALOG_REQUEST_ID_MAX) || !isBoundedString(workflowRef, WORKFLOW_CATALOG_REF_MAX)) return { ok: false, silent: true };
  if (!hasExactKeys(raw, ['type', 'requestId', 'workflowRef']) || !/^pwf_[a-f0-9]{32}$/.test(workflowRef)) return { ok: false, silent: false, requestId, code: 'invalidRequest' };
  return { ok: true, requestId, workflowRef };
}

export function parseWorkflowCatalogDetailResult(raw: unknown): WorkflowCatalogDetailResult | null {
  if (!isRecord(raw) || raw.type !== 'workflowCatalogDetailResult' || !isBoundedString(raw.requestId, WORKFLOW_CATALOG_REQUEST_ID_MAX) || typeof raw.ok !== 'boolean') return null;
  if (raw.ok === true) {
    if (!hasExactKeys(raw, ['type', 'requestId', 'ok', 'detail'])) return null;
    const detail = parseDetail(raw.detail);
    return detail ? { type: 'workflowCatalogDetailResult', requestId: raw.requestId, ok: true, detail } : null;
  }
  if (!hasExactKeys(raw, ['type', 'requestId', 'ok', 'code']) || typeof raw.code !== 'string' || !ERROR_CODES.has(raw.code)) return null;
  return { type: 'workflowCatalogDetailResult', requestId: raw.requestId, ok: false, code: raw.code as WorkflowCatalogErrorCode };
}
