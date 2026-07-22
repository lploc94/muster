# M018 Section 20 Full-Conformance Remediation Plan

Status: implemented; independent final review APPROVE
Normative source: `docs/TASK-MANAGEMENT.md` section 20  
Target branch: `feat/m018-gate-routed-agent-workflows`  
Scope: workflow definitions, starts, NEXT/PREV/FAIL routing, child workflows, persistence, scheduling, recovery, cancellation, budgets, authorization, and projections

Executable traceability table: `src/task/m018-section20-traceability.ts`

### Implementation Progress

Completed across the current conformance slices:

- Added the executable requirement-to-test traceability table and coverage guard.
- Added relational workflow authority primitives.
- Added durable universal disposition claims with cross-family exclusion, replay/conflict behavior, and consumed/discarded settlement state.
- Added relational backend-session ownership and active task/epoch bindings with fail-closed projection checks.
- Added logical activation rows for entry, dependency-gate, and feedback-resume turns plus scheduler and SQL terminal-run guards.
- Fixed top-level one-node terminal `NEXT`.
- Moved dependency and feedback aggregate construction into the SQLite settlement transaction and corrected feedback `satisfied -> consumed` timing.
- Replaced the internal fourth child-invocation outcome with a `workflow_next` child route while retaining `invoke_child_workflow` only as the public command name.
- Made workflow mutation capabilities contextual to a live durable activation and added execution-time plus SQLite staging authorization guards.
- Added root and workflow-node child callers, dedicated relational return gates, typed continuation results, caller-chain failure/cancellation propagation, and reload-safe single resume.
- Made child bindings name the exact child entry node, input ref, artifact lineage, and artifact revision; staging now rejects missing definitions, foreign scope, stale pins, kind mismatches, and incomplete contract coverage before writing a disposition claim.
- Routed multi-entry child bindings into their named entry gates and generated one exact per-entry aggregate rather than pinning every input to the primary entry.
- Added public top-level and child-start checks for workspace trust, frozen root scope, task-type resolution, backend availability/MCP support, models, role/capability requirements, depth/count capacity, and host-clamped effective run limits before any start mutation.
- Applied host-policy requirement validation to workflow definition persistence before any definition row is written.
- Added transaction-time retention pins for active workflow tasks, recoverable activations, open/satisfied gates and rounds, pending/resolved continuations, caller/child return evidence, staged dispositions, immutable artifact provenance, and their turn-scoped operation records.
- Enforced exact UTF-8 aggregate limits for dependency fan-in and feedback joins inside the settlement transaction and for child returns against the frozen caller/child policy; exact-limit aggregates queue once, while one-byte overflow records `aggregate_too_large`, closes the run, and creates no destination activation.
- Added one canonical length-framed entry aggregate encoder, exact worst-case definition validation for contracted and engine-start entries, and deterministic `aggregate_too_large` caller closure when a child effective policy cannot bound its entry framing.
- Added deterministic feedback-request and resume activations, stable relational target/base/response pins, inherited outer response authority, and relational aggregate reads; `A -> B -> C` nested PREV now survives reload and returns updated or unchanged authority to the outer requester exactly once.
- Removed the duplicate dependency-gate representation of child returns; dedicated return gates and continuations now move `satisfied/resolved -> consumed` together when the caller return turn settles.
- Replaced partial failure and cancellation paths with one recursive run-lineage closure plan that closes caller and descendant runs, gates, rounds, activations, return gates, and continuations in the initiating transaction; every child boundary receives one typed failed/cancelled result, queued turns cancel, live turns receive interrupts, and only the outer boundary receives attention.
- Integrated lifecycle authority with recursive closure: authorized cancellation retains its existing task cascade while closing orchestration cancelled, and premature `succeeded`, `failed`, or `skipped` seals close the still-running workflow as `required_target_unavailable` without granting workflow code lifecycle authority.
- Added a durable workflow deadline reaper that runs before engine projection/reload recovery and periodically thereafter; expired waiting runs use the same recursive `run_timeout` closure without requiring or starting an adapter process, and repeated scans are idempotent.
- Added authorized explicit activation recovery with a transaction-first operation claim: failed/interrupted logical activations retain their primary turn, aggregate message, and activation ID while receiving one linked execution turn with the original pinned inputs; reload, two-client contention, same-key replay, changed fingerprints, deadlines, and terminal runs fail deterministically.
- Added terminal workflow-history pruning at the SQLite turn-delete boundary: active or corrupt references remain pinned, while a fully terminal leaf run with terminal node tasks and no live gate, round, activation, continuation, or return gate is removed with its bounded relational history before transcript retention deletes referenced turns.
- Expanded `get_task_status` workflow diagnostics with frozen run limits, deadline/terminal reason, exact recoverable activation and active gate identity, all relevant active/satisfied rounds with progress, all continuation states, and bounded integrity codes; it never selects one arbitrary historical round/continuation or returns artifact/prompt bodies.
- Moved every correctness-critical workflow planner behind the SQLite write lock through the named `workflowMutation` worker RPC; definition, start, staging, lifecycle, settlement, recovery, reaping, and graph mutations now derive and commit their effects inside one `BEGIN IMMEDIATE` transaction.
- Added deterministic two-client proof that terminal closure winning immediately before settlement lock acquisition commits no stale route, artifact, fill, activation, or turn.
- Made scheduler claim authority relational and terminal-run aware, blocked unrelated claims while a workflow task is durably waiting, and rejected backend/model/runtime-epoch handoff while its workflow run remains active.
- Added exact durable reservation counters for feedback rounds, workflow turns, and child starts; the Nth reservation succeeds, N+1 closes atomically, partial joins reserve nothing, and sequential PREV rounds consume the prior requester resume before reserving the next round.
- Scoped explicit child idempotency keys to the authorized caller before deriving child run/task/turn identities, preventing same-key collisions across callers while preserving same-caller replay fencing.
- Bound child invocation replay to a canonical fingerprint of caller scope, definition version, scoped key, exact artifact pins, and frozen effective policy; changed same-caller bindings now conflict on a real caller-resume activation.
- Required successful disposition settlement to match one exact durable staged claim in the same worker-owned transaction; missing or mismatched claims conflict, while consumed/discarded claim replay remains a no-op.
- Enforced frozen `maxTurnsPerTask` for dependency activations, feedback requests/resumes, and caller child-return turns in addition to the run-wide reservation budget.
- Removed workflow-result truncation and fail-closed oversized UTF-8 results against the frozen artifact limit before any route artifact or continuation is committed.
- Added adversarial evidence for same-operation concurrent define/start convergence, engine/caller artifact provenance, late prior-round responses, mutable routed-message JSON, no-fan-out validation, and caller-scoped child invocation.
- Reconciled every section-20 and A01-A14 row to an exact test identifier or explicit schema token; the guard resolves every referenced file/evidence string and no traceability row remains planned.

