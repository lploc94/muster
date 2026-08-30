# Workflow Catalog Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show discovered predefined workflows and their bounded catalog diagnostics in the Muster sidebar, refreshed only by an explicit Reload.

**Architecture:** A pull-based correlated request/result message pair, mirroring the existing `requestWorkflowGraph` / `workflowGraphResult` contract. A shared fail-closed wire module is the only type boundary; a host cache keyed by resolved workspace folder scans the catalog once; a pure route adapts the host reader to the wire shape; a Svelte 5 class store correlates responses; a panel renders list, diagnostics, and states.

**Tech Stack:** TypeScript, VS Code extension host, Svelte 5 (runes), Vitest, Playwright.

**Spec:** `docs/plans/2026-08-29-workflow-catalog-surface-design.md`

## Global Constraints

- The webview performs no filesystem, MCP, or SQLite access. All catalog data arrives over the wire.
- No absolute path may reach the webview, in any field or payload.
- Shared wire modules live in `src/shared/` and import nothing from VS Code, the repository, the filesystem, or MCP. Enforced by `npm run test:source-boundary`.
- Bounds copied verbatim from the host: `PREDEFINED_WORKFLOW_MAX_FILES_PER_SCOPE = 128`, `PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS = 32`.
- Closed value sets: `scope` is `'workspace' | 'global'`; `packageKind` is `'file' | 'bundle'`.
- `diagnostics[].code` is an open bounded string, NOT a closed union. `PredefinedWorkflowDiagnostic.code` is typed `string` in the host; closing it on the wire would make the panel reject a snapshot whenever the host adds a diagnostic code.
- `PROTOCOL_VERSION` must end at `13` in **both** `src/extension.ts` and `webview/src/lib/protocol.ts`. They are duplicated constants, not a shared import.
- No filesystem watcher, no polling, no patch-driven reload. Refresh is user-initiated only.
- Out of scope, do not implement: running/compiling a workflow, rendering Markdown bodies, editing packages, opening files in the editor.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/workflow-catalog-wire.ts` | Create. Wire types, bounds, closed taxonomies, fail-closed request and result parsers. |
| `src/shared/workflow-catalog-wire.test.ts` | Create. Parser unit tests. |
| `src/host/workflow-catalog-cache.ts` | Create. Snapshot keyed by resolved workspace folder; `initial` serves cache, `reload` rescans. |
| `src/host/workflow-catalog-cache.test.ts` | Create. Cache semantics tests. |
| `src/host/workflow-catalog-route.ts` | Create. Pure route: request in, `WorkflowCatalogResult` out. No VS Code or filesystem coupling. |
| `src/host/workflow-catalog-route.test.ts` | Create. Route tests with injected reader. |
| `src/extension.ts` | Modify. Bump `PROTOCOL_VERSION`, add `requestWorkflowCatalog` dispatch case and handler. |
| `webview/src/lib/protocol.ts` | Modify. Bump `PROTOCOL_VERSION`, register both message types. |
| `webview/src/lib/workflow-catalog-store.svelte.ts` | Create. Correlation, single-flight, timeout, retry, reload-preserves-prior. |
| `webview/src/lib/workflow-catalog-store.test.ts` | Create. Store behavior tests. |
| `webview/src/components/WorkflowCatalogPanel.svelte` | Create. Grouped list, diagnostics, five states. |
| `webview/src/App.svelte` | Modify. `workflowsOpen` flag, top-level branch, toolbar button in both toolbars. |
| `e2e/muster-webview-state.spec.ts` | Modify. One end-to-end journey. |

---

## Task 1: Shared wire contract

**Files:**
- Create: `src/shared/workflow-catalog-wire.ts`
- Test: `src/shared/workflow-catalog-wire.test.ts`

**Interfaces:**
- Consumes: nothing. This is the root of the dependency chain.
- Produces:
  - `WORKFLOW_CATALOG_WORKFLOWS_MAX = 128`, `WORKFLOW_CATALOG_DIAGNOSTICS_MAX = 32`
  - `type WorkflowCatalogWireScope = 'workspace' | 'global'`
  - `type WorkflowCatalogWirePackageKind = 'file' | 'bundle'`
  - `type WorkflowCatalogErrorCode = 'unavailable' | 'invalidRequest'`
  - `interface WorkflowCatalogWireEntry { workflowRef, name, description, scope, packageKind }`
  - `interface WorkflowCatalogWireDiagnostic { file, code, message }`
  - `interface WorkflowCatalogWire { reason, workflows, diagnostics }`
  - `interface RequestWorkflowCatalog { type: 'requestWorkflowCatalog'; requestId: string; reason: 'initial' | 'reload' }`
  - `type WorkflowCatalogResult` (ok true with `catalog`, ok false with `code`)
  - `type ParsedRequestWorkflowCatalog` (ok, or silent, or non-silent `invalidRequest`)
  - `parseRequestWorkflowCatalogMessage(raw: unknown): ParsedRequestWorkflowCatalog`
  - `parseWorkflowCatalogResult(raw: unknown): WorkflowCatalogResult | null`

**Read first:** `src/shared/workflow-graph-wire.ts`. Reuse its exact validation idioms — `isRecord`, `hasExactKeys`, `isBoundedString`, `parseList`. Do not invent a new style. Note `description` may legitimately be empty, so it needs a bounded-but-allows-empty check rather than `isBoundedString`, which rejects `''`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  parseRequestWorkflowCatalogMessage,
  parseWorkflowCatalogResult,
  WORKFLOW_CATALOG_WORKFLOWS_MAX,
} from './workflow-catalog-wire';

const entry = {
  workflowRef: 'ref-1',
  name: 'Build checks',
  description: 'Run lint and typecheck',
  scope: 'workspace',
  packageKind: 'bundle',
};

function result(overrides?: Record<string, unknown>) {
  return {
    type: 'workflowCatalogResult',
    requestId: 'req-1',
    ok: true,
    catalog: { reason: 'initial', workflows: [entry], diagnostics: [] },
    ...overrides,
  };
}

describe('parseRequestWorkflowCatalogMessage', () => {
  it('accepts an exact request', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'reload',
    })).toEqual({ ok: true, requestId: 'req-1', reason: 'reload' });
  });

  it('silently drops a request with unsafe correlation', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: '', reason: 'initial',
    })).toEqual({ ok: false, silent: true });
  });

  it('returns invalidRequest when correlation is safe but reason is not', () => {
    expect(parseRequestWorkflowCatalogMessage({
      type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'poll',
    })).toEqual({ ok: false, silent: false, requestId: 'req-1', code: 'invalidRequest' });
  });

  it('silently drops a foreign message type', () => {
    expect(parseRequestWorkflowCatalogMessage({ type: 'requestWorkflowGraph', requestId: 'r' }))
      .toEqual({ ok: false, silent: true });
  });
});

describe('parseWorkflowCatalogResult', () => {
  it('accepts a well-formed success payload', () => {
    expect(parseWorkflowCatalogResult(result())).not.toBeNull();
  });

  it('accepts an empty catalog', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'reload', workflows: [], diagnostics: [] },
    }))).not.toBeNull();
  });

  it('accepts an empty description', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, description: '' }], diagnostics: [] },
    }))).not.toBeNull();
  });

  it('accepts an unrecognised diagnostic code as bounded text', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial', workflows: [],
        diagnostics: [{ file: '(scope)', code: 'some_future_code', message: 'x' }],
      },
    }))).not.toBeNull();
  });

  it('rejects an unknown scope', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, scope: 'user' }], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects an unknown packageKind', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows: [{ ...entry, packageKind: 'zip' }], diagnostics: [] },
    }))).toBeNull();
  });

  it('rejects an extra key on an entry', () => {
    expect(parseWorkflowCatalogResult(result({
      catalog: {
        reason: 'initial',
        workflows: [{ ...entry, packagePath: '/home/u/.muster/workflows' }],
        diagnostics: [],
      },
    }))).toBeNull();
  });

  it('rejects an oversized workflows array', () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX + 1 }, (_, i) => ({
      ...entry, workflowRef: `ref-${i}`,
    }));
    expect(parseWorkflowCatalogResult(result({
      catalog: { reason: 'initial', workflows, diagnostics: [] },
    }))).toBeNull();
  });

  it('accepts a bounded error payload and rejects an unknown code', () => {
    expect(parseWorkflowCatalogResult({
      type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'unavailable',
    })).not.toBeNull();
    expect(parseWorkflowCatalogResult({
      type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'boom',
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/workflow-catalog-wire.test.ts`
Expected: FAIL — cannot resolve `./workflow-catalog-wire`.

