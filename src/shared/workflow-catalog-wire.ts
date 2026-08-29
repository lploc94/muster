/**
 * Shared workflow catalog host↔webview contract.
 * Pure data validation only: no VS Code, repository, filesystem, or MCP imports.
 */

export const WORKFLOW_CATALOG_REQUEST_ID_MAX = 128;
export const WORKFLOW_CATALOG_REF_MAX = 512;
export const WORKFLOW_CATALOG_NAME_MAX = 512;
export const WORKFLOW_CATALOG_DESCRIPTION_MAX = 1_024;
/** Mirrors PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE. */
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
export type WorkflowCatalogWirePackageKind = 'file' | 'bundle';

export interface WorkflowCatalogWireEntry {
  workflowRef: string;
  name: string;
  description: string;
  scope: WorkflowCatalogWireScope;
  packageKind: WorkflowCatalogWirePackageKind;
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

export type WorkflowCatalogResult =
  | { type: 'workflowCatalogResult'; requestId: string; ok: true; catalog: WorkflowCatalogWire }
  | { type: 'workflowCatalogResult'; requestId: string; ok: false; code: WorkflowCatalogErrorCode };

/** Route-facing classification preserves safe correlation for a bounded error reply. */
export type ParsedRequestWorkflowCatalog =
  | { ok: true; requestId: string; reason: WorkflowCatalogReason }
  | { ok: false; silent: true }
  | { ok: false; silent: false; requestId: string; code: 'invalidRequest' };

const ERROR_CODES = new Set<string>(WORKFLOW_CATALOG_ERROR_CODES);
const REASONS = new Set<string>(WORKFLOW_CATALOG_REASONS);
const SCOPES = new Set<string>(['workspace', 'global']);
const PACKAGE_KINDS = new Set<string>(['file', 'bundle']);

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

/** Same bounds as isBoundedString but tolerates '' (description is optional upstream). */
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
  if (!hasExactKeys(raw, ['type', 'requestId', 'reason']) || typeof reason !== 'string' || !REASONS.has(reason)) {
    return { ok: false, silent: false, requestId, code: 'invalidRequest' };
  }
  return { ok: true, requestId, reason: reason as WorkflowCatalogReason };
}

/** Convenience parser for callers that only accept an exact valid request. */
export function parseRequestWorkflowCatalog(raw: unknown): Omit<RequestWorkflowCatalog, 'type'> | null {
  const parsed = parseRequestWorkflowCatalogMessage(raw);
  return parsed.ok ? { requestId: parsed.requestId, reason: parsed.reason } : null;
}

function parseEntry(raw: unknown): WorkflowCatalogWireEntry | null {
  if (!isRecord(raw)) return null;
  if (!hasExactKeys(raw, ['workflowRef', 'name', 'description', 'scope', 'packageKind'])) return null;
  const { workflowRef, name, description, scope, packageKind } = raw;
  if (!isBoundedString(workflowRef, WORKFLOW_CATALOG_REF_MAX)) return null;
  if (!isBoundedString(name, WORKFLOW_CATALOG_NAME_MAX)) return null;
  if (!isBoundedOrEmptyString(description, WORKFLOW_CATALOG_DESCRIPTION_MAX)) return null;
  if (typeof scope !== 'string' || !SCOPES.has(scope)) return null;
  if (typeof packageKind !== 'string' || !PACKAGE_KINDS.has(packageKind)) return null;
  return {
    workflowRef, name, description,
    scope: scope as WorkflowCatalogWireScope,
    packageKind: packageKind as WorkflowCatalogWirePackageKind,
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
  if (!isBoundedString(file, WORKFLOW_CATALOG_DIAGNOSTIC_FILE_MAX)) return null;
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