No known implementation gap remains. The complete project tests, compile/build, supplemental checks, and three-round independent adversarial review have passed.

Development compatibility decision (2026-07-22): this branch intentionally supports
only a fresh current schema. Older development stores are rejected with reset guidance;
there is no schema migration, quarantine, compatibility manifest, or migration backup path.

## 1. Objective

Replace the current happy-path workflow implementation with a protocol that preserves every normative invariant in section 20 under normal execution, concurrent settlement, reload, redelivery, cancellation, timeout, retention, and nested workflows.

The implementation is complete only when the database is the authoritative workflow state machine and no correctness decision depends on a pre-transaction snapshot, an in-memory callback, list ordering, or an agent-supplied writable identity.

This plan intentionally prefers a coherent schema and transaction model over further local patches in `TaskRepository`.

## 2. Non-goals

- Do not add `ANY`, quorum, predicates, streaming gates, speculative execution, graph mutation, result fan-out, or concurrent feedback rounds for one requester.
- Do not add automatic semantic PREV target selection.
- Do not preserve the separate `invoke_child_workflow` disposition if doing so conflicts with the section 20 NEXT contract. This branch is not a compatibility boundary.
- Do not seal task lifecycle from workflow success, NEXT, PREV, FAIL, process exit, or turn completion.
- Do not implement exactly-once process execution. The target remains at-least-once execution with at-most-one committed activation per logical gate/round/continuation.

## 3. Definition Of Done

All conditions below are mandatory.

1. Every section 20 requirement has a named automated test or a documented structural proof enforced by schema constraints.
2. Every correctness-critical workflow mutation is one SQLite transaction whose eligibility checks execute after acquiring the write lock.
3. Concurrent, duplicate, late, stale, cross-run, and cross-task events either commit exactly one valid effect or return a bounded deterministic conflict/no-op.
4. No terminal workflow run has a queued or claimable workflow turn.
5. No open feedback round, pending continuation, or incomplete gate permits its blocked requester/caller/consumer to run.
6. Every aggregate contains the exact values and artifact revisions committed to that activation, in frozen definition order.
7. Every logical task owns exactly one backend conversation and no committed backend session is owned by two tasks.
8. A three-level child workflow succeeds, fails, cancels, times out, reloads, and redelivers without losing or duplicating a continuation.
9. Exact budget boundaries are tested; implementations may not pass by seeding counts beyond the limit.
10. The full test suite, TypeScript compile, webview build, current-schema tests, and new concurrency tests pass from a clean database.

## 4. Anti-shortcut Rules

Implementation agents must not use any of the following approaches.

- Do not fix races by adding more repository pre-reads before `db.transaction()`.
- Do not rely on the single extension host, JavaScript event-loop ordering, or one `DbClient` connection for correctness.
- Do not build aggregate prompt content in TypeScript from rows read before the write transaction.
- Do not treat `ON CONFLICT DO NOTHING` as sufficient idempotency when a replay can carry different content.
- Do not silently return an empty workflow effect for an invalid staged workflow disposition.
- Do not use `workflow_nodes.consumer_node_id` or “first pending row” queries where an exact gate, round, target, activation, or continuation identity is available.
- Do not store authoritative routing identities only in `body_json`.
- Do not satisfy entry contracts with a synthetic `engine_start` artifact when caller inputs were declared.
- Do not queue a turn and then depend on a later scheduler rescan to make the transaction correct.
- Do not mark `satisfied` state as `consumed` merely because a resume turn was queued.
- Do not close only the immediate parent of a failed/cancelled child.
- Do not make tests pass by weakening assertions to accept artifact placeholders, missing values, open terminal gates, or silently dropped outcomes.
- Do not retain hard-coded workflow policies such as `maxTurns: 10` when the frozen run policy is authoritative.
- Do not expose workflow mutation tools to a task solely because the tool is in `ANY_TASK_ACTIONS`.
- Do not add migration or backward-compatibility machinery during this development phase.

## 5. Additional Audit Findings

These findings are in addition to the previously reported one-node, nested PREV, child mapping, failure recursion, scheduler, budget, lifecycle, aggregate, and consumed-state defects.

### A01. Pre-transaction aggregate race

Fan-in and feedback aggregates are built from reads performed before `BEGIN IMMEDIATE`. Two settlements can interleave so the transaction closes a full gate while the queued message still contains `missing` or a stale revision.

Relevant code: `src/task/repository.ts:4313-4354`, `src/task/repository.ts:5185-5242`, `src/task/sqlite/worker.ts:208-229`.

### A02. General workflow settlement TOCTOU

Run, gate, round, continuation, fence, and budget eligibility are read before the transaction. A cancellation or another settlement can commit between those reads and the final write, allowing a late event to route into a terminal run.

Relevant code: `src/task/repository.ts:3948-4041` and all `planWorkflow*` methods.

### A03. Public operation claim is split from mutation

`define_workflow` and `start_workflow` perform their domain mutation and write the turn-scoped `opId` ledger in separate repository commands. Concurrent same-`opId` calls can both mutate before one overwrites or conflicts in the public ledger.

Relevant code: `src/task/engine-graph.ts:2475-2546`.

### A04. Child idempotency key collisions

An explicit child key is returned verbatim and child identities do not include caller run/task identity. Two callers using the same key can derive the same child run/task/turn IDs. A same-caller replay with different bindings is not fingerprint-conflicted.

Relevant code: `src/task/workflow.ts:611-625`, `src/task/repository.ts:5429-5447`.

### A05. One task can belong to multiple workflow nodes/runs

`workflow_nodes.task_id` is indexed but not unique. Repository lookups by task ID can select an arbitrary workflow owner.

Relevant code: `src/task/sqlite/schema.ts:465-476`, `src/task/repository.ts:4071-4075`, `src/task/repository.ts:6287-6298`.

### A06. One gate input can hold conflicting artifact pins

The `workflow_gate_fills` primary key includes artifact identity, permitting multiple fills for the same `(run, gate, inputRef)`. There is no foreign key proving the fill matches a binding and an existing artifact revision.

Relevant code: `src/task/sqlite/schema.ts:517-529`.

### A07. Feedback authority trusts mutable JSON

Round, target, requester, base artifact, and source turn identity are parsed from `workflow_routed_messages.body_json`. The relational destination is not fully cross-checked against those values.

Relevant code: `src/task/repository.ts:4928-4974`.

### A08. Committed session ownership is not unique

