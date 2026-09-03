# Workflow Definition V2 and Outcome Routing - Design

**Status:** Proposed design; implementation plan pending

**Scope:** Define a deterministic, reusable workflow package format that runs on
Muster's existing durable task engine and NEXT/PREV/FAIL routing system.

## 1. Problem

Muster already executes frozen workflow DAGs as durable tasks. A node publishes
its result with NEXT, asks direct producers for corrections with PREV, or closes
the run with FAIL. Dependency gates, feedback rounds, artifact revisions, and
continuations are durable engine state.

The current authoring contract does not describe that model clearly:

- saved workflows are Markdown prose that a coordinator compiles into a graph;
- public inputs expose internal entry-node bindings rather than a stable workflow
  interface;
- workflows do not advertise named semantic outputs for composition;
- `label` serves as both display text and long node instructions;
- verifier behavior is implicit in prose rather than represented as an outcome
  contract; and
- script failures can continue or fail the run, but cannot request contextual
  correction through PREV.

The result is a mismatch between how workflows are authored and how the runtime
actually operates.

## 2. Goals

- Make a strict JSON manifest the source of truth for new workflow definitions.
- Keep Markdown for bounded human/agent instructions without making prose the
  authority for topology.
- Give each workflow a named semantic input and output interface.
- Represent author-defined decision gates as node outcome contracts.
- Keep physical dependency gates and feedback rounds engine-owned.
- Require explicit agent disposition; text-only completion enters bounded decision repair.
- Repair missing or invalid required dispositions before failing a workflow.
- Let deterministic execute nodes map successful checks to NEXT and failed checks
  to PREV.
- Preserve the existing task engine, repository routing, idempotency, bounds, and
  frozen-definition guarantees.

## 3. Non-goals

- A separate workflow engine or hidden post-node executor.
- Author-controlled gate IDs, gate state, fills, artifact revisions, task IDs, or
  activation IDs.
- Runtime graph mutation, fan-out, cycles, arbitrary jumps, or PREV to a
  non-producer node.
- ANY/quorum/conditional dependency joins in v2. Dependency joins remain ALL.
- Proving that an agent's natural-language decision condition is objectively true.
- General JSON Schema payloads, kind subtyping, automatic converters, or MIME
  negotiation. V2 semantic kinds compare by exact string equality.
- Treating a normal verifier rejection as a failed workflow.

## 4. Existing Runtime Model

Workflow v2 is a new authoring and semantic contract over the existing runtime:

```text
Coordinator
  -> chooses a workflow
  -> binds named inputs to entry nodes

Entry/dependency gate becomes satisfied
  -> engine activates a normal durable task node

Node NEXT
  -> engine writes a new result artifact revision
  -> fills the downstream dependency gate
  -> activates the consumer when all inputs are satisfied

Consumer PREV
  -> engine resolves direct producers from inbound inputRefs
  -> opens a durable ALL-join feedback round
  -> appends one correction turn to each selected producer task
  -> resumes the consumer after all selected producers NEXT revised artifacts

Node FAIL
  -> engine closes the run and outstanding workflow state
```

PREV does not rewind a task or create a graph cycle. It appends a new turn to an
existing producer task. A producer can itself PREV its direct producers, so
correction may cascade backwards through the DAG while topology stays acyclic.

## 5. Two Meanings of Gate

The design uses separate terms for two different concepts.

### 5.1 Dependency gate

A dependency gate is engine-derived synchronization state. Edges and their
destination `inputRef` values are the complete author-level declaration. The
engine derives:

- one gate per node;
- required inbound bindings;
- ALL-join readiness;
- gate IDs and statuses;
- fills and artifact coordinates; and
- whether contextual PREV is available.

Workflow authors never declare physical dependency gates.

### 5.2 Decision gate

A decision gate is an author-defined outcome contract on a node. It describes
when the node should choose NEXT, PREV, or FAIL.

