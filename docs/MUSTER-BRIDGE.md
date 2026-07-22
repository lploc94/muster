# Muster Bridge MCP Server

This document is the authoritative design for the extension-owned MCP server
`muster_bridge`. The bridge exposes workflow orchestration and thin IDE integration;
it does not expose the legacy delegate-task protocol.

## 1. Public protocol

The public MCP catalog is exactly:

| Tool | Purpose |
|------|---------|
| `list_task_types` | Refresh available workflow-node profiles and diagnostics |
| `inspect_workflow_run` | Inspect bounded durable state for an owned workflow run |
| `get_host_context` | Refresh trusted host, self, profile, and routing context |
| `define_workflow` | Persist an immutable validated workflow definition version |
| `start_workflow` | Idempotently start and await a frozen top-level workflow run |
| `workflow_next` | Publish the current node result to its forward route |
| `workflow_prev` | Request correction from one or all direct producers |
| `workflow_fail` | Fail-fast close the current workflow run |
| `invoke_child_workflow` | Stage an authorized child-workflow `NEXT` route |
| `upsert_presentation` | Open or revise a user-facing Markdown plan, spec, or document |

The workflow protocol in `TASK-MANAGEMENT.md` §20 defines the routing and durable
state semantics. A live activation settles through one mutually exclusive route:
explicit `workflow_next`, contextual `workflow_prev`, `workflow_fail`, the
specialized child-workflow `NEXT` route, or an implicit host-generated `NEXT` from
the final assistant message when the model ends without a disposition.

## 2. Removed protocol

The bridge no longer lists, grants, describes, parses, or routes agent calls that
create, release, delegate, wait for, continue, interrupt, cancel, seal, complete,
fail, question, answer, read generic task-tree status, or echo progress for an
ordinary child task. Calls using removed names, including `get_task_status` and
`report_progress`, return `unknown tool` before command dispatch even when a stale
credential happens to contain the old action.

Ordinary task/session records and transition helpers may remain inside `TaskEngine`
for persisted-state recovery and host-owned lifecycle operations. They are runtime
infrastructure, not an MCP contract and must not appear in agent instructions.

## 3. Capability projection

Each turn receives a short-lived bearer credential containing its allowed public
actions. `tools/list` intersects that grant with the exact public catalog:

- every task may receive the host-context tool;
- coordinators may receive presentation tools;
- `create_child` authorizes task-profile listing and workflow definition/start;
- `read_subtree` authorizes bounded `inspect_workflow_run` reads;
- a live workflow activation receives `workflow_next` and `workflow_fail`;
- `workflow_prev` is available only when the activation has direct dependencies;
- `invoke_child_workflow` requires its root/terminal coordinator and trust guards.

The engine revalidates durable activation state during execution. Credential claims
alone cannot authorize a contextual workflow disposition.

`inspect_workflow_run` accepts a `runId` returned by `start_workflow` or another
authorized workflow route. The repository requires that run to belong to the
credential's root task. Its bounded result contains run policy/status, node and gate
state, recoverable activations, active feedback rounds, continuations, integrity
diagnostics, and committed terminal artifact references. It never returns a generic
task tree, topology, prompts, artifact bodies, paths, or secrets and must not be used
as a polling loop.

`start_workflow` remains pending while its run is active. It returns only after the
run succeeds, fails, or is cancelled, with terminal status/reason and the committed
terminal `workflow_next` body when one exists. Repository commit notifications wake
the pending call; coordinators must not poll `inspect_workflow_run` for completion.
The same terminal transaction seals tasks owned by the run to the matching lifecycle
(`succeeded`, `failed`, or `cancelled`); the coordinator/caller task remains open.

## 4. Human input

Human input is outside the MCP bridge catalog:

- root agents use ACP RFD `elicitation/create` form or URL requests;
- Grok's vendor `x.ai/ask_user_question` maps through `AskBridge` to the webview;
- workflow nodes request producer correction with `workflow_prev`;
- the webview communicates with the extension host using `postMessage` and never
  calls MCP directly.

There is no MCP question or parent-answer tool.

## 5. Deployment

The extension hosts the authoritative HTTP MCP server on an ephemeral loopback port.
ACP agents receive only the Muster-owned stdio proxy through `session/new` or
`session/load`; the proxy connects upstream to the loopback bridge.

```text
CLI agent -> Muster stdio MCP proxy -> loopback HTTP bridge
                                      -> credential/catalog filter
                                      -> workflow command parser
                                      -> TaskEngine workflow runtime
```

The bridge URL and per-turn bearer token are passed to the proxy through environment
variables. Tokens never appear in argv, prompts, diagnostics, tool output, persisted
task state, or webview messages. Direct-HTTP ACP injection and the
`MUSTER_ACP_MCP_TRANSPORT` fallback are removed. See `MCP-INJECTION.md`.

## 6. Scope boundaries

`muster_bridge` stays intentionally small:

- semantic search and codebase graph traversal belong on `context_engine`;
- file editing, shell execution, web access, and LSP operations belong to CLI tools
  or purpose-built MCP servers;
- backend selection, session control, and user lifecycle decisions belong to the
  extension host and UI;
- workflow definitions use configured `muster.taskTypes` profiles instead of asking
  agents to invent backend/model routing.

Duplicating these capabilities would add prompt noise and recreate competing control
planes.

## 7. Security and lifecycle

- Bind the HTTP server to loopback only and reject non-loopback hosts/origins.
- Require a short-lived random bearer token for every MCP request.
- Scope tokens to root, caller task, turn, attempt, and allowed public actions.
- Revoke tokens on turn completion, cancellation, timeout, restart, and shutdown.
- Validate every tool input with a closed JSON schema and domain validation.
- Derive engine-owned run, activation, gate, round, artifact, and continuation IDs.
  Agents may pass a returned `runId` only to the read-only inspection tool; mutation
  tools never accept engine-owned routing identities.
- Keep presentation ownership and revision checks host-enforced.

## 8. Related documents

- `TASK-MANAGEMENT.md` - workflow domain model and protocol
- `MCP-INJECTION.md` - per-backend stdio proxy injection
- `DESIGN.md` - extension architecture
- `ADAPTER-SPEC.md` - normalized backend events and turn lifecycle
- `WEBVIEW.md` - extension/webview message protocol