Live `session_claims` serialize a session while a turn runs, but committed session IDs live only in task payloads and have no durable unique owner constraint. Two tasks can commit the same backend conversation ID.

Relevant code: `src/task/sqlite/schema.ts:289-298`, `src/task/engine.ts:4669-4706`.

### A09. Retry loses explicit logical activation ownership

Workflow gates do not store activation identity. Generic retry creates a random new turn ID, and the database cannot prove that it is retrying the same logical activation rather than creating another activation.

Relevant code: `src/task/engine.ts:1994-2036`, `src/task/transitions.ts:906-964`.

### A10. Retention can delete workflow-referenced evidence

Task lifecycle is independent from workflow state. If an authorized actor seals a workflow task and retention runs while a round/continuation/run still references its turns, generic retention can remove turn and operation evidence needed for late-event correlation and recovery.

Relevant code: `src/task/repository.ts:6469-6516`.

### A11. Workflow tools are context-free and over-authorized

NEXT, PREV, workflow FAIL, and child invocation are granted to every task. Non-workflow tasks can stage an outcome that later settles as a successful no-op. Child invocation is not tied to coordinator/caller capability.

Relevant code: `src/task/capabilities.ts:69-78`.

### A12. Workflow starts bypass ordinary host policy

`start_workflow` does not apply the same workspace trust, backend availability, MCP support, task-type, model, capability, depth, count, and per-root policy checks used by ordinary delegation.

Relevant code: `src/task/engine-graph.ts:2510-2520` compared with `src/task/engine-graph.ts:719-790`.

### A13. Workflow tasks are detached roots

Top-level, downstream, and child workflow tasks use `parentId: null`. This bypasses subtree authorization, descendant cancellation, per-root concurrency, and caller ownership.

Relevant code: `src/task/repository.ts:3524-3540`, `src/task/repository.ts:4367-4401`, `src/task/repository.ts:5638-5653`.

### A14. Terminal lifecycle states other than cancellation can strand a run

Only task cancellation is integrated with workflow closure. Sealing a required node as `failed`, `skipped`, or even prematurely `succeeded` can make future feedback impossible while the workflow remains running.

Relevant code: `src/task/repository.ts:2983-3016`.

## 6. Target Domain Model

The exact names may change, but the following semantics are required.

### 6.1 Frozen definition

The frozen definition must persist:

- Definition owner/scope.
- Version and canonical fingerprint.
- Ordered nodes and ordered dependency/routing edges.
- Explicit entry input contracts keyed by `(entryNodeId, inputRef)`, including the expected v1 artifact `kind` discriminator.
- Exactly one terminal node.
- Frozen policy: max feedback rounds, max turns per task/run, run timeout, max depth/count/concurrency, and `fail_workflow`.
- Role/backend/task-type/capability requirements resolved or validated under host policy.

### 6.2 Workflow run

Each run must persist:

- Run identity and immutable definition version.
- `origin`, optional parent run, caller task, owning root/coordinator, and continuation identity.
- Frozen effective policy after host clamping.
- `startedAt`, `deadlineAt`, status, terminal reason, terminal result artifact, and `updatedAt`.
- A unique start operation fingerprint scoped to the authorized owner/caller.

### 6.3 Task and session ownership

- Every workflow node task has exactly one owning `(runId, nodeId)`.
- Every workflow task belongs to the caller's task subtree and root concurrency domain.
- A relational session-binding row is the sole authoritative source for the active `(taskId, runtimeEpoch, backend, sessionId)` binding. `committedSessionId` in task JSON must be removed or treated only as a repository-hydrated projection that can never disagree with the relational row.
- Every historical `(backend, sessionId)` has exactly one task owner and is never reassigned to another task.
- Session ownership and the active task/epoch binding are established in the same settlement transaction. Clearing or switching an active binding preserves historical non-reuse while removing the old epoch from scheduling authority.
- Workflow tasks cannot switch backend/model/runtime epoch while their workflow run is non-terminal in v1; this preserves one logical CLI conversation across every activation.

### 6.4 Logical activation

Persist a relational activation record or equivalent columns that identify:

- Stable logical activation ID.
- Activation kind: dependency gate, feedback request, feedback resume, child return, or entry start.
- Reserved primary turn and message IDs.
- Current execution/retry turn linkage.
- Source gate, feedback round/target, or continuation.
- Any inherited outer feedback response authority.

A retry may create a new execution turn only if it remains linked to the same logical activation. It must not re-close the gate, rebuild the aggregate, or create another activation.

### 6.5 Dependency gate

- One row per consumer and run revision.
- Exact ordered binding rows.
- Exactly one fill per `(runId, gateId, inputRef)`.
- Every fill references one existing immutable artifact revision and the binding's expected producer/source kind.
- Status transitions: `open -> satisfied -> consumed`, or terminal failure/cancellation.
- `activationId`, reserved turn ID, and aggregate message ID are durable.

### 6.6 Artifact lineage

- Artifact ID identifies one immutable logical lineage.
- Revision is unique and monotonic within that lineage.
- Artifact identity is workspace-stable and may be pinned into one or more gates without rewriting source provenance.
- Every artifact revision has exactly one relational source variant, enforced with `CHECK` and foreign-key guards:
  - `workflow_node`: producer run, node, task, and producing turn are all present and mutually consistent.
  - `caller_turn`: authoritative caller task and turn are present; producer run/node are absent. This covers top-level caller inputs and a root caller's child-invocation NEXT result.
  - `engine_start`: explicit engine source kind and start operation are present; producer task/run/node are absent.
- Optional feedback round/target is valid only for the `workflow_node` source variant and must reference the producing activation.
- `updated` inserts exactly one new revision produced by the settling turn.
- `unchanged` inserts no revision and references the target's exact pinned base artifact.
- A child terminal result remains an artifact in the child run; the continuation points to that result rather than manufacturing false parent-node provenance.
- V1 contract compatibility is exact equality between the entry contract's expected artifact `kind` and the bound artifact's persisted `kind`. No JSON-schema inference or broader type system is introduced.
- Top-level start and root child invocation verify that every caller artifact is owned by the exact authorized caller task/turn. They never manufacture a fake workflow producer or reattribute the artifact to the destination run.

### 6.7 Feedback round and target

The round must persist requester node/task/turn, requester activation, inherited outer response authority, join mode, reserved resume activation/turn, and status.

Each target must have a stable target ID and relationally persist:

- Target node/task and inputRef.
- Base artifact ID/revision.
- Feedback request turn/message.
- Response turn and artifact ID/revision.
- Pending/responded status.

Nested PREV must propagate the outer response target identity to the nested requester resume activation so its eventual NEXT satisfies the original round.

