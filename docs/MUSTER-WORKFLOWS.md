# Muster Workflows

**Status:** Target design and implementation contract

**Scope:** User-authored workflows that can be discovered from a workspace or
global catalog, compiled into durable workflow definitions, and executed as a
graph of agent and local-script nodes.

## 1. Problem

Muster workflows are currently split between two concepts:

- a Markdown file discovered from a workspace or global catalog; and
- a workflow definition whose script paths are interpreted relative to the
  active workspace.

That model cannot represent a reusable workflow package whose Markdown entry
file and scripts live together. A global workflow must be able to carry its own
scripts without silently resolving them to a same-named file in the active
workspace.

## 2. Goals

- Support a workflow represented by one Markdown file.
- Support a workflow represented by a directory bundle containing an entry
  Markdown file and supporting scripts/assets.
- Discover both forms from workspace and global catalogs.
- Resolve script paths relative to the workflow's package root, not by guessing
  from the caller's workspace.
- Preserve source provenance and executable integrity through definition,
  reload, retry, and workflow-node activation.
- Keep the active workspace as the process working directory so a reusable
  workflow can operate on the project that invoked it.
- Keep the existing agent/script graph, durable gates, idempotency, output
  bounds, and trust checks.
- Make public catalog data useful without exposing host filesystem paths.

## 3. Non-goals

- Sandboxing a script from the operating system. A permitted local process still
  has the OS permissions of the user.
- Installing package dependencies, running `npm install`, or resolving
  executables through `npx`.
- Inferring a workflow graph from Markdown prose. The coordinator still compiles
  the untrusted body into the strict semantic `define_workflow` shape.
- Allowing a workflow package to override host policy, credentials, MCP grants,
  or resource limits.

## 4. Terminology

- **Catalog root:** The directory scanned for workflows.
- **Flat workflow:** One Markdown file directly under a catalog root.
- **Bundle workflow:** One directory directly under a catalog root, with one
  entry Markdown file and any supporting files below it.
- **Package root / bundle root:** The directory against which package-relative
  script and asset paths are resolved. For a flat workflow this is the catalog
  root; for a bundle it is the bundle directory.
- **Entry file:** The Markdown file that supplies the workflow name,
  description, and untrusted instructions.
- **`workflowRef`:** An opaque catalog reference for one exact package snapshot.
- **`nodeKey`:** Semantic identity inside a definition. It is not a task ID.
- **`runRef`:** Opaque identity of one execution of a frozen definition.

## 5. Catalog layout

The canonical roots are:

```text
<workspace>/.muster/workflows/
~/.muster/workflows/
```

Both roots may contain flat workflows and bundle workflows:

```text
.muster/workflows/
├── lint.md
└── workflow_a/
    ├── workflow_a.md
    └── scripts/
        ├── node_1.ts
        └── node_2.js
```

The global equivalent is:

```text
~/.muster/workflows/workflow_b/
├── workflow_b.md
└── scripts/run.py
```

The previously shipped singular `workflow` directory is accepted as a
read-only compatibility root when the canonical `workflows` root is absent.
New documentation and generated examples use `workflows`.

### 5.1 Entry-file rules

- A flat candidate is a regular `.md` file directly under the catalog root.
- A bundle candidate is a regular directory directly under the catalog root.
- A bundle uses `<bundle-name>.md` when that file exists.
- Otherwise a bundle must contain exactly one regular `.md` file directly under
  the bundle directory.
- Nested directories are package contents, not additional catalog entries.
- A bundle with no unambiguous entry file is diagnosed and omitted.
- Symlinks are not package entries and are not followed while building package
  identity or resolving scripts.

### 5.2 Precedence and bounds

- Workspace entries shadow global entries with the same normalized name.
- Within one root, duplicate names select the byte-wise lexicographically first
  candidate and emit a bounded diagnostic.
- Catalog enumeration, package file count, individual file bytes, aggregate
  package bytes, Markdown body characters, and diagnostic count are all bounded.
- Catalog results never expose absolute paths.

## 6. Package identity and provenance

Every discovered package has an internal source descriptor equivalent to:

