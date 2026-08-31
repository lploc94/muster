# Muster Workflows

**Status:** Canonical package and execution contract

**Scope:** User-authored workflow packages discovered from workspace or global
catalog roots, frozen into durable canonical definitions, and executed as agent
or local-script nodes.

## 1. Package authority

A saved workflow is exactly one direct-child directory containing one regular
`workflow.json` file. `workflow.json` is the only package authority for metadata,
public interfaces, nodes, edges, instructions, scripts, and outcomes.

Markdown is not a workflow definition format. A package may reference bounded
Markdown files through `instructions.file`, but those files are executable task
content owned by the canonical manifest. Their bytes are frozen when the package
is defined and are never reinterpreted as graph structure.

The following forms are not catalog entries:

- flat Markdown files;
- flat `workflow.json` files directly under a catalog root;
- directory bundles whose entry is Markdown;
- the legacy singular `.muster/workflow/` root; and
- directories with missing, non-regular, symlinked, or ambiguous manifests.

There is no compatibility decoder or fallback package format.

## 2. Catalog layout

The only catalog roots are:

```text
<workspace>/.muster/workflows/
~/.muster/workflows/
```

Each direct child is one candidate package:

```text
.muster/workflows/
└── review-change/
    ├── workflow.json
    ├── prompts/
    │   ├── research.md
    │   └── review.md
    └── scripts/
        └── verify.ts
```

Nested directories are package contents, never additional catalog entries.
Workspace packages shadow global packages with the same normalized workflow
name. Within one scope, deterministic byte-wise ordering selects one duplicate
name and emits a bounded diagnostic.

Catalog enumeration, package depth, file count, individual file bytes,
aggregate package bytes, manifest bytes, instruction bytes, and diagnostics are
bounded. Symlinks and non-regular files are rejected and never followed.
Catalog results and diagnostics never expose absolute paths.

## 3. Canonical manifest

`workflow.json` uses the strict schema literal `muster.workflow/v2`. The closed
manifest contract is documented in [MUSTER-BRIDGE.md](MUSTER-BRIDGE.md) and
includes:

- bounded `name` and optional `description`;
- named semantic `inputs` and `outputs`;
- mutually exclusive agent and execute nodes;
- optional inline or package-file instructions;
- converging acyclic edges using stable `inputRef` identities; and
- optional agent outcomes or complete numeric exit outcomes.

Saved packages may use either instruction form:

```json
{ "instructions": { "inline": "Inspect the requested subsystem." } }
```

```json
{ "instructions": { "file": "prompts/research.md" } }
```

Inline public definitions may use only `instructions.inline`. A script node may
reference only a bounded package-relative script path with an allowlisted
interpreter and literal argv.

Unknown manifest or nested fields fail before any definition mutation. Package
contents cannot provide durable IDs, host policy, backend/model/role/capability
authority, artifact coordinates, credentials, or filesystem roots.

## 4. Discovery and opaque references

Catalog discovery parses only enough canonical manifest data to validate and
list bounded metadata:

- `workflowRef`;
- `name`;
- optional `description`;
- `scope: workspace | global`; and
- `packageKind: bundle`.

`workflowRef` is an opaque `pwf_<32 hex>` reference to one exact package
snapshot. The host derives it from trusted scope/package identity and a
deterministic SHA-256 digest over every accepted regular package file, including
its normalized relative name and exact bytes in deterministic order. The digest
uses domain-separated, length-prefixed path/content frames so arbitrary asset
bytes cannot be confused with file boundaries.

Changing `workflow.json`, a referenced prompt, a script, or any other accepted
package file changes the package digest and reference. Adding or removing a file
does the same. An old reference fails closed as stale.

`list_predefined_workflows` and `get_predefined_workflow` are read-only catalog
operations. They expose bounded metadata and diagnostics, not manifest JSON,
prompt bodies, script bodies, package roots, or host paths. A coordinator defines
a saved package only as:

```json
{ "predefinedWorkflowRef": "pwf_<32 hex>" }
```

The coordinator never reconstructs or resubmits the saved graph.

## 5. Definition-time freeze

The host resolves the opaque package reference again immediately before the
definition write. It must:

1. reconstruct the canonical catalog/package root from host-owned provenance;
2. reject lexical traversal and every symlink component;
3. reread the bounded regular package files;
4. recompute and verify the package digest and opaque reference;
5. decode the complete canonical manifest in saved-package mode;
6. resolve every `instructions.file` and script path below the frozen package
   root;