This propagation is strictly intra-run. A PREV emitted by a child entry with no direct dependency must not inherit or traverse the child continuation; it is an invalid route that fail-fast closes the child and recursively closes its caller chain.

### 6.8 Routed message

Correctness identities must be relational columns or constrained referenced rows, not JSON-only fields:

- Message and idempotency key.
- Run, source node/task/turn, destination node/task.
- Gate, round, target, continuation, artifact ID/revision as applicable.
- Kind and bounded diagnostic payload.

### 6.9 Continuation

Continuation identity must be unique by invocation and child run and support a caller that is not itself in a workflow run.

Persist caller task/turn, optional caller run/node, child run, return gate/activation, terminal result, and status.

Every terminal child boundary has exactly one typed continuation result:

- `outcome`: `succeeded | failed | cancelled`.
- Exact child run ID.
- Bounded reason code for failed/cancelled outcomes.
- Result artifact ID/revision only for succeeded outcome.
- Producing child terminal turn/closure identity and resolved timestamp.

The result is inserted once in the same transaction that changes continuation and return-gate state. Failed/cancelled results are durable boundary outcomes even though fail-fast then recursively closes caller runs.

`pending -> resolved -> consumed`, or `pending/resolved -> failed/cancelled` where allowed by the protocol.

### 6.10 Return gate for callers outside a workflow

Use a dedicated relational `workflow_return_gates` concept rather than inserting a second dependency gate for the caller node.

Each return gate is owned by exactly one continuation and persists:

- Return gate ID and continuation ID.
- Authoritative caller task and invoking caller turn.
- Optional caller workflow run/node.
- Exact child run.
- Status, result artifact ID/revision, return activation, message, and execution turn.

The caller task is the scheduler consumer. A root caller does not require a fake workflow node or fake caller run. A workflow-node caller retains its original dependency gate for future PREV routing; the return gate can never be selected as a direct-dependency gate.

Child terminal settlement atomically changes the return gate `open -> satisfied`, the continuation `pending -> resolved`, and queues the exact caller return activation. Settlement of that activation changes the return gate and continuation to `consumed`. Foreign caller task, child run, continuation, or activation combinations are rejected by relational constraints and transaction guards.

### 6.11 Durable universal disposition staging

Persist one authoritative disposition claim per live `turnId` across both ordinary and workflow families: `complete`, ordinary `fail`, `wait`, `idle`, NEXT, PREV, workflow FAIL, and child-invocation NEXT route. The claim stores the claiming `opId`, family/kind, canonical fingerprint, bounded payload, and status. Keep the turn-scoped operation ledger for replay reporting, but do not keep a second authoritative disposition in task/turn JSON.

- Same operation and fingerprint replays read-only.
- A different operation with the same canonical disposition observes the existing staged claim and returns an idempotent already-staged result without changing it.
- Same operation with different content conflicts.
- Any different disposition content or kind conflicts, regardless of operation ID.
- A turn can own only one disposition of any family.
- Staging uses a live-turn/task/runtime-epoch CAS and does not route immediately.
- Every ordinary and workflow staging command calls the same repository claim primitive. Cross-family mutual exclusion is therefore enforced by one unique turn key rather than cooperating checks in separate tables.
- Successful `turnCompleted` settlement consumes the claim in the workflow transaction.
- Failed or interrupted settlement marks the claim discarded/non-committable while retaining bounded evidence. Explicit activation recovery creates a new execution turn with no inherited staged disposition.

### 6.12 Aggregate size rule

Persist a host-defined `maxWorkflowAggregateBytes` bound and include effective per-artifact and maximum-input-count bounds in validation.

- Definition/start validation must reject a contract whose maximum possible exact aggregate exceeds the host bound when that can be proven statically.
- Closing a gate/round/return gate must calculate the actual UTF-8 aggregate size inside the transaction.
- An aggregate at the exact byte limit is valid.
- An aggregate one byte over atomically fail-fast closes the workflow with bounded reason `aggregate_too_large`; it creates no consumer activation and never truncates, drops, or substitutes an input value.

## 7. Transaction Architecture

### 7.1 Required rule

All eligibility checks that determine whether a workflow effect may commit must execute after the transaction acquires the SQLite write lock.

Pre-transaction reads may be used for validation hints or bounded result shaping only. They must not decide run status, gate fullness, target openness, continuation ownership, revision allocation, budget availability, or aggregate content.

### 7.2 Acceptable implementation strategies

Choose one strategy and document it before coding:

1. SQL-guarded repository commands using `INSERT ... SELECT`, conditional updates, unique constraints, and aggregate SQL that reads rows inside `BEGIN IMMEDIATE`.
2. A narrowly scoped named workflow transaction request executed inside the DB worker, with bounded typed inputs/results and no arbitrary callback or raw SQL crossing into engine code.

The implementation must not emulate a transaction by issuing `get/all` RPC calls followed by a later `transaction` RPC.

### 7.3 Settlement transaction order

One successful settlement transaction must perform this logical order:

1. CAS the live turn, task revision, runtime epoch, and logical activation ownership.
2. Verify and consume the exact durable staged-disposition claim and fingerprint.
3. Verify run/round/gate/continuation is still eligible.
4. Reserve policy budget before creating any new round, activation, child run, or turn.
5. Commit session ownership and task/turn settlement.
6. Insert or reference the exact artifact revision.
7. Commit gate/round/continuation contributions.
8. Close a full accumulator and generate its aggregate from rows visible inside the transaction.
9. Insert exactly one activation, message, turn, and turn input.
10. Consume the activation source that this settled turn actually processed.
11. Apply recursive terminal closure if the disposition or policy requires it.
12. Commit before scheduling or interrupt side effects are observed by the engine.

If any mandatory guard fails, no subset of the workflow effect may commit.

## 8. Implementation Phases

### Phase 0: Requirement Traceability And Failing Tests

Required work:

- Create a section-20 traceability test document or test table mapping each invariant and numbered transaction requirement to test names.
- Add failing tests for every finding in the prior audit and additional findings A01-A14.
- Keep each test focused on observable durable state, not private helper output.

Mandatory pass conditions:

- At least one test exists for all 14 normative invariants in section 20.2.
- Tests cover section 20.4.1 start steps, 20.5 partial/final gate behavior, 20.6 lineage, 20.8 ALL join, 20.10 transaction/idempotency, 20.11 closure, and 20.12 continuation states.
- The new tests fail against the current implementation for the intended reason.
- No test uses direct SQL seeding as the only proof of a public protocol behavior. Direct SQL is allowed only for corruption/constraint tests.

Forbidden shortcuts:

