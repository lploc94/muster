# Muster Bridge MCP Server

This document is the authoritative design for the extension-owned MCP server
`muster_bridge`. The bridge exposes workflow orchestration and thin IDE integration;
it does not expose the legacy delegate-task protocol.

## 1. Public protocol

The public MCP catalog is exactly:

| Tool | Purpose |
|------|---------|
| `list_task_types` | Refresh semantic workflow-node profiles and diagnostics |
| `inspect_workflow_run` | Inspect semantic durable state for an owned workflow run |
| `get_host_context` | Refresh trusted host, self, profile, and role context |
| `define_workflow` | Save an engine-identified canonical workflow manifest or referenced saved workflow |
| `start_workflow` | Idempotently start a workflow, suspend the caller, and resume it with the terminal result |
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

The public boundary is semantic. Models provide definition-local node keys, configured
`taskType` values, named semantic workflow interfaces, dependency `inputRef` values,
disposition intent, and presentation content. The bridge derives operation slots,
workflow and presentation identities, immutable versions, normalized topology, entry
nodes, routing snapshots, capabilities, numeric policy, artifact pins, ownership, and
revisions.

`define_workflow` accepts exactly one of two closed forms:

- `{ "manifest": { ... } }` for an inline canonical manifest; or
- `{ "predefinedWorkflowRef": "pwf_<32 hex>" }` for a saved workflow that the host
  resolves and freezes authoritatively.

An inline manifest uses the literal schema `muster.workflow/v2`:

```json
{
  "manifest": {
    "schema": "muster.workflow/v2",
    "name": "Review flow",
    "description": "Research and review a request.",
    "inputs": [
      { "name": "request", "kind": "request", "to": "research", "inputRef": "request" }
    ],
    "outputs": [
      { "name": "review", "kind": "review", "from": "review" }
    ],
    "nodes": [
      {
        "nodeKey": "research",
        "taskType": "research",
        "title": "Research",
        "instructions": { "inline": "Investigate the request and report evidence." }
      },
      {
        "nodeKey": "review",
        "taskType": "review",
        "title": "Review",
        "outcome": {
          "kind": "agent",
          "requireExplicitDisposition": false,
          "next": { "when": "The review is complete." },
          "prev": [
            {
              "when": "The research needs correction.",
              "targets": ["research"],
              "feedback": "required"
            }
          ]
        }
      }
    ],
    "edges": [
      { "from": "research", "to": "review", "inputRef": "research" }
    ]
  }
}
```

The manifest and every nested object are closed. Unknown fields fail validation. Public
input `name` and output `name` are stable caller-facing interface names; input `to` and
`inputRef`, output `from`, node `nodeKey`, and edge `from`/`to`/`inputRef` describe the
semantic graph. Every input targets an entry node, every output names a terminal node,
and every terminal is exported exactly once. Duplicate semantic names, duplicate
consumer slots, cycles, fan-out, isolated nodes, and unexported terminals are rejected.

Agent nodes contain `taskType`; execute nodes contain `script`; the forms are mutually
exclusive. `title` is optional display metadata only and never becomes executable task
content. `instructions` is optional and contains exactly one of `inline` or `file`.
Inline manifests may use only `instructions.inline`. `instructions.file` is accepted
only while resolving a saved workflow package, where the host freezes the referenced
content before persistence. Frozen instructions enter a bounded host-owned workflow
instructions section on normal entry and dependency activations and are not exposed by
status or graph projections.

An agent `outcome` may be omitted for implicit NEXT. When present it must have
`kind: "agent"` and an explicit `requireExplicitDisposition` boolean; `false` requires a
declared `next` route. PREV targets are unique inbound `inputRef` values and require the
literal `feedback: "required"`. Execute nodes require a closed `kind: "exit"` outcome
that maps exit code `0` to NEXT and every nonzero exit to exactly PREV with
`feedback: "stdout"` or FAIL. NEXT carries bounded stdout as its result. PREV reaches
only its declared direct inbound `inputRef` targets and carries bounded stdout, or
deterministic host feedback naming the check and exit code when stdout is empty.
Stderr remains diagnostic-only; spawn, timeout, cancellation, integrity,
missing-exit-status, and output-bound failures remain operational failures.

The removed authoring fields `label`, edge `as`, start input coordinates, child
destination coordinates, and `onFailure` are invalid. Authors also cannot provide
backend, model, role, capabilities, effective policy, durable IDs, artifact coordinates,
or revisions.

Workflow graphs are converging DAGs. Independent source nodes may run in parallel and
fan in to a downstream node, but a node cannot fan out to multiple consumers. Cycles
are rejected and every non-terminal node has exactly one outgoing edge. For parallel
work, use `A -> C` and `B -> C` with the shared caller input declared separately on `A`
and `B`; do not add an intake node that routes to both.

