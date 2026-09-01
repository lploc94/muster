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

Child invocation fingerprints canonically order public binding names by their
UTF-8 bytes. Replay identity is therefore independent of the host locale and
ICU version; it never uses locale-sensitive collation.

An agent node may omit `outcome` and keep final-assistant-message implicit NEXT.
When an agent outcome is present, the host renders its declared NEXT/PREV/FAIL
contract and authorizes every attempted disposition against the frozen node
definition before staging it. PREV can address only one exact declared set of
direct inbound `inputRef` values and always carries bounded nonempty feedback.

For `requireExplicitDisposition: true`, a completed turn without a valid route
opens activation-owned decision repair. An authenticated invalid route attempt
does the same, including for an otherwise optional outcome. The original turn is
attempt 1; attempts 1 and 2 reserve one deterministic same-task correction turn,
and attempt 3 exhausts the repair and fails the run with bounded
`decision_missing` or `decision_invalid` evidence. A valid disposition accepted
first remains authoritative across races, replay, and reload. Decision repair is
not PREV: it creates no feedback round, producer turn, hidden node, or graph edge.
Only a completed third missing/invalid decision marks repair `exhausted` at
attempt 3. Timeout, cancellation, and workflow-budget closure preserve the
actual number and evidence of decision attempts, clear any scheduled correction,
and suppress an otherwise-open correction summary once the run is terminal.

Script execution deliberately separates the package root from process working
directory:

```text
script root = frozen package root
process cwd = active workspace or task cwd
```

Before spawn, the runtime resolves the package from frozen provenance, verifies
the current script bytes against the frozen digest, and materializes the
coherently verified package bytes into an isolated package-shaped execution
snapshot. It requires a regular interpreter-compatible file in that snapshot,
launches it with `shell: false` and literal argv, retains the workspace/task cwd,
and removes the snapshot after the child terminates. Package-relative imports
therefore use the verified bytes rather than reopening the mutable catalog
package. A changed script cannot execute through an existing definition.
Runtime script verification does not reload or reinterpret `workflow.json` or
prompt files as workflow configuration.

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

Local script execution requires a trusted workspace, live resource-scoped
`muster.verification.hostRun=true` for the task/workflow execution cwd, an
allowlisted interpreter, valid resource bounds, and verified frozen provenance.
The engine re-reads the effective setting at workflow start and immediately
before spawn; verification-task commands also re-read it at settle. In a
multi-root workspace, folder overrides stay isolated and active-editor focus
does not retarget an existing task. Package contents cannot weaken those checks.

Child processes receive the filtered execution environment, not the complete
extension-host environment. Stdout, stderr, timeout, cancellation, and process
tree handling remain bounded. Script nodes do not create ACP sessions, receive
MCP grants, or gain coordinator authority from package contents.

Catalog, MCP, status, graph, and webview projections never expose manifest or
instruction bodies, scripts, filesystem paths, credentials, or physical
artifact identities. Graph topology uses only manifest node keys and input
references; durable run, dependency-gate, feedback-round, and child-run
identifiers remain repository-private.

Status and graph projections derive decision state from durable activation and
repair rows. They may expose a node's bounded display `title`, whether its agent
outcome has an optional or required decision gate, and a closed repair summary
such as `Waiting for workflow decision` or `Correcting workflow route` with
`attempt N of 3`. The graph never fabricates a decision node. Dependency-gate,
feedback, execution, completion, and failure remain independent display axes:
normal PREV is revision/waiting-for-feedback, while Failed appears only after
repair exhaustion or actual semantic/operational closure.
When process cancellation is still settling, execution activity may temporarily
report the last live turn; the terminal workflow-node/run state remains
authoritative for the displayed state and progress counts.

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
| Missing/invalid agent route below attempt 3 | One durable correction turn; run remains open |
| Missing/invalid agent route at attempt 3 | Repair exhausts and the run fails once |

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
- Agent outcome repair is activation-owned, bounded to three attempts, durable
  across reload, and visible only through bounded decision metadata.
- Public starts bind named inputs, and prior-run composition selects one exact
  named terminal output rather than a run-level aggregate.
- Legacy flat/bundle Markdown definitions and singular-root fallback are absent.
- Public catalog and diagnostics remain bounded and path-free.

## References

- [Task and workflow domain](TASK-MANAGEMENT.md)
- [MCP bridge contract](MUSTER-BRIDGE.md)
- [Workflow Definition V2 design](plans/workflow-definition-v2-design.md)
- [Script workflow QA](qa/script-workflow-qa-plan.md)