- Do not start implementation until test names and requirement mapping are reviewed.
- Do not replace end-to-end repository/engine tests with only unit tests for ID helpers.

### Phase 1: Current Schema And Integrity Constraints

Required work:

- Maintain one current schema manifest for fresh creation only; incompatible development stores require explicit reset.
- Register the current application/user marker, required objects, indexes, writer-guard triggers, and golden fingerprint checks.
- Add owner/caller/policy/deadline/terminal-result fields for definitions and runs.
- Normalize entry contracts and any topology data needed by transactional routing.
- Add logical activation persistence.
- Add relational feedback target identity and base/response artifact references.
- Add relational routed-message identity columns.
- Add continuation caller/result/resume fields.
- Add dedicated relational return gates for callers with or without a caller workflow run.
- Add durable authoritative session ownership/binding by task, runtime epoch, backend, and session ID.
- Add durable universal turn-disposition claims and consumption/discard status without leaving two authoritative stores.
- Enforce unique task-to-workflow-node ownership.
- Enforce one fill per gate/inputRef and valid artifact/binding references.
- Enforce artifact lineage uniqueness.
- Add indexes for scheduler terminal-run checks, timeout scans, open round lookup, pending continuation lookup, and recursive parent traversal.

Mandatory pass conditions:

- Fresh schema creation passes the golden schema test.
- Connection preflight rejects any non-current owned schema without mutation and returns reset guidance.
- Duplicate task ownership, duplicate gate input fills, nonexistent artifact pins, duplicate session ownership, and mismatched feedback target identity fail with bounded repository errors.
- Artifact source-variant constraints reject rows with zero sources, multiple sources, a caller turn owned by another task, or workflow producer fields inconsistent with the run/node/task/turn.
- Foreign-key checks pass after fresh creation and adversarial protocol tests.

Forbidden shortcuts:

- Do not rely solely on TypeScript validation for invariants SQLite can enforce.
- Do not put new authoritative identities only into JSON payloads.

### Phase 2: Definition, Entry Contract, Policy, And Scope Validation

Required work:

- Extend definition codec/types with explicit entry contracts and frozen policy.
- Define v1 binding compatibility as exact artifact `kind` equality, persist expected kind in every entry contract, and include it in canonical fingerprints.
- Validate exact one terminal, no fan-out, acyclic dependencies, unique consumer input refs, one route per non-terminal, one matching dependency per route, entry contracts, and host bounds.
- Bind definitions to an authorized owner/root scope or explicit workspace ACL.
- Include all frozen semantic fields in the definition fingerprint.
- Validate backend/task type/role/capability requirements without starting work.

Mandatory pass conditions:

- Definitions with missing, duplicate, ambiguous, impossible, or foreign entry contracts are rejected with zero definition rows and zero operation claims.
- Reordering semantically unordered JSON fields replays; changing policy, contract, topology, role, or backend requirements conflicts.
- Two unauthorized roots cannot define/start/replay each other's scoped definition or key namespace.
- Max node/depth/count/capability/backend violations fail before release.

Forbidden shortcuts:

- Do not infer entry contracts from incoming graph edges.
- Do not leave policy in process memory or global defaults after run start.

### Phase 3: Atomic Define And Start Commands

Required work:

- Claim public `(callerTurnId, opId, fingerprint)` in the same transaction as definition/start mutation.
- Scope start idempotency to owner/caller plus definition/version/key.
- Persist caller-provided entry artifacts and explicit engine-start artifacts only for entries whose contract declares no caller data.
- Persist caller-provided entry artifacts with `caller_turn` provenance and engine-authored empty-entry artifacts with `engine_start` provenance; pin them into run gates without changing source ownership.
- Create every node gate, binding, entry fill, logical activation, message, and queued turn atomically.
- Parent workflow tasks into the caller's subtree and root concurrency domain.
- Return all entry activation IDs and schedule/rescan every created entry only after commit.

Mandatory pass conditions:

- Same public `opId` plus same fingerprint replays read-only; a different fingerprint conflicts with zero second mutation.
- Concurrent same-`opId` define/start calls through two clients commit exactly one mutation.
- V1 has no later caller-input contribution command: every start with an incomplete declared entry contract is rejected atomically before run, operation, task, gate, message, or turn creation.
- Multi-entry starts queue and schedule every independently satisfied entry without waiting for another entry to settle.
- Every entry aggregate contains exact declared input values and provenance in definition order.
- Foreign caller task/turn artifacts and fake workflow producer provenance are rejected with zero start rows.
- Entry tasks are descendants of the authorized caller/root and count against the same per-root concurrency limit.
- Untrusted workspace, unavailable backend, unsupported MCP backend, depth/count overflow, or missing capability produces zero run/task/turn rows.

Forbidden shortcuts:

- Do not share one start artifact with false producer provenance across entries.
- Do not schedule only the primary entry.

### Phase 4: Contextual Workflow Tools And Disposition Contract

Required work:

- Require NEXT, PREV, workflow FAIL, and ordinary forward routing to have a live workflow activation plus host-issued capability.
- Permit only the child-invocation NEXT route to an authorized currently executing coordinator/caller outside a workflow, guarded by caller turn ownership, workspace trust, scope, child-invocation capability, and absence of a pending continuation.
- Replace the fourth child-invocation disposition with a NEXT route variant matching section 20.6/20.12.
- Derive response round/target identity from durable activation context; do not let the agent select writable round/target IDs.
- Reject `unchanged` unless the activation is responding to feedback with an exact pinned base artifact.
- Reject any staged outcome that is invalid for the current node, route, role, run status, or activation kind.
- Implement all ordinary and workflow staging through the universal CAS protocol in section 6.11, separate from settlement and routing.

Mandatory pass conditions:

- Ordinary workers outside workflows do not list workflow mutation tools. An authorized root coordinator may list only the child-invocation NEXT route, not PREV, workflow FAIL, or ordinary workflow NEXT.
- Direct stale/broad credentials are denied by execution-time checks in every context.
- Non-workflow dispositions return deterministic errors and do not settle as successful no-ops.
- A non-terminal node cannot invoke a child; a valid terminal caller can.
- A root coordinator not already in a workflow can invoke a child workflow and receive a continuation.
- Initial `NEXT(unchanged)` is rejected; feedback `unchanged` references exactly the pinned base artifact and creates no revision.
- NEXT, PREV, workflow FAIL, child invocation, complete, ordinary fail, wait, and idle are mutually exclusive through one authoritative turn slot.
- Concurrent two-client staging with the same operation/fingerprint commits one claim and replays; different content conflicts; competing disposition kinds cannot coexist.
- Cross-family races `complete` versus child NEXT, `wait` versus PREV, and ordinary fail versus workflow FAIL produce exactly one winner and deterministic replay/conflict results.
- Staging after settlement is rejected. Failed/interrupted settlement permanently discards the staged claim, and redelivery or later recovery cannot route it.