The engine returns an immutable generated `workflowRef`, for example
`workflow-8f4c2a1b3d5e7f90123456789abcdef0@1`. Identity is derived from the owning root and
normalized semantic and frozen content. Object member order is not semantic, while
declared array order is preserved. Changing an interface name or kind, declared order,
outcome text, instruction digest, script digest, resolved profile, or effective policy
changes the fingerprint. Models must retain the returned reference and pass it to
`start_workflow` or `invoke_child_workflow` rather than inventing a storage key. The
complete generated ID and positive `@version` suffix are required; bare IDs and
caller-named versioned keys are rejected.

```json
{
  "workflow": "workflow-8f4c2a1b3d5e7f90123456789abcdef0@1",
  "goal": "Review the subsystem",
  "inputs": [
    { "name": "request", "value": "Inspect routing" }
  ]
}
```

Each `start_workflow` input uses exactly one of these public named forms:

```json
{ "name": "request", "value": "Inspect routing" }
```

```json
{ "name": "plan", "fromRun": "run-ref", "output": "verifiedPlan" }
```

The host resolves each public input name through the frozen definition. A prior-run
binding retains both the source run and selected named output for authoritative atomic
resolution. Internal entry-node coordinates, artifact fields, task/backend selection,
and policy are not public start inputs. The run `goal` remains the task objective; node
instructions augment that objective without replacing it.

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

`inspect_workflow_run` accepts a `runRef` returned by `start_workflow` or another
authorized workflow route. The repository requires that run to belong to the
credential's root task. Its bounded result contains workflow status, semantic node
state, recoverable activation state, feedback progress, child state, and integrity
diagnostic codes. A succeeded materialized node includes an opaque `taskRef`; together
with the response `runRef` and node name, that is the exact source execution accepted by
`start_workflow` reuse. It never returns policy budgets, gate/activation/round/
continuation IDs, artifact coordinates, a generic task tree, topology, prompts, artifact
bodies, paths, or secrets and must not be used as a polling loop.

`start_workflow` returns a successful `accepted` result only after the run and a
top-level `start_wait` continuation are durable. After that successful tool result is
delivered, the host settles the current caller turn without asking the model to wait.
The transcript shows `Workflow dispatched. Waiting for results...` for this technical
suspension and suppresses backend cancellation text such as `Conversation interrupted`.
When the run succeeds, fails, or is cancelled, the repository atomically resolves the
continuation and queues one deterministic engine turn on the caller with terminal
status/reason and the committed terminal `workflow_next` body when one exists. Reload
drains the same resolver, so a terminal result cannot be lost or resumed twice.
Coordinators must not poll `inspect_workflow_run` for normal completion. Invalid or
unauthorized starts return ordinary tool errors and do not suspend the caller. A live
workflow activation must use `invoke_child_workflow` rather than `start_workflow`.
The terminal transaction seals tasks owned by the run to the matching lifecycle
(`succeeded`, `failed`, or `cancelled`); the coordinator/caller task remains open.

`invoke_child_workflow` accepts a returned workflow reference and semantic bindings from
the current activation's named inputs. The repository resolves each source to an
authorized immutable artifact revision before staging the child route. Artifact IDs
and revisions, operation IDs, and idempotency keys are never model inputs.

```json
{
  "workflow": "workflow-8f4c2a1b3d5e7f90123456789abcdef0@1",
  "inputs": [
    { "name": "request", "fromInput": "research" }
  ]
}
```

`name` is the child definition's public input name. `fromInput` is an `inputRef` on the
current live parent activation. Child node IDs and destination input coordinates are
never accepted.

`upsert_presentation` accepts `title`, `markdown`, optional display metadata, and an
optional `presentationRef` returned by an earlier call when refreshing that document.
For a new document the host derives the root-scoped presentation ID, returns its ref,
allocates revisions, and treats identical content as an idempotent replay.

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
- Derive engine-owned operation, run, activation, gate, round, artifact, continuation,
  presentation, ownership, and revision identities. Agents may pass a returned
  `runRef` only to the read-only inspection tool, a returned `workflowRef` to
  workflow start/child calls, and a returned `presentationRef` to refresh that
  document. A refresh ref must already exist for the authenticated owner; an unknown
  ref cannot create a caller-named document. Mutation tools never accept internal
  routing coordinates.
- Keep resolved workflow policy and task-type routing frozen in each immutable
  definition so extension upgrades cannot reinterpret an existing revision.

## 8. Related documents

- `TASK-MANAGEMENT.md` - workflow domain model and protocol
- `MCP-INJECTION.md` - per-backend stdio proxy injection
- `DESIGN.md` - extension architecture
- `ADAPTER-SPEC.md` - normalized backend events and turn lifecycle
- `WEBVIEW.md` - extension/webview message protocol