7. verify file type, extension, containment, size, and exact bytes;
8. freeze instruction content and SHA-256 digest;
9. freeze script relative path, package provenance, package digest, and script
   digest; and
10. resolve task profiles and effective host policy before repository mutation.

If any asset is missing, changed, over-bound, non-regular, symlinked, outside the
package, or incompatible with its interpreter, definition fails without partial
rows. Two packages with identical `workflow.json` bytes but different prompt or
script bytes are distinct immutable definitions.

The catalog remains read-only. Persistence is repository-owned; the catalog
loader returns a complete frozen definition but never writes or executes it.

## 6. Runtime semantics

Frozen instruction bytes are persisted as node task content. Normal entry,
dependency, child, retry, and reload paths use those bytes and never reread a
mutable prompt file.

Script execution deliberately separates the package root from process working
directory:

```text
script root = frozen package root
process cwd = active workspace or task cwd
```

Before spawn, the runtime resolves the package from frozen provenance, verifies
the current script bytes against the frozen digest, requires a regular
interpreter-compatible file, and launches with `shell: false` and literal argv.
A changed script cannot execute through an existing definition. Runtime script
verification does not reload or reinterpret `workflow.json` or prompt files.

Each execute activation runs its script once and applies the frozen exit outcome
through the normal durable workflow disposition path:

- exit code `0` stages NEXT with bounded stdout as the result;
- a numeric nonzero exit stages exactly the declared PREV targets with bounded
  stdout as feedback, or stages FAIL when the manifest declares FAIL; and
- when a nonzero PREV script emits no non-whitespace stdout, the host supplies
  deterministic bounded feedback naming the failed check and exit code.

Stderr is retained only as a bounded turn diagnostic. It never becomes a NEXT
artifact or PREV feedback. A spawn, timeout, cancellation, package-integrity,
missing-exit-status, or output-bound failure is operational and cannot be
reclassified as PREV or FAIL by the manifest's numeric outcome contract.

Node scripts may use `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, or `.mts`. TypeScript
uses Node native type stripping and therefore must use erasable syntax. Muster
does not install dependencies, invoke `npx`, or load a package-local compiler.

## 7. Trust and data boundaries

Local script execution requires a trusted workspace, live
`muster.verification.hostRun=true`, an allowlisted interpreter, valid resource
bounds, and verified frozen provenance. Package contents cannot weaken those
checks.

Child processes receive the filtered execution environment, not the complete
extension-host environment. Stdout, stderr, timeout, cancellation, and process
tree handling remain bounded. Script nodes do not create ACP sessions, receive
MCP grants, or gain coordinator authority from package contents.

Catalog, MCP, status, graph, and webview projections never expose manifest or
instruction bodies, scripts, filesystem paths, credentials, or physical
artifact identities.

## 8. Failure and recovery

| Condition | Result |
|---|---|
| Invalid or unknown manifest field | Bounded package diagnostic; package omitted |
| Missing/ambiguous/non-regular `workflow.json` | Package omitted |
| Flat Markdown or flat JSON | Not a package; never compiled |
| Traversal, symlink, unsafe name, or exceeded bound | Fail closed without path leakage |
| Package changes after listing | Old opaque ref rejected |
| Prompt/script changes before definition | Definition rejected before persistence |
| Prompt changes after definition | Existing activation still uses frozen bytes |
| Script changes after definition | Integrity failure before spawn |
| Workspace untrusted or host execution disabled | No script run is admitted |

Recovery is explicit: fix the package, reload the catalog, obtain the new opaque
reference, and define a new immutable workflow version.

## 9. Acceptance contract

- Only canonical direct-child `workflow.json` bundles are discoverable.
- Workspace-over-global precedence and deterministic duplicate handling remain.
- Package identity includes exact manifest, prompt, script, and nested asset
  bytes.
- Saved define accepts only the opaque package reference.
- Every referenced instruction and script is bounded, contained, integrity
  checked, and frozen before persistence.
- Runtime prompt content comes only from persisted frozen bytes.
- Runtime script resolution remains package-root-relative with workspace cwd.
- Legacy flat/bundle Markdown definitions and singular-root fallback are absent.
- Public catalog and diagnostics remain bounded and path-free.

## References

- [Task and workflow domain](TASK-MANAGEMENT.md)
- [MCP bridge contract](MUSTER-BRIDGE.md)
- [Workflow Definition V2 design](plans/workflow-definition-v2-design.md)
- [Script workflow QA](qa/script-workflow-qa-plan.md)