The JSON field is named `outcome` to avoid collision with durable dependency
gate terminology. Product UI may label it "Decision gate".

An outcome belongs to a node. If evaluation requires separate work, that work is
an ordinary agent or execute node with its own outcome. There is no invisible
gate execution outside the task graph.

## 6. Author Package

New saved workflows use a bundle with one authoritative manifest:

```text
plan-and-verify/
|-- workflow.json
|-- prompts/
|   |-- planner.md
|   `-- verifier.md
`-- scripts/
    `-- optional-check.js
```

`workflow.json` owns metadata, interfaces, nodes, edges, and outcomes. Markdown
files are optional package-relative instruction assets referenced by the
manifest. They cannot override manifest semantics.

The host resolves instruction and script files within the frozen package root,
applies containment and size checks, records content digests, and freezes their
exact content at definition time. Runtime activation never reinterprets Markdown
structure or silently reads a changed prompt file.

Legacy flat Markdown workflows remain discoverable as a compatibility form.
They continue through the legacy coordinator compilation path or conservative
one-node fallback, but do not advertise a v2 reusable interface until migrated.

## 7. Manifest Shape

```json
{
  "schema": "muster.workflow/v2",
  "name": "Plan and verify",
  "description": "Create and verify an implementation plan.",

  "inputs": [
    {
      "name": "request",
      "kind": "request",
      "to": "planner",
      "inputRef": "request"
    }
  ],

  "outputs": [
    {
      "name": "verifiedPlan",
      "kind": "plan",
      "from": "verifier"
    }
  ],

  "nodes": [
    {
      "nodeKey": "planner",
      "taskType": "planner",
      "title": "Create plan",
      "instructions": {
        "file": "prompts/planner.md"
      }
    },
    {
      "nodeKey": "verifier",
      "taskType": "reviewer",
      "title": "Verify plan",
      "instructions": {
        "file": "prompts/verifier.md"
      },
      "outcome": {
        "kind": "agent",
        "requireExplicitDisposition": true,
        "next": {
          "when": "No actionable findings remain and the plan is ready to use."
        },
        "prev": [
          {
            "when": "The plan contains actionable findings that the planner can correct.",
            "targets": ["plan"],
            "feedback": "required"
          }
        ],
        "fail": {
          "when": "The plan cannot be evaluated or produced after bounded correction attempts."
        }
      }
    }
  ],

  "edges": [
    {
      "from": "planner",
      "to": "verifier",
      "inputRef": "plan"
    }
  ]
}
```

The manifest is a closed, versioned shape. Unknown fields fail validation.

## 8. Workflow Interface

### 8.1 Inputs

Each input separates its public workflow name from its internal entry binding:

```json
{
  "name": "request",
  "kind": "request",
  "to": "planner",
  "inputRef": "request"
}
```

- `name` is the stable name used by callers.
- `kind` is the semantic artifact kind used for composition checks.
- `to` must identify a derived entry node.
- `inputRef` is the destination slot inside that entry node.

The engine normalizes the value to the existing `workflow_input` transport
artifact kind. Semantic kind and transport kind are deliberately separate.

### 8.2 Outputs

Each output names one node result. The source may be a terminal node or a
nonterminal checkpoint:

```json
{
  "name": "verifiedPlan",
  "kind": "plan",
  "from": "verifier"
}
```

- `name` is the stable name used by downstream callers.
- `kind` is the semantic artifact kind.
- `from` must identify exactly one node in the same topology.

The node still commits an ordinary `next_result` transport artifact. The output
contract annotates what that artifact means; it does not change NEXT settlement.

Every node must be exported exactly once in v2. A terminal source is a
completion output; a nonterminal source is a stable checkpoint. A checkpoint
does not add an edge, make a node terminal, or alter NEXT/PREV/FAIL routing.
The public name and semantic kind are the only caller-visible authority; task,
gate, turn, artifact, and revision identities remain engine-owned.

The normalized authority uses `sourceNodeId` for this field. `role` is derived
from the frozen topology (`terminal` when the source has no outgoing edge,
otherwise `checkpoint`) whenever an interface is projected. Authors cannot
provide or override that role.

### 8.3 Run-scoped composite assembly

A composite is a closed start request, not a reusable definition or package. Its
normalized form is:

```json
{
  "components": [
    { "key": "draft", "workflow": "workflow-ref@3" },
    { "key": "check", "manifest": { "schema": "muster.workflow/v2", "...": "one node" } }
  ],
  "connections": [
    { "from": { "component": "draft", "output": "result" },
      "to": { "component": "check", "input": "draft" } }
  ],
  "inputs": [
    { "name": "request", "to": { "component": "draft", "input": "request" } }
  ],
  "outputs": [
    { "name": "checked", "from": { "component": "check", "output": "result" } }
  ]
}
```

The exact structural rules are:

- `components` is an ordered nonempty array. Each component has one unique,
  bounded stable `key` and exactly one source: an immutable versioned workflow
  reference or an inline canonical manifest containing exactly one node.
- A component reference is already authorized/frozen host authority. A mutable
  `predefinedWorkflowRef`, a recursive composite, an unversioned reference, and
  any author-supplied definition/runtime coordinates are invalid.
- `connections` use only `{ from: { component, output }, to: { component,
  input } }`. `inputs` and `outputs` use unique bounded public names and one
  component slot each. Mapping objects do not repeat semantic kinds; kinds are
  read from the referenced component authority and must match exactly.
- Every component input is satisfied exactly once by one connection or one
  composite input. Every component output is exported exactly once by one
  composite output, even when it also feeds another component. There is no
  automatic source selection, implicit input, converter, subtype, fan-out, or
  conditional join.
- Component-local node IDs are rewritten to deterministic collision-proof
  internal IDs. The normalized authority retains safe `(componentKey,
  localNodeKey)` metadata for projections and failure reports, never physical
  task or artifact coordinates.
- Expansion rewrites edges and interface mappings into one ordinary topology,
  then reuses the canonical graph validators for bounds, reachability,
  acyclicity, no fan-out, entry-only external inputs, and complete all-node
  output coverage. Expansion happens before any persistence and creates no
  `workflow_definitions` row.

The composite status remains the ordinary run status: `running` until all
terminal branches settle, `succeeded` only when every terminal completion path
settles successfully, and `failed`/`cancelled` when the existing fail-fast or
cancellation rules close the run. Checkpoints may be available while a run is
still progressing, but their existence never changes terminal completion.

Composition uses named interfaces:

```json
{
  "name": "plan",
  "fromRun": "run-ref",
  "output": "verifiedPlan"
}
```

The durable start request carries both `fromRun` and `output`. The repository
resolves the selected output inside the atomic start transaction; coordinator or
host pre-resolution is not authoritative. Resolution must:

- authorize and require a succeeded source run;
- load that run's frozen output contract by output name;
- identify the declared terminal node's exact `next_result` artifact and revision,
  rather than the run-level aggregate used by legacy multi-sink completion;
- compare the source and destination semantic kinds exactly;
- pin/adapt that artifact and fill the destination entry gate atomically; and
- include the output name in the durable start fingerprint.

Only the final artifact-to-`workflow_input` adaptation and gate-fill mechanics are
reused from the existing prior-run path. Selecting a named terminal output is new
durable start semantics, not a host-side wrapper around the legacy aggregate.

## 9. Node Definition

An agent node declares a configured task type. An execute node declares a
bounded script execution specification. These remain mutually exclusive.

The current overloaded `label` field is split into:

- `title`: optional short display text; and
- `instructions`: optional bounded executable task content.

Instructions are exactly one of:

```json
{ "inline": "Bounded instructions for an ad-hoc definition." }
```

or:

```json
{ "file": "prompts/verifier.md" }
```

Package-relative files are available only to saved packages. The host resolves
and freezes them before definition persistence. Prompt bodies stay out of graph
status projections and agent-visible topology inspection.

## 10. Agent Outcome Contract

An agent outcome presents each possible disposition beside its own condition:

```json
{
  "kind": "agent",
  "requireExplicitDisposition": true,
  "next": {
    "when": "No actionable findings remain."
  },
  "prev": [
    {
      "when": "The plan has actionable findings.",
      "targets": ["plan"],
      "feedback": "required"
    }
  ],
  "fail": {
    "when": "Verification cannot be completed."
  }
}
```

Conditions are separate rather than one shared criteria paragraph. This reduces
the model's need to infer which condition belongs to which action.

`prev` is an array because a fan-in verifier may have different correction
conditions and target sets. Every target is an inbound `inputRef` on that exact
node, never a node ID. Every agent PREV route must contain the literal
`feedback: "required"`; there is no feedback-optional agent PREV in v2. Before a
PREV disposition claim is staged, the host rejects empty, whitespace-only, or
over-bound feedback. The host can enforce bounded nonempty feedback but cannot
prove that its content is semantically useful.

The host renders the contract explicitly instead of relying on raw JSON:

```text
# Outcome contract