```ts
interface WorkflowPackageSourceV1 {
  kind: 'predefined';
  scope: 'workspace' | 'global';
  packageKind: 'file' | 'bundle';
  catalogRootKind: 'canonical' | 'legacy' | 'custom';
  packagePath: string;
  entryFile: string;
  workflowRef: string;
  packageSha256: string;
}
```

The descriptor contains logical, validated relative paths only. It is
host-authored metadata; a coordinator cannot manufacture it.

`workflowRef` is derived from the scope, package kind, logical package/entry
identity, and a deterministic digest of the package contents. For a flat file,
the package contents are the entry file. For a bundle, all bounded regular
package files are hashed together with their normalized relative names and
bytes.

Changing the entry file, adding/removing a bundle file, or changing any bundle
file produces a new ref. An old ref is rejected by `get_predefined_workflow`.

When a coordinator compiles a retrieved predefined workflow, it must include
the returned opaque ref in `define_workflow`. The host resolves that ref again,
binds the package source to every script node, and records a per-script digest.
The compiled definition is therefore independent of a later catalog scan and
does not silently switch to another package.

## 7. Public MCP contract

### 7.1 Catalog tools

`list_predefined_workflows` returns bounded metadata, including:

- `workflowRef`
- `name`
- `description`
- `scope`
- `packageKind`

It does not return host paths or package bodies.

`get_predefined_workflow` accepts only the opaque ref and returns the body,
metadata, package kind, and `user-authored-untrusted` provenance. The body is
data, not host policy or permission.

### 7.2 `define_workflow`

The existing strict semantic shape remains the source of truth:

```json
{
  "name": "Build checks",
  "predefinedWorkflowRef": "pwf_<32 hex>",
  "nodes": [
    {
      "nodeKey": "check",
      "script": {
        "interpreter": "node",
        "file": "scripts/node_1.ts",
        "args": ["--check"],
        "onFailure": "fail_run"
      }
    }
  ]
}
```

`predefinedWorkflowRef` is optional for an ad-hoc workflow whose script files
are intentionally workspace-relative. It is required when compiling a
predefined package that contains package-local scripts. It is not copied into
the model-controlled topology; the host resolves and freezes source metadata.

Agent and script nodes remain an exclusive choice. Script nodes support
allowlisted `node`, `python`, and `python3` interpreters, typed argv, bounded
stdin/stdout/stderr, and `fail_run` or `continue` behavior.

## 8. Path and execution semantics

There are two deliberately separate directories:

```text
process cwd  = active workspace / task cwd
script root  = package root of the frozen workflow source
```

For a bundle such as:

```text
~/.muster/workflows/workflow_a/scripts/node_1.ts
```

the declaration `file: "scripts/node_1.ts"` resolves to that exact file under
the bundle root. It must never resolve to
`<active-workspace>/scripts/node_1.ts` merely because the workflow was invoked
there.

For a flat file, the package root is the containing catalog directory. Bundle
workflows are recommended whenever scripts or assets are needed because their
boundary is narrower and unambiguous.

Before spawn, the host/runtime must:

- resolve the catalog/package root from frozen provenance, never from the
  current Markdown listing;
- canonicalize the package root and script path;
- reject absolute paths, drive paths, NUL/control separators, traversal, and
  symlink escapes;
- require a regular file and an interpreter-compatible extension;
- verify the stored script digest before launch;
- use `shell: false` and preserve argv literally;
- keep process cwd separate from script root.

This containment check protects which file is launched. It is not an OS-level
sandbox for what the script can read or write after launch.

## 9. TypeScript scripts

Node scripts may use `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts`.

TypeScript files are launched through the allowlisted Node executable with
Node's native type-stripping mode. This requires a Node version that supports
the mode (Node 22.6 or later) and limits scripts to erasable TypeScript syntax;
enums, namespaces with runtime code, parameter properties, and other syntax
that requires transformation are not guaranteed. A package requiring full
transpilation must ship compiled JavaScript instead.

Muster does not load a package-local compiler, install dependencies, or execute
`npx`. A missing/incompatible Node runtime is a bounded workflow failure.

## 10. Trust and authorization