Forbidden shortcuts:

- Do not use tool visibility as the only authorization check.
- Do not preserve `invoke_child_workflow` internally as an independent base outcome.

### Phase 5: Atomic NEXT, Gate Fill, And Aggregate Activation

Required work:

- Route normal NEXT through an exact frozen edge and binding.
- Allocate/validate artifact revision inside the settlement transaction.
- Insert exactly one gate fill per inputRef.
- Close a full gate and build aggregate content from committed fills inside the same transaction.
- Persist aggregate provenance in structured message metadata as well as bounded prompt content.
- Support graph and top-level one-node terminal NEXT.
- Consume the activation gate when its turn successfully commits any workflow disposition.
- Enforce the aggregate byte rule in section 6.12 without truncation.

Mandatory pass conditions:

- At 1/N through N-1/N fills: no consumer task/turn/message exists.
- At N/N fills: exactly one consumer activation exists and contains every exact value/revision in definition order.
- Two concurrent final contributions cannot produce `missing`, stale values, two activations, or conflicting fills.
- Duplicate and late NEXT events are bounded no-ops and cannot reopen consumed/terminal gates.
- Top-level one-node and graph terminal NEXT set run success, persist one terminal artifact/fence, consume the source activation, and leave task lifecycle open.
- A terminal run has no claimable follow-up turns.
- Exact aggregate byte limit succeeds; one byte over fail-fast closes with no consumer activation.

Forbidden shortcuts:

- Do not construct aggregate strings from a pre-transaction `Map`.
- Do not use a fence that prevents a legitimate later artifact revision from responding to the correct feedback context.

### Phase 6: PREV, Nested Feedback, ALL Join, And Lineage

Required work:

- Resolve PREV targets only from the requester's exact consumed input bindings.
- Persist one round, stable target IDs, base artifact pins, target activation contexts, messages, and turns atomically.
- Carry outer feedback response authority through nested PREV rounds and requester resume activations.
- Record each response against the exact relational target.
- On the final response, close to `satisfied`, pin exact response artifacts, and generate one aggregate inside the transaction.
- Move `satisfied -> consumed` only when the requester resume activation successfully settles.
- Enforce the aggregate byte rule in section 6.12 without truncation.

Mandatory pass conditions:

- Targeted PREV reaches only selected direct dependencies; `all` reaches every direct dependency exactly once.
- Invalid/empty/foreign refs fail the workflow with no partial round.
- Partial responses never queue requester resume.
- The final response queues exactly one requester resume containing exact payloads for every target, including the final responder and unchanged responses.
- `A -> B -> C` nested PREV completes: C PREV B, B PREV A, A NEXT, B resumes and NEXT, then C resumes exactly once.
- Late response from round N cannot satisfy round N+1.
- A requester cannot run any other turn while its round is open or satisfied-but-unconsumed.
- Corrupt JSON that disagrees with relational target/requester identity fails closed.
- Reload at open, partially responded, satisfied, and consumed states creates no duplicate turn.
- Exact feedback aggregate byte limit succeeds; one byte over fail-fast closes with no requester resume.

Forbidden shortcuts:

- Do not correlate feedback response solely by execution turn ID or JSON body.
- Do not substitute `[artifact id@revision]` when the persisted artifact payload is available and required as the input value.

### Phase 7: Child Invocation And Continuation Boundary

Required work:

- Implement child invocation as a NEXT route.
- Include caller identity in invocation fingerprint and child identity derivation.
- Require bindings to name `childEntryNodeId`, `childInputRef`, and exact caller artifact revision.
- Validate complete exact binding coverage against frozen child entry contracts.
- Atomically create child run, child artifacts/references, gates, entry activations, and one continuation.
- Preserve child terminal artifact in child lineage and resolve the continuation with that artifact.
- For a root caller, persist the child-invocation NEXT result as a `caller_turn` artifact or bind an existing exact caller-owned revision; never require fake caller workflow provenance.
- Queue one caller return activation and consume the continuation only when that activation settles.
- Use exact activation/continuation identity for PREV after child return; never select an arbitrary gate by consumer node.
- Store caller return authority in the dedicated return gate from section 6.10, including for a root caller without a workflow run.
- Treat PREV from a child entry with no direct dependencies as invalid-route fail-fast; never bubble it through the continuation.

Mandatory pass conditions:

- Missing, duplicate, extra, foreign, stale, or type-incompatible bindings fail the caller disposition with zero child rows.
- Two callers using the same explicit child key produce isolated identities or a deterministic scoped conflict, never a raw SQLite uniqueness error.
- Same invocation key with changed bindings conflicts.
- Multi-entry child input reaches the named entries only; incomplete entries do not run.
- Pending continuation is the caller's sole resume authority.
- Child terminal NEXT resolves once, queues one caller turn, and survives reload/redelivery.
- Caller PREV after child return uses the caller workflow's original direct dependencies, not the return gate.
- Continuation states are observably `pending`, `resolved`, `consumed`, `failed`, and `cancelled` at the correct boundaries.
- Root caller and workflow-node caller both pass.
- Relational constraints reject attaching a return gate/activation to the wrong caller task, caller turn, continuation, or child run.
- Root caller artifact ownership is enforced by caller task/turn and immutable revision; foreign root artifacts fail with zero child rows.
- Child-entry PREV creates no caller feedback turn, closes the child/caller chain once, and remains idempotent across reload/redelivery.
- Child-return aggregate obeys the exact byte limit and never truncates.

Forbidden shortcuts:

- Do not copy parent artifacts into a child run with a producer node that does not belong to the child run.
- Do not mark all child entry gates satisfied before validating and filling each contract.

### Phase 8: Unified Recursive Closure And Lifecycle Integration

Required work:

- Replace separate partial failure/cancellation helpers with one recursive closure primitive.
- Close the run, all open/satisfied gates, all open/satisfied rounds, and pending/resolved continuations as appropriate.
- Cancel every queued workflow turn and write interrupt requests for every running/waiting turn in scope.
- Recursively close caller runs through child continuations.
- Produce one bounded terminal reason/result and one owner/root attention at the outer boundary.
- At every child boundary, persist exactly one typed continuation result before recursively closing the caller: failed result for failure/timeout/exhaustion, cancelled result for cancellation, and no success artifact on either terminal error outcome.
- Split closure entry semantics explicitly:
  - Workflow-originated FAIL, invalid route, timeout, budget/aggregate exhaustion, and required-target failure close orchestration and attention only; they do not change task lifecycle.
  - Authorized task lifecycle cancellation first applies the existing task/descendant lifecycle cascade, then atomically closes every affected workflow run/continuation without independently changing additional task lifecycles.