NEXT
Use workflow_next when:
No actionable findings remain.

PREV ["plan"]
Use workflow_prev with targets ["plan"] when:
The plan has actionable findings.
Include concrete feedback explaining what must be corrected.

FAIL
Use workflow_fail when:
Verification cannot be completed.

Explicit disposition is required.
```

The condition text is untrusted workflow content. It guides the agent but does
not become host policy. The host can enforce declared routes and target sets; it
cannot prove that the natural-language condition was evaluated correctly.

## 11. Explicit Disposition and Fail-Closed Outcomes

Every accepted agent node uses literal `requireExplicitDisposition: true` with
declared NEXT and FAIL routes. A missing disposition is protocol evidence and never
becomes semantic success through assistant prose.

### 11.1 Mandatory agent outcome

- Static validation rejects omitted outcomes, `false`, missing NEXT, missing FAIL,
  empty/unbounded conditions, and `policy.failWorkflow: false`.
- A valid explicit NEXT/PREV/FAIL is committed normally.
- `workflow_fail` is the single machine-level failure action. Its reason is
  required, nonblank, and bounded; a valid first claim closes immediately as
  `agent_fail`.
- Assistant wording, sentiment, language, and refusal-like phrases are never
  parsed as a route or failure category.

### 11.2 Missing and invalid decisions

- The agent must call one declared disposition.
- A missing or invalid disposition does not fail the run immediately.
- The engine appends a bounded correction turn to the same node and backend
  session with the prior response still in context.
- The correction identifies the exact error, repeats the outcome contract, and
  asks the agent to select one route.
- The effective host policy permits at most three decision attempts, including
  the original attempt.
- Only after the third invalid/missing decision does the run fail with a bounded
  routing reason such as `decision_missing` or `decision_invalid`.

Example correction:

```text
# Workflow outcome required

