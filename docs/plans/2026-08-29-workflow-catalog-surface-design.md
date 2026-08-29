# Workflow Catalog Surface — Design

**Status:** Approved design, pending implementation plan

**Scope:** Load and display predefined workflows from the workspace and user
catalogs in the Muster sidebar. Running a workflow is explicitly out of scope.

## 1. Problem

`.muster/workflows/` packages are only reachable through coordinator MCP tools
(`list_predefined_workflows`, `get_predefined_workflow`). A user who authors a
workflow has no way to confirm the host discovered it, resolved its scope, or
rejected it with a diagnostic. The existing workflow UI is the run-scoped graph
modal, which requires a live workflow run and shows topology, not the catalog.

## 2. Goals

- Show every discovered predefined workflow with its name, description, scope,
  and package kind.
- Show bounded catalog diagnostics so an invalid or ambiguous package is visible
  rather than silently missing.
- Read the catalog once per session and refresh only on an explicit user action.
- Keep the existing trust boundary: the webview performs no filesystem, MCP, or
  SQLite access.

## 3. Non-goals

- Running, compiling, or starting a workflow.
- Reading or rendering workflow Markdown bodies.
- Creating, editing, deleting, or moving packages and scripts.
- Opening package files in the editor. The catalog deliberately does not expose
  host paths, and this surface does not weaken that.
- Automatic refresh: no filesystem watcher, no polling, no patch-driven reload.

## 4. Entry point

The extension contributes exactly one view (`muster.chat`). This design adds no
second view or container. `webview/src/App.svelte` gains a `workflowsOpen` mode
alongside the existing `settingsOpen`, `historyOpen`, and `workflowGraphOpen`
state flags.

The mode must be reachable from both the entry task list and an open task,
because the catalog is workspace-scoped and does not depend on a focused task.
That rules out copying the `workflowGraphOpen` placement: `WorkflowGraphModal`
renders inside the `{#if !inChat}{:else}` chat branch and its toolbar button
early-returns unless `tasks.focusedTaskId` is set, which is correct for a
run-scoped graph and wrong for a workspace-scoped catalog.

`workflowsOpen` instead follows the `settingsOpen` placement: a top-level branch
that replaces the panel body, so it renders identically from the entry list and
from a task. Consequently it is mutually exclusive with Settings, and
`openSettings` clears it exactly as it already clears `historyOpen` and
`workflowGraphOpen`.

App.svelte has two toolbars, one in the entry header and one in the chat header,
so the toolbar button is added in both places rather than once.

## 5. Screen content

One list grouped by scope, workspace before global, preserving the catalog's
existing deterministic ordering:

```text
Workflows                                  [Reload]

Workspace
  Build checks          bundle    Run lint and typecheck
  Review flow           file      Parallel review

User
  Release notes         bundle    Draft release notes

Diagnostics (2)
  messy.md              invalid_workflow_file
  ambiguous             invalid_workflow_file
```

Each row renders exactly the fields `listPredefinedWorkflows` already returns:
`name`, `description`, `scope`, `packageKind`. `workflowRef` is retained in
webview state as the row key and is not displayed.

The wire `scope` values remain the catalog's own `'workspace' | 'global'`. Only
the group heading is relabelled to "User" for display, because "global" reads as
a system-wide setting rather than a per-user directory. No renaming crosses the
wire.

Within each scope the list preserves the catalog's existing sort: name bytes,
then scope, then entry file. Grouping partitions that order without resorting.

Diagnostics render `file` and `code` as primary text with `message` as
supporting detail. `boundedFileLabel` reduces `file` to a control-character-free
basename capped at 160 characters, and `boundedDiagnosticMessage` caps `message`
at 240 characters, so no absolute path or unbounded body reaches the webview.

Two diagnostics use the reserved `file` value `(scope)` rather than a basename:
`scope_unavailable` when a catalog root cannot be read, and `scope_truncated`
when a scope exceeds 128 entries. Both render as scope-level notices, not as
file rows.

## 6. Load semantics

The host owns one in-memory catalog snapshot keyed by the resolved workspace
catalog folder:

- The first `requestWorkflowCatalog` with `reason: 'initial'` scans the catalog
  roots and caches the result under that folder key.
- A later `initial` request whose resolved folder matches the key returns the
  cached snapshot without touching the filesystem. Closing and reopening the
  panel does not rescan.
- `reason: 'reload'` always rescans and replaces the snapshot.
- A resolved folder different from the key is treated as a miss and rescans,
  replacing the snapshot.
- The snapshot is discarded on extension deactivation.

The folder key matters because the host resolves `workspaceFolder` through
`resolveTaskCwd()`, which uses `resolveWorkspaceCwd`: in a multi-root workspace
the folder holding the active editor wins, so the resolved catalog root can
change between two requests without any user action in this panel. Caching per
session rather than per folder would serve one root's catalog while the user is
working in another.

Catalog roots reuse the existing resolution, unchanged: canonical
`<workspace>/.muster/workflows/` and `~/.muster/workflows/`, with the singular
`workflow` directory as a read-only fallback when the canonical root is absent,
and workspace entries shadowing same-named global entries.

The host passes `workspaceFolder: resolveTaskCwd()` and omits
`globalWorkflowFolder`, so production resolves the global root from `homedir()`.
The override remains available for tests and isolated hosts.

## 7. Protocol

The message pair mirrors the established `requestWorkflowGraph` /
`workflowGraphResult` contract.

`src/shared/workflow-catalog-wire.ts` owns the shared types and a fail-closed
parser:

```ts
export interface RequestWorkflowCatalog {
  type: 'requestWorkflowCatalog';
  requestId: string;
  reason: 'initial' | 'reload';
}

export type WorkflowCatalogErrorCode = 'unavailable' | 'invalidRequest';

export type WorkflowCatalogResult =
  | {
      type: 'workflowCatalogResult';
      requestId: string;
      ok: true;
      catalog: WorkflowCatalogWire;
    }
  | {
      type: 'workflowCatalogResult';
      requestId: string;
      ok: false;
      code: WorkflowCatalogErrorCode;
    };
```

`WorkflowCatalogWire` carries a bounded `workflows` array (`workflowRef`,
`name`, `description`, `scope`, `packageKind`), a bounded `diagnostics` array
(`file`, `code`, `message`), and the `reason` the snapshot was produced for.

The parser enforces exact keys, the closed `scope` (`workspace | global`) and
`packageKind` (`file | bundle`) value sets, and the caps the catalog already
applies: 128 entries per scope and 32 diagnostics total.

`code` is validated as a bounded identifier string, not a closed union, because
`PredefinedWorkflowDiagnostic.code` is typed `string` in the host and the four
values emitted today (`scope_unavailable`, `scope_truncated`,
`invalid_workflow_file`, `duplicate_workflow_name`) are not a declared taxonomy.
Closing the set on the wire would make the panel reject a payload whenever the
host adds a diagnostic. The panel renders an unrecognised `code` verbatim as
bounded text and does not branch on it, so a new host code degrades to a plain
row rather than a dropped snapshot.

`PROTOCOL_VERSION` moves from 12 to 13 in both `src/extension.ts` and
`webview/src/lib/protocol.ts`. The change is additive, so this is defensive
rather than strictly required: it converts "new UI on an old host" from a silent
stall into the existing reload-window banner. The webview store also keeps a
silent-host timeout, matching `WorkflowGraphStore`, so a version skew degrades
to a retryable error either way.

## 8. Modules

| Module | Responsibility |
|---|---|
| `src/shared/workflow-catalog-wire.ts` | Wire types, closed taxonomies, fail-closed parsers |
| `src/host/workflow-catalog-cache.ts` | Session snapshot; `initial` reads cache, `reload` rescans |
| `src/host/workflow-catalog-route.ts` | Pure route from request to `WorkflowCatalogResult` |
| `src/extension.ts` | `requestWorkflowCatalog` dispatch case, catalog root resolution, post |
| `webview/src/lib/workflow-catalog-store.svelte.ts` | Request correlation, single-flight, timeout, retry |
| `webview/src/components/WorkflowCatalogPanel.svelte` | List, grouping, diagnostics, states |
| `webview/src/App.svelte` | `workflowsOpen` mode, toolbar button, mode exclusivity |

The route takes its catalog reader as a dependency and returns a message or a
typed failure, with no VS Code or filesystem coupling, so it is unit-testable in
the same way as `routeRequestWorkflowGraph`.

## 9. States

| State | Trigger | UI |
|---|---|---|
| Loading | Request in flight | Spinner with progress text |
| Populated | Snapshot with at least one workflow | Grouped list, plus diagnostics when present |
| Empty | Snapshot with no workflows and no diagnostics | Guidance to create `.muster/workflows/` |
| Diagnostics only | Every candidate rejected | Diagnostics list with the same guidance |
| Error | Host not ready, read failure, or request timeout | Message plus Retry |

Reload keeps the previous list visible while the rescan is in flight, so the
panel does not blank out on refresh. A failed reload preserves the prior
snapshot and surfaces the error without discarding usable data.

The store drops any response whose `requestId` does not match the in-flight
request, so a late reply cannot overwrite a newer snapshot.

## 10. Verification

- Wire parser tests: valid payloads, unknown `scope`/`packageKind`, extra keys,
  oversized arrays, and a payload containing an absolute path.
- Cache tests: `initial` scans once then serves cache, `reload` rescans, read
  failure does not poison the snapshot.
- Route tests: success, malformed request, catalog read failure to `unavailable`.
- Store tests: correlation, stale-response drop, single-flight, timeout to error,
  retry after error, reload preserving the prior snapshot on failure.
- Panel tests: grouping order, diagnostics rendering, each state.
- `npm run compile` and `npm run check:svelte`.
- One Playwright journey: seed `.muster/workflows/` with a flat file and a
  bundle, open Workflows, assert both rows with correct scope and package kind,
  add a third package, assert it appears only after Reload.

## 11. Acceptance criteria

- [ ] A flat Markdown workflow in `<workspace>/.muster/workflows/` appears in the
      list with `scope: workspace` and `packageKind: file`.
- [ ] A directory bundle appears with `packageKind: bundle`.
- [ ] A workflow in `~/.muster/workflows/` appears under the user scope.
- [ ] A workspace workflow shadows a same-named global workflow.
- [ ] The legacy singular `workflow` root is read when the canonical root is absent.
- [ ] An invalid or ambiguous package produces a visible bounded diagnostic.
- [ ] No absolute path appears in any rendered field or wire payload.
- [ ] A package added during the session appears only after Reload.
- [ ] Reopening the panel does not rescan the filesystem.
- [ ] An empty or missing catalog root renders guidance, not an error.
- [ ] A host read failure renders a retryable error.

## References

- [Workflow package contract](../MUSTER-WORKFLOWS.md)
- [Webview protocol](../WEBVIEW.md)
- [MCP bridge contract](../MUSTER-BRIDGE.md)