Local script execution requires all of:

- a trusted workspace;
- the live user setting `muster.verification.hostRun=true`;
- a valid frozen package source (for predefined scripts), or an authorized
  workspace-relative ad-hoc script;
- an allowlisted interpreter and valid bounds.

The existing setting is a broad host-execution consent gate, not a claim that a
script is safe. Global package scripts are local executable code and should be
treated with the same caution as workspace scripts. Future UX may add a
separate per-package approval/trust record, but it must not weaken the current
workspace trust and live-setting checks.

Child processes receive a filtered environment, never the complete extension
host environment. Stderr remains a bounded diagnostic on the producing turn;
only the bounded stdout result and explicit exit metadata enter workflow
artifacts.

Timeout and cancellation terminate the complete process tree, escalate after a
grace period, and have a hard settlement deadline. Script nodes do not create
ACP sessions, use MCP, retry through agent fallbacks, or gain coordinator
authority from package contents.

## 11. Durable lifecycle

- Package source and script integrity are frozen when the semantic workflow is
  defined.
- The source metadata survives definition persistence, start idempotency,
  shell materialization, reload, gate activation, and child workflow paths.
- A changed package does not mutate an existing definition into another program.
  A changed referenced script fails integrity validation; the caller must list,
  retrieve, and define a new version.
- Existing workflow task IDs and durable gate semantics remain unchanged.
- Public results continue to expose opaque refs and bounded status, not source
  paths, package bodies, or credentials.

## 12. Compatibility

- Existing ad-hoc workspace-relative script definitions remain valid.
- Existing singular catalog roots are read as a compatibility fallback; the
  canonical plural root wins when both are present.
- Existing agent-only workflow definitions remain unchanged on disk.
- New source metadata is optional and decoded fail-closed; legacy definitions
  without it retain the ad-hoc workspace-relative script behavior.
- A future schema change must preserve old definition fingerprints and replay
  semantics or provide an explicit migration.

## 13. Implementation workstreams

1. Catalog: discover flat files and bundles, calculate deterministic package
   identity, expose package kind, and resolve frozen package sources.
2. Domain: add validated source/integrity metadata to script execution specs and
   include it in topology encoding and definition fingerprints.
3. Coordinator: accept `predefinedWorkflowRef`, resolve it host-side, and bind
   package-local script metadata before persistence.
4. Runtime: pass a frozen script root separately from process cwd and verify
   script integrity immediately before spawn.
5. TypeScript: support Node native type stripping for `.ts`/`.cts`/`.mts` with a
   clear runtime-version failure path.
6. Tests: cover flat and bundle forms in workspace/global scopes, precedence,
   stale refs, reload/replay, symlink/traversal escapes, wrong-root collisions,
   integrity changes, TypeScript launch, and existing ad-hoc compatibility.
7. Documentation and UAT: update the QA matrix and native scenarios to prove a
   global bundle executes its own script while operating on the active workspace.

## 14. Acceptance criteria

- [ ] A flat workspace Markdown workflow remains discoverable and runnable.
- [ ] A flat global Markdown workflow remains discoverable and runnable.
- [ ] A workspace directory bundle with `scripts/node_1.ts` runs that file.
- [ ] A global directory bundle with `scripts/node_1.ts` runs that file, even
      when the active workspace has a same-named path.
- [ ] Bundle-relative scripts receive the active workspace as process cwd.
- [ ] Nested bundle files are included in package identity and stale-ref checks.
- [ ] Missing/ambiguous entries, symlinks, traversal, and wrong extensions fail
      closed without leaking absolute paths.
- [ ] Modifying a referenced script after definition prevents execution through
      the old frozen definition.
- [ ] `hostRun=false` or workspace untrusted prevents run creation/spawn.
- [ ] Existing ad-hoc workspace-relative JavaScript/Python workflows pass.
- [ ] Unit, compile, source-boundary, full-suite, and packaged Extension Host
      gates pass.

## References

- [Task and workflow domain](TASK-MANAGEMENT.md)
- [QA plan](qa/script-workflow-qa-plan.md)
- [MCP bridge contract](MUSTER-BRIDGE.md)