Your previous response did not select a workflow outcome.
Call exactly one declared NEXT, PREV, or FAIL disposition.

This is decision attempt 2 of 3.
Do not repeat the full analysis unless needed. Select an outcome now.
```

The repair is a durable engine continuation on the same task. It is not PREV and
does not open a feedback round. Missing disposition is a protocol omission by
the current node, not evidence that a producer must redo its work. A text-only refusal
therefore follows exactly the same bounded `decision_missing` path as neutral or
multilingual text; no wording inspection is performed.

Invalid cases eligible for bounded repair include:

- no disposition when explicit disposition is required;
- PREV to an undeclared or non-inbound `inputRef`;
- PREV with empty, whitespace-only, or over-bound feedback; and
- a disposition not declared by the outcome contract.

Outcome authorization and PREV feedback validation happen before the existing
disposition claim is staged. One decision attempt is one completed agent turn. If
a valid disposition claim was accepted, that first accepted claim remains
authoritative and the turn settles normally; later or concurrent calls cannot
reclassify it as a repair attempt. Only a completed turn with no valid claim may
be classified from durable missing/invalid-call evidence as `decision_missing` or
`decision_invalid`.

### 11.3 Typed backend refusal

An ACP `stopReason: "refusal"` is machine evidence, not assistant prose. When no
valid disposition claim has already won, the engine persists `backend_refusal`,
records the latest nonempty persisted assistant response (or a fixed host fallback),
and atomically closes the workflow activation/run as `agent_fail`. It queues no
correction, generic retry, or runtime fallback. Ordinary tasks and non-refusal
provider/transport errors retain their existing recovery paths.

### 11.4 Bounded workflow failure detail

Every failed or cancelled workflow run retains one validated bounded
`WorkflowFailureDetail` in its deterministic `run_closure` envelope:

```text
schemaVersion
source = workflow_fail | backend_refusal | decision_exhausted | engine
code
node = { key, title? }          # omitted when no node is responsible
report = { text, truncated }
attempt = { number, limit }?   # only for decision exhaustion
```

The node identity is semantic and comes from frozen workflow authority. Report
text is copied from the accepted tool reason or the identified persisted assistant
response, trimmed at its outer boundary and UTF-8 bounded without splitting code
points. Missing text receives a fixed host explanation. Physical IDs, prompt/script/
artifact bodies, paths, credentials, raw errors, and SQL are invalid detail fields.

The owning root receives the same validated detail through `start_wait` and
same-root inspection with an explicit warning that the report is untrusted node
evidence. It can explain the report or choose a next action, but the report never
authorizes routing, mutation, or execution. Malformed or mismatched stored detail
falls back to a fixed bounded unavailable diagnostic and never leaks raw payload.

### 11.5 Durable decision-repair state

Decision repair is owned by one logical workflow activation, not by the task or
the whole run. Each activation with an agent outcome has a durable repair record
equivalent to:

```text
runId
activationId
status = open | decided | exhausted
attemptsUsed
lastAttemptTurnId
lastErrorCode
lastResponseMessageId
nextRepairTurnId
```

The original activation turn is decision attempt 1. Repair turn IDs, input
message IDs, and idempotency fences are derived deterministically from the
activation ID and next attempt number.

A dedicated repository transition atomically performs exactly one of these
outcomes when an attempt finishes:

1. A valid staged disposition settles through the existing NEXT/PREV/FAIL path,
   marks the repair record `decided`, and consumes the activation.
2. A missing/invalid decision below the attempt limit settles the attempt turn,
   persists its bounded final assistant response and error evidence, increments
   `attemptsUsed`, queues one deterministic correction turn, and leaves the
   logical activation open.
3. A missing/invalid decision at attempt three marks the record `exhausted`,
   consumes/closes the activation, and atomically applies bounded workflow failure.

The missing/invalid branches never inject an implicit NEXT before normal workflow
settlement. No successfully routed activation is reopened, and no missing
activation is marked consumed before a valid route or exhaustion.
Transaction replay is a no-op through the deterministic fence, so a crash cannot
lose or duplicate a repair turn.

Every attempt consumes the existing per-task and per-run workflow turn budgets.
The transition reserves the next turn before queueing it. If host-clamped turn or
run-time budgets cannot admit another decision attempt, it closes through the
existing bounded budget-failure path rather than exceeding those limits. A fresh
dependency-gate, feedback-resume, or child-return activation starts its own repair
record at attempt 1; attempts never leak between activations.

The bounded final assistant response from each failed decision attempt is durable
repair input, referenced by `lastResponseMessageId`. Resuming the committed backend
session is preferred. If session load fails or reload requires a fresh session,
prompt reconstruction injects the same bounded prior response plus the correction
contract, preserving equivalent decision context without depending on backend
session survival.

## 12. Execute Outcome Contract

An execute node uses machine-evaluable conditions:

```json
{
  "nodeKey": "test",
  "title": "Run acceptance tests",
  "script": {
    "interpreter": "node",
    "file": "scripts/test.js",
    "args": []
  },
  "outcome": {
    "kind": "exit",
    "next": {
      "when": { "exitCode": 0 }
    },
    "prev": {
      "when": { "exitCode": "nonzero" },
      "targets": ["implementation"],
      "feedback": "stdout"
    }
  }
}
```

The host runs the existing node script exactly once per activation and maps its
numeric exit result to an existing disposition:

- exit `0` -> NEXT with bounded stdout as the result;
- nonzero exit -> PREV with bounded stdout as correction feedback; or
- nonzero exit -> FAIL when the manifest declares a fail mapping instead.

When a nonzero -> PREV mapping produces no stdout, the host synthesizes bounded
feedback containing the failed check and exit code. PREV never reaches a producer
without actionable feedback merely because the executable emitted an empty body.

Spawn failures, timeouts, cancellation, integrity failures, missing exit status,
and output-bound violations are operational failures. They follow engine safety
and retry policy and cannot be reclassified as normal PREV merely by declaring a
nonzero mapping. Stderr remains diagnostic-only.

V2 initially supports only zero/nonzero conditions. Exact exit-code tables,
signals, stdout parsing, JSON predicates, and an additional hidden gate command
are deferred.

## 13. Routing Semantics

Outcome routes name dispositions, not graph destinations:

- NEXT contains no `to`; the sole outgoing edge or terminal status determines
  where the result goes.
- PREV names one or more inbound `inputRef` values; the frozen dependency binding
  resolves each direct producer.
- FAIL contains no destination; it closes the run.

This avoids duplicating topology inside outcomes. The existing repository remains
the authority for NEXT contribution, PREV feedback rounds, ALL-join resume, and
FAIL closure.

A canonical correction loop is:

```text
planner NEXT plan-v1
  -> verifier activates