- [ ] **Step 3: Implement the wire module**

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/workflow-catalog-wire.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Verify the shared-module boundary holds**

Run: `npm run test:source-boundary`
Expected: PASS. This guard is why the module imports nothing from VS Code or the filesystem.

- [ ] **Step 6: Commit**

```bash
git add src/shared/workflow-catalog-wire.ts src/shared/workflow-catalog-wire.test.ts
git commit -m "feat(workflow-catalog): add fail-closed host-webview wire contract"
```

---

## Task 2: Host catalog cache

**Files:**
- Create: `src/host/workflow-catalog-cache.ts`
- Test: `src/host/workflow-catalog-cache.test.ts`

**Interfaces:**
- Consumes: `WorkflowCatalogReason` from Task 1.
- Produces:
  - `interface WorkflowCatalogSnapshot { workflows: readonly PredefinedWorkflowSummary[]; diagnostics: readonly PredefinedWorkflowDiagnostic[] }`
  - `type WorkflowCatalogReader = (workspaceFolder: string) => Promise<WorkflowCatalogSnapshot>`
  - `class WorkflowCatalogCache` with `constructor(read: WorkflowCatalogReader)`, `read(workspaceFolder: string, reason: WorkflowCatalogReason): Promise<WorkflowCatalogSnapshot>`, and `dispose(): void`

**Why keyed by folder:** the host resolves `workspaceFolder` through `resolveTaskCwd()`, which calls `resolveWorkspaceCwd(folders, activeFile)`. In a multi-root workspace the folder holding the active editor wins, so the resolved catalog root can change between two requests with no user action in this panel. A session-wide cache would serve one root's catalog while the user works in another.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { WorkflowCatalogCache, type WorkflowCatalogSnapshot } from './workflow-catalog-cache';

function snapshot(name: string): WorkflowCatalogSnapshot {
  return {
    workflows: [{
      workflowRef: `ref-${name}`, name, description: '',
      scope: 'workspace', packageKind: 'file',
    }],
    diagnostics: [],
  };
}

