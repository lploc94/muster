# M024 Workflow Reuse Review Follow-up

**Status:** ACCEPTED FOLLOW-UP DEBT (PR #41)  
**Recorded:** 2026-08-13  
**Source review:** `feat/m024-workflow-artifact-reuse-graph-visibility` at `a6ed434`  
**Disposition:** PR #41 may merge with these findings recorded. All five findings must be remediated on `main` immediately after merge.

## Scope

This ledger records the unresolved findings from the final review of PR #41. It is not evidence that the findings are fixed, and it introduces no runtime behavior. Close this ledger only after every acceptance criterion and verification gate below passes.

## Accepted Findings

### F1 - Partial reuse rejects unbound predecessors instead of materializing them

**Severity:** High

`startWorkflowRun` expands a requested reused node over its predecessor closure and rejects the start with `node reuse closure incomplete` when any predecessor lacks an explicit reuse binding. This turns node-level reuse into an all-ancestors-or-nothing contract. Unbound nodes in the new run should retain normal workflow semantics and materialize rather than forcing callers to locate and bind every historical predecessor execution.

**Acceptance criteria**

- A caller may bind one valid destination node without binding its predecessors.
- Every unbound node materializes under the normal dependency and routing rules.
- Only explicitly bound nodes receive `reused` status and source provenance.
- Mixed materialized/reused fan-in remains deterministic across reload and concurrent settlement.
- Invalid explicit bindings still fail before any consumer task is created.

### F2 - The public MCP contract requires an undiscoverable source task ID

**Severity:** High

`start_workflow` now requires `{node, fromRun, fromNode, fromTask}`, but the public workflow inspection result does not expose the producer task identity needed to construct `fromTask`. A client that did not retain internal task IDs cannot use the new exact-execution binding contract from supported public APIs.

**Acceptance criteria**

- A public read API exposes the source task ID for each reusable materialized node.
- The identifier is scoped to the existing workflow authorization boundary and is not inferred from "latest" state.
- A client can inspect a completed run and pass the returned identities directly to `start_workflow`.
- Public projection and bridge tests prove the complete inspect-then-reuse round trip.

### F3 - Reused nodes leave terminal workflow dependency gates live

**Severity:** Medium

Reused nodes do not own consumer tasks, but their dependency gates remain live after the run reaches a terminal state. Diagnostics report `terminal_run_has_live_gate`, and `reclaimTerminalWorkflowMetadata` cannot reclaim the run metadata.

**Acceptance criteria**

- A successful run containing reused nodes has no `open` or otherwise live gates after settlement.
- Reused-node inputs remain available to downstream materialized consumers.
- Terminal workflow diagnostics contain no `terminal_run_has_live_gate` for valid reuse runs.
- Retention can reclaim eligible terminal workflow metadata without special-casing a leaked gate.

### F4 - Reuse provenance and status can be rewritten after insertion

**Severity:** Medium

SQLite accepts updates that change a reused `workflow_nodes` row back to a materialized status and accepts replacement `source_run_id`, `source_node_id`, and `source_task_id` values. The durable graph can therefore cease to represent the exact source execution originally authorized by the caller.

**Acceptance criteria**

- SQLite rejects any post-insert mutation of reuse provenance.
- SQLite rejects transitions that add or remove reused identity after insertion.
- Valid lifecycle transitions for materialized nodes continue to work.
- Fresh-schema tests prove both invariants with direct SQL mutation attempts.
- If the schema changes, bump the reset-only schema version and update every pinned schema/documentation evidence check.

### F5 - Public guidance still advertises the obsolete two-field binding

**Severity:** Medium

Public tool guidance still describes reuse as `{node, fromRun}` even though the accepted MCP contract requires `{node, fromRun, fromNode, fromTask}`. This directs callers toward requests that validation rejects.

**Acceptance criteria**

- Tool descriptions, bridge guidance, task-management documentation, examples, and error recovery text describe the four-field binding consistently.
- No active public documentation advertises `{node, fromRun}` as a valid request.
- Documentation/evidence tests fail if the obsolete request shape returns.

## Completion Gate

- [ ] F1 partial reuse materializes every unbound node.
- [ ] F2 public inspection exposes exact reusable execution identity.
- [ ] F3 terminal reuse runs leave no live dependency gates.
- [ ] F4 SQLite makes reuse provenance immutable.
- [ ] F5 all public guidance uses the four-field binding.
- [ ] Focused workflow, bridge, projection, retention, schema, and documentation tests pass.
- [ ] `npx tsc --noEmit -p .` passes.
- [ ] Full CI passes on the remediation commit.

## Closure Evidence

Record the implementing commit, named regression tests, schema version decision, and final verification results here before changing the status to **IMPLEMENTED**.