- Integrate authorized lifecycle seals deterministically: while a workflow run is non-terminal, `cancelled` closes it cancelled; `failed`, `skipped`, or premature `succeeded` makes the session unavailable for future feedback and closes the run failed with bounded `required_target_unavailable`. The authorized lifecycle mutation still commits under existing authority rules.

Mandatory pass conditions:

- Explicit FAIL, invalid route, target failed/skipped/cancelled, timeout, budget exhaustion, and cancellation use the same closure invariants.
- Three-level nested failure and cancellation close every child/parent run, gate, round, continuation, and queued turn.
- Three-level nested failure and cancellation persist an exact typed result at every continuation boundary; reload/redelivery observes the same child run, outcome, and reason without a second result.
- Running turns at every level receive durable interrupts.
- No terminal run has status `open` or `satisfied` gates/rounds unless a documented immutable historical state is stored separately from active status.
- Exactly one outer owner attention is created; duplicate closure is read-only.
- A prematurely sealed `succeeded`, `failed`, or `skipped` workflow task closes a still-running workflow as `required_target_unavailable` before any future PREV can strand it.
- Workflow-originated timeout/failure leaves task lifecycles open.
- Authorized user/coordinator cancellation preserves the existing cancelled lifecycle cascade while workflow closure adds no extra lifecycle authority.
- Cancelling a caller subtree closes affected workflow runs and descendants; timing out the same workflow closes orchestration while leaving those task lifecycles open.

Forbidden shortcuts:

- Do not recurse in application memory using separate transactions per level.
- Do not rely on task `parentId` cascade alone; run/continuation lineage is authoritative.

### Phase 9: Scheduler, Session Ownership, And Durable Waiting

Required work:

- Add in-memory readiness checks and final SQL claim guards for run status, activation authority, open rounds, pending continuations, FIFO task serialization, and session ownership. Terminal-run checks apply only to turns carrying a logical activation owned by that run.
- Make the relational task/epoch/backend/session binding the sole scheduler/resume authority and hydrate any task projection from it.
- Persist historical session ownership so a backend session can never be reassigned to another task.
- Ensure every waiting state has no process, runtime claim, session claim, resource claim, promise, socket, or callback kept alive for orchestration correctness.
- Make scheduler rescan only an optimization after durable commit.

Mandatory pass conditions:

- A queued workflow activation owned by a failed/cancelled/succeeded run fails both `canPromoteTurn` and repository `claimTurn`.
- A later ordinary user/coordinator turn on the same still-open or legitimately reopened task may claim under ordinary readiness, but receives no NEXT/PREV/FAIL authority from the historical terminal run.
- A requester with an open round and caller with pending continuation cannot claim unrelated turns.
- Different workflow tasks run concurrently subject to global/backend/root limits.
- Two turns for one task/session never run concurrently under two engine instances.
- Two tasks attempting to commit the same backend session ID produce one owner and one bounded failure; neither shares the conversation.
- A task projection, active binding, historical owner, backend, and runtime epoch cannot disagree after settlement or reload.
- Corrupt disagreement between a legacy task payload and relational binding fails closed with bounded attention; scheduler never guesses which source wins.
- Backend/model/runtime-epoch switch is rejected while a workflow run is non-terminal.
- Reload while waiting starts no adapter until a durable queued activation is eligible.

Forbidden shortcuts:

- Do not rely only on in-memory scheduler checks; SQL claim is the final authority.
- Do not solve session ownership by merely checking current live claims.

### Phase 10: Budgets, Deadline Reaper, And Recovery

Required work:

- Freeze host-clamped budgets and deadline on the run.
- Reserve round/turn/child/depth capacity atomically before creating effects.
- Define boundary semantics explicitly: a configured maximum permits exactly that many units; the next reservation fails.
- Add a durable timeout scan/reaper that runs on load and periodically without requiring a live adapter turn.
- Preserve logical activation identity across safe retry and explicit recovery.
- Never replay uncertain prompt execution silently.
- Add an authorized explicit `recoverWorkflowActivation` repository/engine command. It accepts activation ID, failed/interrupted execution turn, recovery operation ID, canonical instruction/fingerprint, and expected run/activation status.
- Permit recovery only for a non-consumed activation in a running run after a failed or interrupted execution. Queue one new execution turn linked to the same activation and pinned aggregate/message; do not re-close the source accumulator or inherit a discarded disposition.

Mandatory pass conditions:

- Limits `1`, default, and host maximum pass exact-boundary tests for feedback rounds and workflow turns.
- The Nth allowed action succeeds; N+1 closes with the exact exhaustion reason and creates no new turn/round/child.
- Budget closure cannot coexist with success routing side effects in one settlement.
- A run waiting on an incomplete gate, feedback target, or child continuation times out after reload with no process alive.
- Safe pre-dispatch retry uses the same logical activation and aggregate; uncertain interruption creates no automatic replacement activation.
- Authorized explicit recovery after uncertain interruption creates one linked execution turn. Same-key replay is read-only; changed fingerprint conflicts; concurrent recovery requests commit one turn.
- Recovery after reload succeeds without rebuilding aggregate content. Recovery racing cancellation either commits before complete closure or loses with zero new turn.
- Recovery is rejected after activation consumption or terminal run closure.
- Per-task and per-run turn budgets cannot leave a queued turn stranded.

Forbidden shortcuts:

- Do not count rows before the transaction and compare later.
- Do not treat adapter run timeout as workflow run timeout.

### Phase 11: Retention, Projection, Diagnostics, And Reload

Required work:

- Pin turns/messages/operations/artifacts referenced by non-consumed workflow activations, rounds, and continuations.
- Allow retention only after the workflow references are consumed or terminal and diagnostics policy permits deletion.
- Project bounded run policy/status/reason, exact active gate, round progress, activation, and all continuation states needed for recovery.
- Keep artifact bodies and prompt text out of status projection.
- Add integrity diagnostics for impossible or corrupt workflow states.

Mandatory pass conditions:

- Retention cannot delete a turn or idempotency record referenced by an open/satisfied activation, round, or continuation.
- Reload distinguishes unresolved, resolved, consumed, failed, and cancelled continuation states.
- Projection never selects an arbitrary round or continuation when multiple historical rows exist.
- Projection remains bounded and does not leak topology, payload bodies, SQL, paths, credentials, or secrets.
- Corrupt states produce bounded attention and no automatic work.