describe('WorkflowCatalogCache', () => {
  it('scans once for initial then serves the cached snapshot', async () => {
    const read = vi.fn(async () => snapshot('one'));
    const cache = new WorkflowCatalogCache(read);

    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('one'));
    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('one'));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rescans on reload and replaces the snapshot', async () => {
    let current = snapshot('one');
    const read = vi.fn(async () => current);
    const cache = new WorkflowCatalogCache(read);

    await cache.read('/root/a', 'initial');
    current = snapshot('two');
    await expect(cache.read('/root/a', 'reload')).resolves.toEqual(snapshot('two'));
    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('two'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rescans when the resolved folder differs from the cached key', async () => {
    const read = vi.fn(async (folder: string) => snapshot(folder));
    const cache = new WorkflowCatalogCache(read);

    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('/root/a'));
    await expect(cache.read('/root/b', 'initial')).resolves.toEqual(snapshot('/root/b'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not poison the cached snapshot when a rescan fails', async () => {
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error('EACCES');
      return snapshot('one');
    });
    const cache = new WorkflowCatalogCache(read);

    await cache.read('/root/a', 'initial');
    fail = true;
    await expect(cache.read('/root/a', 'reload')).rejects.toThrow('EACCES');

    fail = false;
    await expect(cache.read('/root/a', 'initial')).resolves.toEqual(snapshot('one'));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops the snapshot on dispose', async () => {
    const read = vi.fn(async () => snapshot('one'));
    const cache = new WorkflowCatalogCache(read);

    await cache.read('/root/a', 'initial');
    cache.dispose();
    await cache.read('/root/a', 'initial');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/host/workflow-catalog-cache.test.ts`
Expected: FAIL — cannot resolve `./workflow-catalog-cache`.

- [ ] **Step 3: Implement the cache**

```ts
import type {
  PredefinedWorkflowDiagnostic,
  PredefinedWorkflowSummary,
} from './predefined-workflows';
import type { WorkflowCatalogReason } from '../shared/workflow-catalog-wire';

export interface WorkflowCatalogSnapshot {
  workflows: readonly PredefinedWorkflowSummary[];
  diagnostics: readonly PredefinedWorkflowDiagnostic[];
}

export type WorkflowCatalogReader = (workspaceFolder: string) => Promise<WorkflowCatalogSnapshot>;

/**
 * One in-memory catalog snapshot keyed by the resolved workspace catalog folder.
 *
 * The key matters because the host resolves the folder through resolveTaskCwd(),
 * which is multi-root aware: the folder holding the active editor wins, so the
 * resolved root can change between requests without any user action here.
 *
 * A failed rescan rejects without replacing the previous snapshot, so a transient
 * read error cannot discard usable data.
 */
export class WorkflowCatalogCache {
  private key: string | undefined;
  private snapshot: WorkflowCatalogSnapshot | undefined;

  constructor(private readonly load: WorkflowCatalogReader) {}

  async read(workspaceFolder: string, reason: WorkflowCatalogReason): Promise<WorkflowCatalogSnapshot> {
    if (reason === 'initial' && this.snapshot !== undefined && this.key === workspaceFolder) {
      return this.snapshot;
    }
    const next = await this.load(workspaceFolder);
    this.key = workspaceFolder;
    this.snapshot = next;
    return next;
  }

  dispose(): void {
    this.key = undefined;
    this.snapshot = undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/host/workflow-catalog-cache.test.ts`
Expected: PASS, all five cases.

- [ ] **Step 5: Commit**

```bash
git add src/host/workflow-catalog-cache.ts src/host/workflow-catalog-cache.test.ts
git commit -m "feat(workflow-catalog): cache catalog snapshot per resolved workspace folder"
```

---

## Task 3: Host route

**Files:**
- Create: `src/host/workflow-catalog-route.ts`
- Test: `src/host/workflow-catalog-route.test.ts`

**Interfaces:**
- Consumes: `parseRequestWorkflowCatalogMessage`, `WorkflowCatalogResult`, `WorkflowCatalogWire`, `WorkflowCatalogErrorCode` from Task 1; `WorkflowCatalogSnapshot` from Task 2.
- Produces:
  - `interface WorkflowCatalogRouteDeps { readCatalog(reason: WorkflowCatalogReason): Promise<WorkflowCatalogSnapshot> }`
  - `type WorkflowCatalogHostOutcome = { kind: 'silent' } | { kind: 'message'; message: WorkflowCatalogResult }`
  - `routeRequestWorkflowCatalog(data: unknown, deps: WorkflowCatalogRouteDeps): Promise<WorkflowCatalogHostOutcome>`

**Read first:** `src/host/workflow-graph-route.ts`. Mirror its shape: parse before any read, `silent` for unsafe correlation, a `failure()` helper, and a private `toWire…` projection so the route is the only host-to-webview adapter. Unlike the graph route there is no focused-task check, because the catalog is workspace-scoped.

**Note on the truncation cap:** the host already truncates at 128 entries per scope and emits a `scope_truncated` diagnostic, and the catalog merges two scopes. A merged list can therefore exceed the wire cap of 128. The route clamps to `WORKFLOW_CATALOG_WORKFLOWS_MAX` and appends a `catalog_truncated` diagnostic rather than emitting a payload its own parser would reject.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  routeRequestWorkflowCatalog,
  type WorkflowCatalogRouteDeps,
} from './workflow-catalog-route';
import {
  WORKFLOW_CATALOG_DIAGNOSTICS_MAX,
  WORKFLOW_CATALOG_WORKFLOWS_MAX,
} from '../shared/workflow-catalog-wire';

function deps(overrides?: Partial<WorkflowCatalogRouteDeps>): WorkflowCatalogRouteDeps {
  return {
    readCatalog: async () => ({
      workflows: [{
        workflowRef: 'ref-1', name: 'Build checks', description: 'Run lint',
        scope: 'workspace', packageKind: 'bundle',
      }],
      diagnostics: [],
    }),
    ...overrides,
  };
}

const request = { type: 'requestWorkflowCatalog', requestId: 'req-1', reason: 'initial' };

describe('routeRequestWorkflowCatalog', () => {
  it('silently drops correlation-unsafe requests without reading the catalog', async () => {
    const readCatalog = vi.fn(deps().readCatalog);

    await expect(routeRequestWorkflowCatalog(
      { ...request, requestId: '' }, deps({ readCatalog }),
    )).resolves.toEqual({ kind: 'silent' });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('returns invalidRequest for a malformed reason without reading the catalog', async () => {
    const readCatalog = vi.fn(deps().readCatalog);

    await expect(routeRequestWorkflowCatalog(
      { ...request, reason: 'poll' }, deps({ readCatalog }),
    )).resolves.toEqual({
      kind: 'message',
      message: { type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'invalidRequest' },
    });
    expect(readCatalog).not.toHaveBeenCalled();
  });

  it('projects the catalog snapshot onto the wire shape', async () => {
    await expect(routeRequestWorkflowCatalog(request, deps())).resolves.toEqual({
      kind: 'message',
      message: {
        type: 'workflowCatalogResult', requestId: 'req-1', ok: true,
        catalog: {
          reason: 'initial',
          workflows: [{
            workflowRef: 'ref-1', name: 'Build checks', description: 'Run lint',
            scope: 'workspace', packageKind: 'bundle',
          }],
          diagnostics: [],
        },
      },
    });
  });

  it('passes the request reason through to the reader and the payload', async () => {
    const readCatalog = vi.fn(deps().readCatalog);

    const outcome = await routeRequestWorkflowCatalog(
      { ...request, reason: 'reload' }, deps({ readCatalog }),
    );

    expect(readCatalog).toHaveBeenCalledWith('reload');
    expect(outcome).toMatchObject({ message: { catalog: { reason: 'reload' } } });
  });

  it('maps a catalog read failure to unavailable', async () => {
    await expect(routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => { throw new Error('EACCES'); },
    }))).resolves.toEqual({
      kind: 'message',
      message: { type: 'workflowCatalogResult', requestId: 'req-1', ok: false, code: 'unavailable' },
    });
  });

  it('clamps an over-cap merged list and reports the truncation', async () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX + 5 }, (_, i) => ({
      workflowRef: `ref-${i}`, name: `Workflow ${i}`, description: '',
      scope: 'workspace' as const, packageKind: 'file' as const,
    }));

    const outcome = await routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => ({ workflows, diagnostics: [] }),
    }));

    expect(outcome).toMatchObject({ kind: 'message' });
    const message = (outcome as { message: { catalog: { workflows: unknown[]; diagnostics: { code: string }[] } } }).message;
    expect(message.catalog.workflows).toHaveLength(WORKFLOW_CATALOG_WORKFLOWS_MAX);
    expect(message.catalog.diagnostics.at(-1)?.code).toBe('catalog_truncated');
  });

  it('keeps the truncation diagnostic within the cap when diagnostics are already full', async () => {
    const workflows = Array.from({ length: WORKFLOW_CATALOG_WORKFLOWS_MAX + 1 }, (_, i) => ({
      workflowRef: `ref-${i}`, name: `Workflow ${i}`, description: '',
      scope: 'workspace' as const, packageKind: 'file' as const,
    }));
    const diagnostics = Array.from({ length: WORKFLOW_CATALOG_DIAGNOSTICS_MAX }, (_, i) => ({
      file: `w${i}.md`, code: 'invalid_workflow_file', message: 'bad',
    }));

    const outcome = await routeRequestWorkflowCatalog(request, deps({
      readCatalog: async () => ({ workflows, diagnostics }),
    }));

    const message = (outcome as { message: { catalog: { diagnostics: { code: string }[] } } }).message;
    expect(message.catalog.diagnostics).toHaveLength(WORKFLOW_CATALOG_DIAGNOSTICS_MAX);
    expect(message.catalog.diagnostics.at(-1)?.code).toBe('catalog_truncated');
  });

  it('emits a payload its own parser accepts', async () => {
    const { parseWorkflowCatalogResult } = await import('../shared/workflow-catalog-wire');
    const outcome = await routeRequestWorkflowCatalog(request, deps());

    expect(outcome.kind).toBe('message');
    expect(parseWorkflowCatalogResult(
      (outcome as { message: unknown }).message,
    )).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/host/workflow-catalog-route.test.ts`
Expected: FAIL — cannot resolve `./workflow-catalog-route`.

- [ ] **Step 3: Implement the route**

```ts
import {
  parseRequestWorkflowCatalogMessage,
  WORKFLOW_CATALOG_DIAGNOSTICS_MAX,
  WORKFLOW_CATALOG_DIAGNOSTIC_MESSAGE_MAX,
  WORKFLOW_CATALOG_WORKFLOWS_MAX,
  type WorkflowCatalogErrorCode,
  type WorkflowCatalogReason,
  type WorkflowCatalogResult,
  type WorkflowCatalogWire,
  type WorkflowCatalogWireDiagnostic,
} from '../shared/workflow-catalog-wire';
import type { WorkflowCatalogSnapshot } from './workflow-catalog-cache';

export interface WorkflowCatalogRouteDeps {
  readCatalog(reason: WorkflowCatalogReason): Promise<WorkflowCatalogSnapshot>;
}

export type WorkflowCatalogHostOutcome =
  | { kind: 'silent' }
  | { kind: 'message'; message: WorkflowCatalogResult };

function failure(requestId: string, code: WorkflowCatalogErrorCode): WorkflowCatalogHostOutcome {
  return {
    kind: 'message',
    message: { type: 'workflowCatalogResult', requestId, ok: false, code },
  };
}

/**
 * Copies the host catalog snapshot into the exact shared wire shape, so the
 * route stays the only host-to-webview catalog adapter.
 *
 * The host truncates at 128 entries per scope and the catalog merges two scopes,
 * so a merged list can exceed the wire cap. Clamping plus a diagnostic keeps the
 * payload acceptable to our own fail-closed parser.
 *
 * The host also caps merged diagnostics at PREDEFINED_WORKFLOW_MAX_DIAGNOSTICS (32),
 * so the truncation diagnostic must displace the last entry rather than append a
 * 33rd one that the same parser would reject.
 */
function toWireCatalog(
  snapshot: WorkflowCatalogSnapshot,
  reason: WorkflowCatalogReason,
): WorkflowCatalogWire {
  const workflows = snapshot.workflows
    .slice(0, WORKFLOW_CATALOG_WORKFLOWS_MAX)
    .map(({ workflowRef, name, description, scope, packageKind }) => ({
      workflowRef, name, description, scope, packageKind,
    }));

  const diagnostics: WorkflowCatalogWireDiagnostic[] = snapshot.diagnostics
    .slice(0, WORKFLOW_CATALOG_DIAGNOSTICS_MAX)
    .map(({ file, code, message }) => ({
      file, code,
      message: message.slice(0, WORKFLOW_CATALOG_DIAGNOSTIC_MESSAGE_MAX),
    }));

  if (snapshot.workflows.length > WORKFLOW_CATALOG_WORKFLOWS_MAX) {
    if (diagnostics.length >= WORKFLOW_CATALOG_DIAGNOSTICS_MAX) diagnostics.pop();
    diagnostics.push({
      file: '(catalog)',
      code: 'catalog_truncated',
      message: `more than ${WORKFLOW_CATALOG_WORKFLOWS_MAX} workflows across all scopes; later entries ignored`,
    });
  }

  return { reason, workflows, diagnostics };
}

/**
 * Pull-based catalog request route. It validates before any catalog read and has
 * no focused-task check, because the catalog is workspace-scoped rather than
 * run-scoped.
 */
export async function routeRequestWorkflowCatalog(
  data: unknown,
  deps: WorkflowCatalogRouteDeps,
): Promise<WorkflowCatalogHostOutcome> {
  const parsed = parseRequestWorkflowCatalogMessage(data);
  if (!parsed.ok) {
    return parsed.silent ? { kind: 'silent' } : failure(parsed.requestId, parsed.code);
  }

  const { requestId, reason } = parsed;
  let snapshot: WorkflowCatalogSnapshot;
  try {
    snapshot = await deps.readCatalog(reason);
  } catch {
    return failure(requestId, 'unavailable');
  }

  return {
    kind: 'message',
    message: {
      type: 'workflowCatalogResult',
      requestId,
      ok: true,
      catalog: toWireCatalog(snapshot, reason),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/host/workflow-catalog-route.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add src/host/workflow-catalog-route.ts src/host/workflow-catalog-route.test.ts
git commit -m "feat(workflow-catalog): add pure catalog request route"
```

---

## Task 4: Host wiring in extension.ts

**Files:**
- Modify: `src/extension.ts` (import block near line 162; `PROTOCOL_VERSION` at line 592; new handler beside `handleRequestWorkflowGraph` at lines 2621-2682; dispatch switch at line 3758)

**Interfaces:**
- Consumes: `routeRequestWorkflowCatalog` from Task 3; `WorkflowCatalogCache` from Task 2; existing `listPredefinedWorkflows` and `resolveTaskCwd()`.
- Produces: a host that answers `requestWorkflowCatalog` with `workflowCatalogResult`, and `PROTOCOL_VERSION = 13`.

**Read first:** `handleRequestWorkflowGraph` at `src/extension.ts:2621-2682`. Mirror its structure — `debugMuster` before the route, route call, `debugMuster` on the outcome, `this.post` only when `outcome.kind === 'message'`. The catalog handler is simpler: no repository, no focus checks.

- [ ] **Step 1: Add the imports**

Beside the existing route import at line 162:

```ts
import { routeRequestWorkflowCatalog } from './host/workflow-catalog-route';
import { WorkflowCatalogCache } from './host/workflow-catalog-cache';
import { listPredefinedWorkflows } from './host/predefined-workflows';
```

`listPredefinedWorkflows` may already be imported for the coordinator tools. Check before adding a duplicate import.

- [ ] **Step 2: Bump the host protocol version**

At `src/extension.ts:592`, change `12` to `13`:

```ts
const PROTOCOL_VERSION = 13;
```

- [ ] **Step 3: Add the cache field to the provider class**

Beside the other private fields on the same class that owns `handleRequestWorkflowGraph`:

```ts
  /**
   * Catalog snapshot cache. Keyed by resolved workspace folder inside the cache,
   * because resolveTaskCwd() is multi-root aware and can return a different
   * folder between requests.
   */
  private readonly workflowCatalogCache = new WorkflowCatalogCache(
    async (workspaceFolder: string) => {
      const { workflows, diagnostics } = await listPredefinedWorkflows({ workspaceFolder });
      return { workflows, diagnostics };
    },
  );
```

Note `globalWorkflowFolder` is deliberately omitted so production resolves the global root from `homedir()`.

- [ ] **Step 4: Add the handler after handleRequestWorkflowGraph**

```ts
  /**
   * Serve the bounded predefined workflow catalog. The pure route validates
   * before any catalog read and emits only its shared, fixed response shape.
   * Unlike the graph route there is no focus check: the catalog is
   * workspace-scoped, so it is served from the entry list too.
   */
  private async handleRequestWorkflowCatalog(data: unknown): Promise<void> {
    const raw = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    debugMuster('workflow_catalog.host_request', {
      requestId: raw.requestId,
      reason: raw.reason,
      keys: Object.keys(raw),
    });
    const outcome = await routeRequestWorkflowCatalog(data, {
      readCatalog: (reason) => this.workflowCatalogCache.read(resolveTaskCwd(), reason),
    });
    debugMuster('workflow_catalog.host_outcome', {
      requestId: raw.requestId,
      kind: outcome.kind,
      ...(outcome.kind === 'message'
        ? {
            ok: outcome.message.ok,
            code: outcome.message.ok ? undefined : outcome.message.code,
            workflowCount: outcome.message.ok ? outcome.message.catalog.workflows.length : undefined,
            diagnosticCount: outcome.message.ok ? outcome.message.catalog.diagnostics.length : undefined,
          }
        : {}),
    });
    if (outcome.kind === 'message') this.post(outcome.message);
  }
```

- [ ] **Step 5: Add the dispatch case**

Beside `case 'requestWorkflowGraph':` at line 3758:

```ts
        case 'requestWorkflowCatalog':
          await this.handleRequestWorkflowCatalog(data);
          break;
```

- [ ] **Step 6: Dispose the cache where the provider tears down**

Find the existing dispose path on the same class (where other disposables are released) and add:

```ts
    this.workflowCatalogCache.dispose();
```

- [ ] **Step 7: Verify the host compiles**

Run: `npx tsc -p .`
Expected: PASS, no errors. If `resolveTaskCwd` is not in scope for the class, it is a module-level function at `src/extension.ts:3947` — call it directly, do not re-implement folder resolution.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "feat(workflow-catalog): serve catalog requests from the extension host"
```

---

## Task 5: Webview protocol registration

**Files:**
- Modify: `webview/src/lib/protocol.ts` (import block near line 32; `PROTOCOL_VERSION` at line 34; `ExtMessage` union near line 592; `OutMessage` union near line 668; validator switch near line 1798)

**Interfaces:**
- Consumes: `parseWorkflowCatalogResult`, `RequestWorkflowCatalog`, `WorkflowCatalogResult` from Task 1.
- Produces: `PROTOCOL_VERSION = 13`; both message types accepted by the webview validator.

**Read first:** how `workflowGraphResult` is registered — imported at line 29-32, added to `ExtMessage` at line 592, `RequestWorkflowGraph` added to `OutMessage` at line 668, and validated at line 1798-1799. Follow exactly the same four touch points.

- [ ] **Step 1: Add the import**

Beside the existing graph-wire import:

```ts
import {
  parseWorkflowCatalogResult,
  type RequestWorkflowCatalog,
  type WorkflowCatalogResult,
} from '../../../src/shared/workflow-catalog-wire';
```

- [ ] **Step 2: Bump the webview protocol version**

At `webview/src/lib/protocol.ts:34`, change `12` to `13`. It must match the host value from Task 4; these are duplicated constants, not a shared import.

```ts
export const PROTOCOL_VERSION = 13;
```

- [ ] **Step 3: Add to the ExtMessage union**

Beside `| WorkflowGraphResult` at line 592:

```ts
  /** Correlated bounded predefined workflow catalog snapshot. */
  | WorkflowCatalogResult
```

- [ ] **Step 4: Add to the OutMessage union**

Beside `| RequestWorkflowGraph` at line 668:

```ts
  /** Correlated bounded workflow catalog request; reason distinguishes first open from Reload. */
  | RequestWorkflowCatalog
```

- [ ] **Step 5: Add the validator case**

Beside `case 'workflowGraphResult':` at line 1798:

```ts
    case 'workflowCatalogResult':
      return parseWorkflowCatalogResult(data) !== null;
```

- [ ] **Step 6: Verify the webview typechecks**

Run: `npm run check:svelte`
Expected: PASS, no new errors.

- [ ] **Step 7: Commit**

```bash
git add webview/src/lib/protocol.ts
git commit -m "feat(workflow-catalog): register catalog messages and bump protocol to 13"
```

---

## Task 6: Webview store

**Files:**
- Create: `webview/src/lib/workflow-catalog-request-policy.ts`
- Create: `webview/src/lib/workflow-catalog-store.svelte.ts`
- Test: `webview/src/lib/workflow-catalog-request-policy.test.ts`

**Interfaces:**
- Consumes: `WorkflowCatalogWire` from Task 1; `post` from `./protocol`.
- Produces:
  - `webview/src/lib/workflow-catalog-request-policy.ts`: `type WorkflowCatalogFetch = { requestId: string; reason: 'initial' | 'reload' } | null` and `class WorkflowCatalogRequestPolicy` with `onOpen()`, `onReload()`, `onResult(requestId, ok)`, `onTimeout(requestId)`, `settle()`, `reset()`
  - `webview/src/lib/workflow-catalog-store.svelte.ts`: `WORKFLOW_CATALOG_TIMEOUT_MS = 8_000` (matches the graph store), `class WorkflowCatalogStore` with reactive `catalog`, `loading`, `error` and methods `open()`, `reload()`, `retry()`, `handleResult(msg)`, `close()`, `dispose()`, plus `export const workflowCatalogStore = new WorkflowCatalogStore()`

**Why the split:** runes are not compiled in this repo's Vitest setup — `vitest.config.ts` sets `environment: 'node'` with no Svelte plugin, so `$state` does not work in tests. That is exactly why `webview/src/lib/workflow-graph-store.test.ts` tests the extracted `WorkflowGraphRefreshPolicy` rather than the runes store. So correlation, single-flight, and timeout ownership live in a plain policy class that is unit-tested, and the `.svelte.ts` store holds only reactive fields and delegates. Do not add a Svelte plugin to the shared Vitest config for this task.

**Read first:** `webview/src/lib/workflow-graph-refresh-policy.ts` for the policy shape, and `webview/src/lib/workflow-graph-store.svelte.ts` for the `$state` + injected `doPost` idiom. Do NOT copy the throttle — there is no patch-driven refresh here.

Behavior required by the spec:
- `open()` requests `reason: 'initial'` only when no snapshot is held; a held snapshot renders with no request.
- `reload()` requests `reason: 'reload'` and keeps the previous list visible while in flight.
- A failed reload preserves the prior snapshot and still surfaces the error.
- Single-flight: a second call while a request is in flight is ignored.
- Responses whose `requestId` is not the in-flight id are dropped.

- [ ] **Step 1: Write the failing policy tests**

Create `webview/src/lib/workflow-catalog-request-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WorkflowCatalogRequestPolicy } from './workflow-catalog-request-policy';

describe('WorkflowCatalogRequestPolicy', () => {
  it('requests initial on first open', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    expect(policy.onOpen()).toMatchObject({ reason: 'initial' });
  });

  it('is single-flight: no second request while one is in flight', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    expect(policy.onOpen()).not.toBeNull();
    expect(policy.onOpen()).toBeNull();
    expect(policy.onReload()).toBeNull();
  });

  it('serves a held snapshot on reopen without a request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId, true)).toBe(true);
    expect(policy.onOpen()).toBeNull();
  });

  it('reloads with reason reload once a snapshot is held', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId, true);

    const second = policy.onReload()!;
    expect(second.reason).toBe('reload');
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('drops a result whose requestId is not in flight', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;

    expect(policy.onResult('some-other-id', true)).toBe(false);
    expect(policy.onResult(first.requestId, true)).toBe(true);
    // Already settled: a duplicate reply is dropped too.
    expect(policy.onResult(first.requestId, true)).toBe(false);
  });

  it('a failed result settles without holding a snapshot, so retry refetches', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    expect(policy.onResult(first.requestId, false)).toBe(true);

    const retry = policy.onReload()!;
    expect(retry.reason).toBe('reload');
  });

  it('a failed reload keeps the held snapshot so open does not refetch', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId, true);
    const reload = policy.onReload()!;
    policy.onResult(reload.requestId, false);

    expect(policy.onOpen()).toBeNull();
  });

  it('times out only the in-flight request', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;

    expect(policy.onTimeout('stale-id')).toBe(false);
    expect(policy.onTimeout(first.requestId)).toBe(true);
    expect(policy.onReload()).not.toBeNull();
  });

  it('reset clears both the in-flight request and the held snapshot', () => {
    const policy = new WorkflowCatalogRequestPolicy();
    const first = policy.onOpen()!;
    policy.onResult(first.requestId, true);
    policy.reset();

    expect(policy.onOpen()).toMatchObject({ reason: 'initial' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run webview/src/lib/workflow-catalog-request-policy.test.ts`
Expected: FAIL — cannot resolve `./workflow-catalog-request-policy`.

- [ ] **Step 3: Implement the policy**

Create `webview/src/lib/workflow-catalog-request-policy.ts`:

```ts
export type WorkflowCatalogFetch = { requestId: string; reason: 'initial' | 'reload' } | null;

/**
 * Pure request-correlation policy for the catalog store: monotonic request ids,
 * single-flight, and the held-snapshot rule that makes reopening free.
 *
 * Extracted from the runes store because vitest.config.ts runs the node
 * environment with no Svelte plugin, so $state is not compiled in tests.
 */
export class WorkflowCatalogRequestPolicy {
  private seq = 0;
  private inFlight: string | null = null;
  private held = false;

  /** null means no request: a snapshot is already held, or one is in flight. */
  onOpen(): WorkflowCatalogFetch {
    if (this.held || this.inFlight !== null) return null;
    return this.begin('initial');
  }

  onReload(): WorkflowCatalogFetch {
    if (this.inFlight !== null) return null;
    return this.begin('reload');
  }

  /** True when the reply is the in-flight request and the caller should apply it. */
  onResult(requestId: string, ok: boolean): boolean {
    if (this.inFlight === null || requestId !== this.inFlight) return false;
    this.inFlight = null;
    // A failed reload leaves `held` as it was, so the prior snapshot survives.
    if (ok) this.held = true;
    return true;
  }

  onTimeout(requestId: string): boolean {
    if (this.inFlight !== requestId) return false;
    this.inFlight = null;
    return true;
  }

  settle(): void {
    this.inFlight = null;
  }

  reset(): void {
    this.inFlight = null;
    this.held = false;
  }

  private begin(reason: 'initial' | 'reload'): WorkflowCatalogFetch {
    const requestId = `catalog-${++this.seq}`;
    this.inFlight = requestId;
    return { requestId, reason };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run webview/src/lib/workflow-catalog-request-policy.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 5: Implement the reactive store**

Create `webview/src/lib/workflow-catalog-store.svelte.ts`. It holds only reactive state and delegates every correlation decision to the policy, so there is no duplicated single-flight logic to drift:

```ts
import type { WorkflowCatalogWire } from '../../../src/shared/workflow-catalog-wire';
import { post as defaultPost } from './protocol';
import { WorkflowCatalogRequestPolicy } from './workflow-catalog-request-policy';

/** Matches the 8s timeout in workflow-graph-store.svelte.ts:220. */
export const WORKFLOW_CATALOG_TIMEOUT_MS = 8_000;

interface WorkflowCatalogResultMessage {
  requestId: string;
  ok: boolean;
  catalog?: WorkflowCatalogWire;
  code?: string;
}

/**
 * Svelte 5 class store for the workspace-scoped workflow catalog.
 *
 * Deliberately simpler than WorkflowGraphStore: the catalog has no patch-driven
 * refresh, so there is no throttle. Reads happen on first open and on explicit
 * Reload only. Correlation lives in WorkflowCatalogRequestPolicy.
 */
export class WorkflowCatalogStore {
  catalog = $state<WorkflowCatalogWire | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  private policy = new WorkflowCatalogRequestPolicy();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private doPost: typeof defaultPost = defaultPost) {}

  open(): void {
    this.dispatch(this.policy.onOpen());
  }

  reload(): void {
    this.dispatch(this.policy.onReload());
  }

  retry(): void {
    const fetch = this.policy.onReload();
    if (fetch === null) return;
    this.error = null;
    this.dispatch(fetch);
  }

  handleResult(msg: WorkflowCatalogResultMessage): void {
    if (!this.policy.onResult(msg.requestId, msg.ok)) return;
    this.loading = false;
    this.clearTimer();
    if (msg.ok && msg.catalog) {
      this.catalog = msg.catalog;
      this.error = null;
      return;
    }
    // Keep the prior snapshot: an error must not discard usable data.
    this.error = msg.code ?? 'unavailable';
  }

  /** Panel closed. The snapshot is retained so reopening does not refetch. */
  close(): void {
    this.policy.settle();
    this.loading = false;
    this.clearTimer();
  }

  dispose(): void {
    this.policy.reset();
    this.loading = false;
    this.clearTimer();
    this.catalog = null;
    this.error = null;
  }

  private dispatch(fetch: ReturnType<WorkflowCatalogRequestPolicy['onOpen']>): void {
    if (fetch === null) return;
    this.loading = true;
    this.clearTimer();
    this.timeoutId = setTimeout(() => {
      if (!this.policy.onTimeout(fetch.requestId)) return;
      this.loading = false;
      this.error = 'unavailable';
    }, WORKFLOW_CATALOG_TIMEOUT_MS);
    this.doPost({ type: 'requestWorkflowCatalog', ...fetch } as never);
  }

  private clearTimer(): void {
    if (this.timeoutId === null) return;
    clearTimeout(this.timeoutId);
    this.timeoutId = null;
  }
}

export const workflowCatalogStore = new WorkflowCatalogStore();
```

The reactive transitions this store adds on top of the policy — `loading` during a reload, `catalog` surviving a failed reload, and the visible error plus Retry — are verified end to end in Task 8, since they cannot be exercised under the node-environment Vitest.

- [ ] **Step 6: Verify it typechecks**

Run: `npm run check:svelte`
Expected: PASS, no new errors.

- [ ] **Step 7: Commit**

```bash
git add webview/src/lib/workflow-catalog-request-policy.ts webview/src/lib/workflow-catalog-request-policy.test.ts webview/src/lib/workflow-catalog-store.svelte.ts
git commit -m "feat(workflow-catalog): add correlated single-flight catalog store"
```

---

## Task 7: Catalog panel component

**Files:**
- Create: `webview/src/components/WorkflowCatalogPanel.svelte`

**Interfaces:**
- Consumes: `WorkflowCatalogWire` from Task 1.
- Produces: a component with props `{ catalog: WorkflowCatalogWire | null; loading: boolean; error: string | null; onClose: () => void; onReload: () => void; onRetry: () => void }`.

**Read first:** `webview/src/components/WorkflowGraphModal.svelte:1-20` for the `$props()` + `$derived` idiom and the Escape/focus handling convention.

Rendering rules from the spec:
- Group by scope, workspace first. Heading text is "Workspace" and "User"; the wire value stays `'global'`.
- Within a group, preserve incoming order. The host already sorts by name bytes, then scope, then entry file. Do NOT re-sort.
- Each row shows `name`, `packageKind`, `description`. `workflowRef` is the keyed value only, never displayed.
- Diagnostics show `file` and `code` as primary text, `message` as supporting detail.
- Diagnostics whose `file` is `(scope)` or `(catalog)` are scope-level notices, not file rows.
- Five states: loading, populated, empty, diagnostics-only, error.
- Reload keeps the previous list visible while in flight.

- [ ] **Step 1: Write the component**

```svelte
<script lang="ts">
  import { onMount } from 'svelte';
  import type { WorkflowCatalogWire } from '../../../src/shared/workflow-catalog-wire';

  interface Props {
    catalog: WorkflowCatalogWire | null;
    loading: boolean;
    error: string | null;
    onClose: () => void;
    onReload: () => void;
    onRetry: () => void;
  }
  let { catalog, loading, error, onClose, onReload, onRetry }: Props = $props();

  // Host order is already deterministic (name bytes, scope, entry file); filtering
  // partitions it by scope without re-sorting.
  const workspaceEntries = $derived(catalog?.workflows.filter((w) => w.scope === 'workspace') ?? []);
  const globalEntries = $derived(catalog?.workflows.filter((w) => w.scope === 'global') ?? []);
  const diagnostics = $derived(catalog?.diagnostics ?? []);
  const isEmpty = $derived(
    catalog !== null && catalog.workflows.length === 0 && diagnostics.length === 0,
  );
  const isDiagnosticsOnly = $derived(
    catalog !== null && catalog.workflows.length === 0 && diagnostics.length > 0,
  );
  /** '(scope)' and '(catalog)' are reserved host labels, not basenames. */
  function isScopeNotice(file: string): boolean {
    return file === '(scope)' || file === '(catalog)';
  }

  let panelEl: HTMLDivElement | undefined = $state();
  onMount(() => {
    panelEl?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
</script>

<div
  class="workflow-catalog"
  data-testid="workflow-catalog-panel"
  bind:this={panelEl}
  tabindex="-1"
  role="region"
  aria-label="Workflows"
>
  <header class="workflow-catalog__header">
    <h2 class="workflow-catalog__title">Workflows</h2>
    <div class="workflow-catalog__actions">
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-catalog-reload"
        onclick={onReload}
        disabled={loading}
        aria-label="Reload workflows"
      >
        <span class="codicon codicon-refresh"></span>
      </button>
      <button
        type="button"
        class="icon-btn"
        data-testid="workflow-catalog-close"
        onclick={onClose}
        aria-label="Close workflows"
      >
        <span class="codicon codicon-close"></span>
      </button>
    </div>
  </header>

  {#if loading && catalog === null}
    <p class="workflow-catalog__status" data-testid="workflow-catalog-loading" role="status">
      Reading workflow catalog…
    </p>
  {/if}

  {#if error}
    <div class="workflow-catalog__error" data-testid="workflow-catalog-error" role="alert">
      <p>Could not read the workflow catalog.</p>
      <button type="button" data-testid="workflow-catalog-retry" onclick={onRetry}>Retry</button>
    </div>
  {/if}

  {#if catalog}
    {#if loading}
      <p class="workflow-catalog__status" data-testid="workflow-catalog-refreshing" role="status">
        Refreshing…
      </p>
    {/if}

    {#if workspaceEntries.length > 0}
      <section data-testid="workflow-catalog-group-workspace">
        <h3 class="workflow-catalog__group">Workspace</h3>
        <ul class="workflow-catalog__list">
          {#each workspaceEntries as entry (entry.workflowRef)}
            <li class="workflow-catalog__row" data-testid="workflow-catalog-row">
              <span class="workflow-catalog__name">{entry.name}</span>
              <span class="workflow-catalog__kind" data-testid="workflow-catalog-kind">{entry.packageKind}</span>
              {#if entry.description}
                <span class="workflow-catalog__description">{entry.description}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if globalEntries.length > 0}
      <section data-testid="workflow-catalog-group-global">
        <h3 class="workflow-catalog__group">User</h3>
        <ul class="workflow-catalog__list">
          {#each globalEntries as entry (entry.workflowRef)}
            <li class="workflow-catalog__row" data-testid="workflow-catalog-row">
              <span class="workflow-catalog__name">{entry.name}</span>
              <span class="workflow-catalog__kind" data-testid="workflow-catalog-kind">{entry.packageKind}</span>
              {#if entry.description}
                <span class="workflow-catalog__description">{entry.description}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if isEmpty || isDiagnosticsOnly}
      <p class="workflow-catalog__empty" data-testid="workflow-catalog-empty">
        No workflows found. Add a Markdown file or a package directory under
        <code>.muster/workflows/</code> in this workspace, or in your home directory
        for all workspaces.
      </p>
    {/if}

    {#if diagnostics.length > 0}
      <section data-testid="workflow-catalog-diagnostics">
        <h3 class="workflow-catalog__group">Diagnostics ({diagnostics.length})</h3>
        <ul class="workflow-catalog__list">
          {#each diagnostics as diagnostic, index (`${diagnostic.file}:${diagnostic.code}:${index}`)}
            <li class="workflow-catalog__row" data-testid="workflow-catalog-diagnostic">
              {#if !isScopeNotice(diagnostic.file)}
                <span class="workflow-catalog__name">{diagnostic.file}</span>
              {/if}
              <span class="workflow-catalog__code">{diagnostic.code}</span>
              {#if diagnostic.message}
                <span class="workflow-catalog__description">{diagnostic.message}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

<style>
  .workflow-catalog {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .workflow-catalog__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .workflow-catalog__title { font-size: 13px; font-weight: 600; margin: 0; }
  .workflow-catalog__actions { display: flex; gap: 4px; }
  .workflow-catalog__group {
    font-size: 11px;
    text-transform: uppercase;
    opacity: 0.75;
    margin: 8px 0 4px;
  }
  .workflow-catalog__list { list-style: none; margin: 0; padding: 0; }
  .workflow-catalog__row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 0;
  }
  .workflow-catalog__name { font-weight: 500; }
  .workflow-catalog__kind,
  .workflow-catalog__code {
    font-size: 11px;
    opacity: 0.75;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 0 4px;
  }
  .workflow-catalog__description { opacity: 0.75; min-width: 0; }
  .workflow-catalog__status,
  .workflow-catalog__empty { opacity: 0.75; margin: 4px 0; }
  .workflow-catalog__error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
</style>
```

- [ ] **Step 2: Verify the component typechecks**

Run: `npm run check:svelte`
Expected: PASS, no new errors.

- [ ] **Step 3: Commit**

```bash
git add webview/src/components/WorkflowCatalogPanel.svelte
git commit -m "feat(workflow-catalog): add catalog panel with grouped list and diagnostics"
```

---

## Task 8: App wiring and end-to-end journey

**Files:**
- Modify: `webview/src/App.svelte` (imports near line 72; state near line 203; `openSettings` at line 382-385; `backToList` at line 455-456; message switch near line 861; both toolbars near lines 1348 and 1413; top-level branch near line 1261)
- Modify: `e2e/muster-webview-state.spec.ts`

**Interfaces:**
- Consumes: `WorkflowCatalogStore` from Task 6, `WorkflowCatalogPanel` from Task 7.
- Produces: a reachable panel and a passing end-to-end journey.

**Critical placement note:** do NOT copy the `workflowGraphOpen` wiring. `WorkflowGraphModal` renders inside the `{#if !inChat}{:else}` chat branch and its button early-returns unless `tasks.focusedTaskId` is set. The catalog is workspace-scoped, so `workflowsOpen` must be a top-level branch beside `settingsOpen` (line 1261), reachable from the entry list and from a task. App.svelte has two toolbars — the entry header near line 1348 and the chat header near line 1413 — so the button goes in both.

- [ ] **Step 1: Add imports and store**

Beside the existing graph store import at line 71-72:

```ts
  import { WorkflowCatalogStore } from './lib/workflow-catalog-store.svelte';
  import WorkflowCatalogPanel from './components/WorkflowCatalogPanel.svelte';
```

Beside the graph store construction at line 109:

```ts
  const workflowCatalogStore = new WorkflowCatalogStore(post);
  let workflowCatalog = $derived(workflowCatalogStore.catalog);
  let workflowCatalogLoading = $derived(workflowCatalogStore.loading);
  let workflowCatalogError = $derived(workflowCatalogStore.error);
```

- [ ] **Step 2: Add the mode flag and open/close helpers**

Beside `let workflowGraphOpen = $state(false);` at line 203:

```ts
  let workflowsOpen = $state(false);
```

Beside `closeSettings` near line 447:

```ts
  function openWorkflows() {
    historyOpen = false;
    workflowGraphOpen = false;
    settingsOpen = false;
    workflowsOpen = true;
    workflowCatalogStore.open();
  }

  function closeWorkflows() {
    workflowsOpen = false;
    workflowCatalogStore.close();
  }
```

- [ ] **Step 3: Make Settings and the entry list clear the mode**

In `openSettings` (line 382-385) add `workflowsOpen = false;` beside the existing `workflowGraphOpen = false;`.
In `backToList` (line 455-456) add `workflowsOpen = false;` beside the existing `workflowGraphOpen = false;`.

- [ ] **Step 4: Route the host result**

Beside the `workflowGraphResult` case near line 861:

```ts
        case 'workflowCatalogResult': {
          workflowCatalogStore.handleResult(msg as never);
          break;
        }
```

- [ ] **Step 5: Add the toolbar button to BOTH toolbars**

In the entry header toolbar (near line 1348, beside the Settings button) and in the chat header toolbar (near line 1413, beside the workflow graph button), add:

```svelte
      <button
        type="button"
        class="icon-btn"
        onclick={openWorkflows}
        aria-label="Workflows"
        aria-pressed={workflowsOpen}
        data-testid="open-workflows"
        use:tip={'Workflows'}
      >
        <span class="codicon codicon-list-tree"></span>
      </button>
```

- [ ] **Step 6: Add the top-level branch**

The current shape is `{#if settingsOpen} … {:else} … {/if}`. Insert the catalog as a sibling branch so it replaces the body from either entry point:

```svelte
{#if settingsOpen}
  <SettingsPanel … />
{:else if workflowsOpen}
  <WorkflowCatalogPanel
    catalog={workflowCatalog}
    loading={workflowCatalogLoading}
    error={workflowCatalogError}
    onClose={closeWorkflows}
    onReload={() => workflowCatalogStore.reload()}
    onRetry={() => workflowCatalogStore.retry()}
  />
{:else}
  …
{/if}
```

Keep the existing `SettingsPanel` prop list untouched; only the `{:else if}` branch is new.

- [ ] **Step 7: Verify the webview builds**

Run: `npm run check:svelte && npm run compile`
Expected: PASS both.

- [ ] **Step 8: Write the end-to-end journey**

Append to `e2e/muster-webview-state.spec.ts`. Follow the existing conventions in that file: `openWebview(page)`, `postSnapshot(page, …)`, `postedMessages(page)`, and `page.getByTestId(...)`. Read the `view-workflow-graph` journey near line 11272 first and mirror how it asserts on posted messages and injects host replies.

```ts
test.describe('Workflow catalog surface', () => {
  const entry = {
    workflowRef: 'ref-build', name: 'Build checks', description: 'Run lint and typecheck',
    scope: 'workspace', packageKind: 'bundle',
  };
  const globalEntry = {
    workflowRef: 'ref-release', name: 'Release notes', description: 'Draft release notes',
    scope: 'global', packageKind: 'file',
  };

  /** Wait until `count` catalog requests have been posted, then return the newest. */
  async function lastCatalogRequest(page: Page, count: number) {
    await expect.poll(async () => (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowCatalog',
    ).length).toBe(count);
    return (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowCatalog',
    ).at(-1) as { requestId: string; reason: string };
  }

  test('lists workflows by scope, groups diagnostics, and refetches only on Reload', async ({ page }) => {
    await openWebview(page);

    // Opening the panel emits exactly one initial request.
    await page.getByTestId('open-workflows').first().click();
    const first = await lastCatalogRequest(page, 1);
    expect(first.reason).toBe('initial');

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult', requestId: first.requestId, ok: true,
      catalog: {
        reason: 'initial',
        workflows: [entry, globalEntry],
        diagnostics: [{ file: 'messy.md', code: 'invalid_workflow_file', message: 'missing name' }],
      },
    });

    // Only workflow rows carry this testid; diagnostics use their own.
    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(2);
    await expect(page.getByTestId('workflow-catalog-group-workspace')).toContainText('Build checks');
    await expect(page.getByTestId('workflow-catalog-group-workspace')).toContainText('bundle');
    await expect(page.getByTestId('workflow-catalog-group-global')).toContainText('Release notes');
    await expect(page.getByTestId('workflow-catalog-group-global')).toContainText('User');
    await expect(page.getByTestId('workflow-catalog-diagnostic')).toContainText('invalid_workflow_file');

    // Closing and reopening serves the held snapshot: no second request.
    await page.getByTestId('workflow-catalog-close').click();
    await page.getByTestId('open-workflows').first().click();
    await expect.poll(async () => (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowCatalog',
    ).length).toBe(1);

    // Reload refetches with reason 'reload' and picks up a newly added package.
    await page.getByTestId('workflow-catalog-reload').click();
    const second = await lastCatalogRequest(page, 2);
    expect(second.reason).toBe('reload');

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult', requestId: second.requestId, ok: true,
      catalog: {
        reason: 'reload',
        workflows: [entry, globalEntry, {
          workflowRef: 'ref-new', name: 'Added later', description: '',
          scope: 'workspace', packageKind: 'file',
        }],
        diagnostics: [],
      },
    });

    await expect(page.getByTestId('workflow-catalog-row')).toHaveCount(3);
    await expect(page.getByTestId('workflow-catalog-group-workspace')).toContainText('Added later');
    await expect(page.getByTestId('workflow-catalog-diagnostic')).toHaveCount(0);
  });

  test('renders guidance for an empty catalog and a retryable error', async ({ page }) => {
    await openWebview(page);
    await page.getByTestId('open-workflows').first().click();

    const first = await lastCatalogRequest(page, 1);

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult', requestId: first.requestId, ok: true,
      catalog: { reason: 'initial', workflows: [], diagnostics: [] },
    });
    await expect(page.getByTestId('workflow-catalog-empty')).toContainText('.muster/workflows/');

    await page.getByTestId('workflow-catalog-reload').click();
    const second = (await postedMessages(page)).filter(
      (message) => (message as { type?: string }).type === 'requestWorkflowCatalog',
    ).at(-1) as { requestId: string };

    await postRawHostMessage(page, {
      type: 'workflowCatalogResult', requestId: second.requestId, ok: false, code: 'unavailable',
    });
    await expect(page.getByTestId('workflow-catalog-error')).toBeVisible();
    await expect(page.getByTestId('workflow-catalog-retry')).toBeVisible();
  });
});
```

`postRawHostMessage` (defined at `e2e/muster-webview-state.spec.ts:398`) is the helper that injects a host message; `postedMessages` (line 404) reads recorded outbound messages, and `openWebview` (line 135) boots the harness. All three already exist — do not add a new harness helper.

- [ ] **Step 9: Run the journey**

Run: `npx playwright test e2e/muster-webview-state.spec.ts --grep "Workflow catalog surface"`
Expected: PASS both tests.

- [ ] **Step 10: Run the full gate**

Run: `npm test && npm run compile && npm run check:svelte && npm run test:source-boundary`
Expected: PASS. This is the one place project-wide suites run; earlier tasks deliberately ran only their own tests.

- [ ] **Step 11: Commit**

```bash
git add webview/src/App.svelte e2e/muster-webview-state.spec.ts
git commit -m "feat(workflow-catalog): reach the catalog panel from entry list and chat"
```

---

## Acceptance criteria

From the spec, verified by the tasks above:

- [ ] A flat Markdown workflow in `<workspace>/.muster/workflows/` appears with `scope: workspace`, `packageKind: file`.
- [ ] A directory bundle appears with `packageKind: bundle`.
- [ ] A workflow in `~/.muster/workflows/` appears under the User heading.
- [ ] A workspace workflow shadows a same-named global workflow (host behavior, already covered by `src/host/predefined-workflows.test.ts`).
- [ ] The legacy singular `workflow` root is read when the canonical root is absent (host behavior, already covered).
- [ ] An invalid or ambiguous package produces a visible bounded diagnostic.
- [ ] No absolute path appears in any rendered field or wire payload.
- [ ] A package added during the session appears only after Reload.
- [ ] Reopening the panel does not rescan the filesystem.
- [ ] An empty or missing catalog root renders guidance, not an error.
- [ ] A host read failure renders a retryable error.
- [ ] `PROTOCOL_VERSION` is 13 in both `src/extension.ts` and `webview/src/lib/protocol.ts`.