verifier PREV ["plan"] with findings
  -> planner receives a correction turn

planner NEXT plan-v2
  -> feedback round becomes satisfied
  -> verifier receives a resume turn

verifier NEXT verified-plan
  -> terminal output becomes available to the coordinator
```

## 14. Validation

JSON Schema validates the closed structural shape. Domain validation additionally
enforces:

- unique bounded workflow, node, input, output, and `inputRef` names;
- exactly one of task type or script execution per node;
- exactly one of inline or file instructions;
- existing node, edge, graph-size, acyclicity, reachability, and no-fan-out rules;
- unique destination `inputRef` per consumer;
- workflow inputs bind only derived entry nodes;
- workflow outputs reference known nodes;
- every node is exported exactly once, with terminal/checkpoint role derived from
  topology;
- exact semantic-kind equality for composition;
- agent outcomes appear only on agent nodes;
- exit outcomes appear only on execute nodes;
- every PREV target is a unique inbound `inputRef` of the declaring node;
- every agent PREV route contains `feedback: "required"`;
- staged agent PREV feedback is trimmed, nonempty, and within the existing bound;
- entry nodes cannot declare PREV because caller inputs have no workflow producer;
- every agent outcome uses literal `requireExplicitDisposition: true` and declares NEXT and FAIL;
- nonempty bounded `when` text for every declared agent route;
- required zero and nonzero coverage for an exit outcome;
- no NEXT destination, PREV node ID, or FAIL target; and
- no author-supplied physical identity, state, effective host policy, backend,
  model, role, capability, artifact coordinate, or revision.

Natural-language conditions may overlap or be incomplete. That is an authoring
quality issue the host cannot decide mechanically. Required-disposition repair
reduces protocol omissions but does not turn an agent gate into a deterministic
proof.

## 15. Definition and Start Boundaries

`define_workflow` supports two mutually exclusive v2 forms:

- ad hoc: an inline closed v2 semantic manifest; or
- saved package: only `predefinedWorkflowRef`, with the host loading and freezing
  the authoritative `workflow.json` identified by that ref.

The coordinator does not echo or reconstruct a saved package's topology. This
makes a saved workflow an actual frozen strategy rather than prose interpreted
differently on each use.

Both definition and start authority are root-only. Only an open top-level root
coordinator outside a workflow activation may define or start a workflow.
Workflow nodes may use ordinary child-task delegation when their task profile
allows it, but there is no workflow-to-workflow invocation, child workflow run,
or hidden orchestration branch. A composite is assembled by the owning root as
one run-scoped graph and is never published as a reusable definition or package.

`start_workflow` accepts public input names rather than node coordinates:

```json
{
  "workflow": "workflow-ref",
  "inputs": [
    { "name": "request", "value": "Investigate the failing checkout." }
  ]
}
```

or a prior named output:

```json
{
  "workflow": "workflow-ref",
  "inputs": [
    {
      "name": "plan",
      "fromRun": "prior-run-ref",
      "output": "verifiedPlan"
    }
  ]
}
```

The host resolves the destination public input name to its frozen entry contract.
For literal values it invokes the existing durable start binding. For a prior-run
value it carries `(fromRun, outputName)` into the durable start command; the
repository resolves the exact frozen source output artifact and semantic kind in
the same transaction that creates/fills the new run. `fromRun` plus `outputName`
participate in start identity and fingerprinting, so two selected outputs cannot
idempotently alias one start.

## 16. Normalization, Identity, and Persistence

V2 JSON is parsed into one normalized semantic definition before deriving a
definition ID or fingerprint.

- Object member order is not semantic and is canonicalized.
- Node, edge, input, output, PREV-route, and target order is preserved where it
  affects prompt presentation or aggregate ordering.
- Prompt/script content digests and normalized outcomes participate in the v2
  fingerprint.
- Schema selection chooses the decoder; it does not silently reinterpret stored
  v1 definitions.
- Existing v1 fingerprints and durable rows are never recomputed as v2.

The normalized internal definition freezes:

- topology and entry contracts;
- semantic input/output contracts;
- transport artifact kinds (`workflow_input` and `next_result`);
- node title and instruction references/digests;
- agent or exit outcome policy;
- resolved task profiles and executable provenance; and
- effective host-clamped resource policy.

For a run-scoped composite, the normalized authority additionally freezes the
ordered component keys and immutable source fingerprints, the exact interface
mappings, collision-proof flattened topology, component/local provenance, and
the pre-host reduced policy. These values are part of the composite fingerprint
and cannot be reconstructed from mutable catalog sources after the run starts.

V2 durable start inputs preserve a named prior-output reference until atomic
repository resolution. They do not collapse it to the legacy run-level terminal
aggregate before persistence or fingerprinting.

Physical gates, fills, feedback rounds, continuations, tasks, turns, messages,
artifacts, revisions, decision-repair records, and idempotency fences remain
run-time repository records.

## 17. UI Semantics

Normal correction is not workflow failure.

- PREV displays as waiting for or performing revision.
- An open feedback round displays the requester as waiting for feedback.
- A missing/invalid required disposition displays "Waiting for workflow
  decision" or "Correcting workflow route", with `attempt N of 3`.
- The node/run displays Failed only after repair attempts are exhausted or an
  actual semantic/operational failure closes the run.
- A decision gate may be indicated on a graph node, but it is not rendered as an
  additional hidden node.

Catalog and workflow details may later show named inputs, outputs, semantic kinds,
and whether a node requires an explicit disposition. Those surfaces do not
receive prompt bodies or host paths.

## 18. Compatibility

- Definitions without an agent `outcome`, optional outcomes, missing NEXT/FAIL, or
  `requireExplicitDisposition: false` are rejected by the V2 decoder; no implicit-NEXT
  compatibility path is retained.
- V2 agent outcomes require literal `requireExplicitDisposition: true`, declared NEXT,
  and declared FAIL.
- Legacy script `onFailure: "fail_run"` remains nonzero -> FAIL.
- Legacy script `onFailure: "continue"` remains nonzero -> NEXT.
- Legacy edge `as`, entry input `name`, and node `label` are decoded only through
  the v1 compatibility path and normalized without changing v1 fingerprints.
- Legacy Markdown catalog entries remain available until explicitly migrated.
- Existing durable NEXT/PREV/FAIL settlement and feedback-round semantics remain
  unchanged.

## 19. Implementation Workstreams

The later implementation plan should separate these workstreams:

1. V2 manifest types, closed parser, domain validation, and normalization.
2. Package discovery for `workflow.json` and frozen prompt assets.
3. Named semantic interfaces and atomic prior-run named-output resolution,
   retention/pinning, and start fingerprinting.
4. Definition/start tool changes with v1 compatibility.
5. Agent outcome rendering, pre-claim route authorization, atomic activation-owned
   repair state, and durable bounded decision repair turns.
6. Execute zero/nonzero outcome mapping to existing dispositions.
7. Persistence, fingerprinting, inspection, and reclamation updates.
8. Catalog/run graph/UI projections without prompt or path leakage.
9. Unit, repository, reload, recovery, packaged-host, and end-to-end tests.
10. Migration documentation and builtin workflow packages.

Mandatory repair tests cover transaction replay at every boundary, crash/reload
between attempts, failed backend-session reload with fresh-session context
reconstruction, first-valid-disposition wins, invalid target/empty feedback repair,
attempt exhaustion, and interaction with task/run turn budgets. Named composition
tests cover selecting each output of a multi-sink run, output-name fingerprint
conflicts, semantic-kind mismatch, source retention/reclamation races, and atomic
gate fill from the selected terminal artifact rather than the legacy aggregate.

## 20. Deferred Extensions

- Flat `.workflow.json` packages in addition to the canonical bundle layout.
- JSON Schema or richer payload contracts for semantic kinds.
- Semantic-kind registries, subtyping, and converters.
- Conditional, ANY, quorum, or failure-tolerant dependency joins.
- Exact exit-code tables, signals, or structured stdout predicates.
- Per-package trust UI beyond existing workspace and host-run authorization.
- Visual workflow authoring and generated manifests for legacy Markdown.

## 21. Decision Summary

- Workflow v2 is strict JSON; Markdown is a referenced instruction asset.
- Edges plus `inputRef` define dependency semantics; physical gates stay internal.
- Named inputs and all-node outputs provide a stable composition interface;
  terminal outputs complete a run and nonterminal outputs are checkpoints.
- Run-scoped composites flatten immutable saved references and inline one-node
  manifests into one ordinary graph; they are never reusable definitions.
- Node decision gates are authored as `outcome` contracts.
- Agent routes carry separate NEXT, PREV, and FAIL conditions.
- Execute routes use deterministic zero/nonzero conditions.
- `requireExplicitDisposition: true` performs bounded same-node decision repair
  and fails only after three unsuccessful decision attempts; there is no implicit NEXT.
- Typed ACP refusal closes the workflow immediately as `agent_fail` with bounded
  `backend_refusal` evidence and no generic retry/fallback.
- Missing disposition never triggers PREV automatically.
- PREV is reserved for an actual decision that direct producer work needs revision.
- No separate workflow runtime is introduced.
- Workflow orchestration is root-only; workflow activations cannot invoke another
  workflow or create a child workflow run.

## References

- [Muster workflows](../MUSTER-WORKFLOWS.md)
- [Task and workflow domain](../TASK-MANAGEMENT.md)
- [Muster bridge contract](../MUSTER-BRIDGE.md)
- [Workflow catalog surface design](2026-08-29-workflow-catalog-surface-design.md)