Forbidden shortcuts:

- Do not hide terminal continuation states by filtering only `pending`.
- Do not keep unlimited history solely to avoid implementing reference-aware retention.

### Phase 12: Concurrency And Adversarial Verification

Required work:

- Add deterministic barriers/fault hooks around workflow transaction acquisition and commit.
- Use two repository/DB clients where needed to prove cross-connection behavior.
- Test every idempotency key with same-fingerprint replay and different-fingerprint conflict.
- Test stale settlements racing cancellation, timeout, final gate fill, final feedback response, and child return.

Mandatory pass conditions:

- Concurrent final fan-in contributions produce one complete aggregate and one activation.
- Concurrent final feedback responses produce one complete aggregate and one requester resume.
- Cancellation winning before settlement causes the late settlement to commit no route/artifact/fill/turn.
- Settlement winning before cancellation produces valid routing followed by complete closure with no surviving claimable turn.
- Concurrent define/start/child invocation calls cannot overwrite operation results or collide raw IDs.
- Fault before commit leaves zero partial workflow effects; fault after commit redelivery is a no-op.
- `PRAGMA foreign_key_check` remains empty after all adversarial tests.

Forbidden shortcuts:

- Do not use timing sleeps as the only concurrency coordination.
- Do not assert only row counts; assert exact identities, statuses, values, revisions, and absence of claimable work.

### Phase 13: Final Conformance Gate

Required work:

- Run the section-20 traceability suite.
- Run all M018 named flows plus the full repository, engine, scheduler, schema, retention, capability, and bridge tests.
- Run the entire project test suite and compile/build commands.
- Perform a final code review against the normative text, not only this plan.
- Produce a workflow mutation inventory covering define, start, staging, settlement variants, recovery, lifecycle closure, timeout reaper, scheduler claim, retention, and projection. For every entry, record its authoritative transaction, relational guard identities, same-key replay test, different-fingerprint conflict test, cancellation race test, and reload test.

Mandatory pass conditions:

- `npm test` passes.
- `npm run compile` passes.
- All current-schema and fault-injection tests pass.
- No skipped, focused, quarantined, or timing-dependent workflow test remains.
- The mutation inventory proves every correctness-critical decision is guarded inside one repository/worker transaction, including a race where a conflicting mutation commits after any preliminary read but before lock acquisition.
- Supplemental searches find no known old `planWorkflow*` pre-read pattern, separate child-invocation base disposition, hard-coded workflow policy, or detached `parentId: null`; search results are not accepted as the primary proof.
- The traceability table has no uncovered section-20 requirement.
- An independent adversarial review returns no unresolved critical/high conformance finding.

## 9. Required Named End-to-End Scenarios

The final suite must include these named scenarios so coverage cannot be satisfied by isolated helper tests.

1. `one-node top-level updated success and replay`
2. `multi-entry exact caller contracts schedule concurrently`
3. `three-producer fan-in concurrent final fills`
4. `targeted PREV updated plus unchanged ALL join`
5. `nested PREV A-to-B-to-C returns to outer requester`
6. `feedback final responder value is present`
7. `late round-N response cannot satisfy round-N-plus-one`
8. `root caller invokes multi-entry child and consumes return`
9. `workflow-node caller invokes child then emits PREV to original dependencies`
10. `three-level child failure recursively closes root`
11. `three-level child cancellation recursively closes root`
12. `run timeout while no adapter process exists`
13. `exact feedback and turn budget boundaries`
14. `terminal-run queued turn rejected by scheduler and SQL claim`
15. `duplicate backend session ownership rejected`
16. `retention preserves open workflow evidence`
17. `same opId concurrent define/start conflict`
18. `same child key across callers remains isolated`
19. `stale NEXT racing cancellation is harmless`
20. `reload at every gate/round/continuation state is idempotent`
21. `older development schema is rejected with reset guidance`
22. `root return gate rejects foreign caller and child identities`
23. `explicit activation recovery replay conflict and cancellation race`
24. `child entry PREV fails without crossing continuation`
25. `concurrent disposition staging and failed-turn discard`
26. `aggregate exact byte limit and one-byte overflow`
27. `session binding owner epoch and projection remain consistent`
28. `typed failed and cancelled continuation results survive reload`
29. `caller and engine artifact provenance variants reject foreign ownership`
30. `terminal run rejects stale activation but permits later ordinary turn`
31. `cross-family disposition races have exactly one winner`

## 10. Review Checklist For Each Implementation PR

Every implementation PR or commit series must answer all questions below with code/test references.

- Which section-20 requirements does this change close?
- Which durable identity is authoritative for each affected route?
- Which SQL/schema guard prevents cross-run, stale, duplicate, and conflicting writes?
- Are all eligibility reads inside the write transaction?
- What happens if cancellation commits immediately before this command?
- What happens if this command commits and its process crashes before scheduling?
- What happens when the command is delivered twice with the same fingerprint?
- What happens when the same key is reused with a different fingerprint?
- Which exact artifact revision and value appears in the aggregate?
- When does the source gate/round/continuation become consumed?
- Can any queued turn survive a terminal run?
- Can a different task claim the same backend session?
- Can retention delete evidence still referenced by this state?
- Which reload test proves no in-memory state is required?
- Which negative test prevents a naive happy-path-only implementation?

## 11. Completion Evidence

- Current schema/reset evidence: `src/task/sqlite/schema.test.ts`, `src/task/sqlite/protocol.test.ts`, and the fresh-schema-only compatibility decision above.
- Requirement traceability: `src/task/m018-section20-traceability.ts`, enforced by `src/task/m018-section20-traceability.test.ts` against exact test identifiers and schema tokens.
- Focused M018 gate: `npx vitest run` over 12 M018/traceability files passed 63 tests on 2026-07-22.
- Full test gate: `npm test` passed 157 files and 2019 tests on 2026-07-22.
- Compile/build gate: `npm run compile` passed TypeScript compilation and the production webview build on 2026-07-22.
- Supplemental gates: `npx tsc --noEmit` and `git diff --check` passed on 2026-07-22.
- Concurrency/fault evidence includes concurrent final fan-in/feedback fills, same-operation define/start, terminal-before-settlement locking, transaction rollback injection, recovery contention, and caller-scoped child-key conflict tests named in the traceability table.
- Independent review: APPROVE after three rounds. Round one requested six fixes covering claim-bound settlement, child invocation fingerprints, per-task/caller-return turn budgets, result truncation, and traceability evidence. Round two found and round three approved the corrected child invocation fence/fingerprint persistence mapping plus exact replay coverage. No critical/high finding remains unresolved.
- Intentionally deferred section-20 v1 items: none.
