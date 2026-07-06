# Task Management — domain model and coordinator protocol

Authoritative design for task orchestration in Muster. This document defines the
domain concepts and invariants that implementation types must preserve.

**Related documents:**

- [`DESIGN.md`](DESIGN.md) — extension architecture and per-turn process model
- [`SESSION-MANAGEMENT.md`](SESSION-MANAGEMENT.md) — backend-specific session identity and resume rules
- [`ADAPTER-SPEC.md`](ADAPTER-SPEC.md) — `NormalizedEvent`, `RunOptions`, and adapter turn lifecycle
- [`MUSTER-BRIDGE.md`](MUSTER-BRIDGE.md) — MCP transport and `ask_user`
- [`WEBVIEW.md`](WEBVIEW.md) — chat rendering and `postMessage` protocol

**Status:** Design contract for the task-management implementation. If another
document describes the legacy single-chat flow differently, this document is
authoritative for the task-based flow.

---

## 1. Goals and boundaries

Muster coordinates durable units of work while invoking short-lived headless AI
CLI processes. The design must support:

- a root coordinator for each user request;
- delegated worker and sub-coordinator tasks;
- explicit dependencies and child wait sets;
- multiple turns backed by one CLI conversation per task;
- deterministic cancellation, failure, and reload recovery;
- host-enforced orchestration policy and resource limits.

This document does not standardize backend-specific CLI flags, normalized stream
events, or visual rendering details. Those belong to the related documents.

---

## 2. Glossary

| Term | Definition | Lifetime |
|------|------------|----------|
| **Task** | A unit of work with a goal, dependencies, policy, and final outcome | Until a terminal outcome |
| **Backend** | A reusable adapter for one CLI family such as Claude, Codex, or Grok | Extension lifetime |
| **Session** | Backend-owned conversation history used by one task | Task lifetime |
| **Turn** | One requested interaction with a task's session | One CLI invocation |
| **Process** | The operating-system child process used to execute a turn | While that turn runs |
| **Coordinator** | A task role allowed to create, start, stop, and wait for child tasks | Task lifetime |
| **Worker** | A task role that performs delegated work without extending the task graph | Task lifetime |
| **Engine** | Host-side scheduler and state machine that validates and applies orchestration actions | Extension lifetime |

Do not use **executor** as a domain term. It ambiguously refers to a backend,
session, agent, or process. In code and documentation, use the precise term.

### 2.1 Layering

```text
User request
└── Root task (role: coordinator)
    ├── Child task A (role: worker)
    ├── Child task B (role: worker)
    └── Child task C (role: coordinator)
        └── Child task D (role: worker)

Task
├── backend binding
├── one owned session
└── zero or more turns
    └── at most one active process for that task
```

The root coordinator uses the same `MusterTask` type as every child. Its root
position and host-issued policy distinguish it; there is no separate main-agent
class.

---

## 3. Normative invariants

Implementations must preserve all of the following:

1. **Turn success is not task success.** Adapter `turnCompleted` means only that
   one CLI invocation succeeded.
2. **Task completion is explicit.** A task reaches a terminal outcome only through
   an accepted turn disposition, dependency policy, cancellation, or exhausted
   execution policy.
3. **Terminal task outcomes are immutable.** More work creates a continuation task;
   it does not reopen a completed dependency node.
4. **One task owns one session.** Session IDs are never shared by tasks.
5. **Identity is stable.** Parent, role, and backend binding do not change after
   task creation; dependencies do not change after the first turn is queued.
6. **One active turn per task/session.** Different tasks may run concurrently when
   backend limits allow it.
7. **Readiness is derived.** Dependency, scheduler, child-wait, and runtime state
   must not be copied into one mutable task-status enum.
8. **Child waiting is explicit and turn-scoped.** The engine never infers a wait
   set from every child that happened to be started during a turn.
9. **The host is authoritative.** MCP calls express requested actions; the engine
   validates ownership, capability, state, and resource policy before applying them.
10. **Orchestration is idempotent.** Create, start, disposition, child completion,
   and continuation scheduling are keyed by stable operation or turn IDs.
11. **No automatic replay after uncertainty.** A process lost during reload becomes
    interrupted; Muster does not silently resend its input.
12. **Persist before side effects.** A queued/running turn and its input identity
    are stored before spawning a process.
13. **Delegation is bounded.** Depth, child count, turn count, and concurrency have
    host-configured limits even when sub-coordinators are enabled.

---

## 4. Domain model

The following types are design sketches. Concrete TypeScript may split records
between store modules, but must preserve their semantics.

### 4.1 Tasks

```ts
type TaskRole = 'coordinator' | 'worker';

type TaskLifecycleState =
  | 'open'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';

interface TaskDependency {
  taskId: string;
  requiredOutcome: 'succeeded' | 'settled';
  onUnsatisfied: 'block' | 'fail' | 'skip';
}

type PersistedWait =
  | {
      kind: 'children';
      taskIds: string[];
      registeredByTurnId: string;
    }
  | {
      kind: 'external';
      key: string;
      message?: string;
    };

type TaskCapability =
  | 'create_child'
  | 'start_child'
  | 'wait_child'
  | 'interrupt_child'
  | 'cancel_child'
  | 'read_subtree';

interface TaskExecutionPolicy {
  maxTurns: number;
  maxAutomaticRetries: number;
  turnTimeoutMs: number;
  taskTimeoutMs: number;
}

interface MusterTask {
  id: string;
  role: TaskRole;
  lifecycle: TaskLifecycleState;

  // Intent
  goal: string;
  description?: string;
  reason?: string;
  continuationOf?: string;

  // Graph
  parentId: string | null;
  dependencies: TaskDependency[];
  wait?: PersistedWait;

  // Session binding
  backend: string;
  committedSessionId?: string;

  // Host-issued policy
  capabilities: TaskCapability[];
  executionPolicy: TaskExecutionPolicy;

  // Outcome
  result?: string;
  error?: string;

  // Persistence
  revision: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}
```

`parentId` is the source of truth for tree ownership. `childIds` is a derived
index, not duplicated task data. Child status and result are read from child
records; a persisted `childRuns` snapshot is not authoritative.

`capabilities` are issued and validated by the host. A caller cannot grant itself
new capabilities by passing them to `create_task`.

Default graph capabilities are:

| Role | Graph capabilities |
|------|--------------------|
| Root/sub-coordinator | Host-approved subset of all `TaskCapability` values |
| Worker | None; self-disposition and `ask_user` do not extend the graph |

### 4.2 Turns

```ts
type TurnStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

type TurnTrigger = 'user' | 'engine' | 'retry';

type TurnInput =
  | { kind: 'message'; messageId: string }
  | { kind: 'child_results'; taskIds: string[] }
  | { kind: 'recovery'; interruptedTurnId: string; instruction: string };

type TurnDisposition =
  | { kind: 'complete'; result: string }
  | { kind: 'fail'; error: string }
  | { kind: 'wait_tasks'; taskIds: string[] }
  | { kind: 'idle' };

interface TaskTurn {
  id: string;
  taskId: string;
  sequence: number;
  trigger: TurnTrigger;
  retryOf?: string;
  status: TurnStatus;
  inputs: TurnInput[];

  // Session identity observed or generated for this invocation
  candidateSessionId?: string;
  observedSessionId?: string;

  // Staged by MCP; committed only after adapter turnCompleted
  disposition?: TurnDisposition;

  error?: string;
  isCancellation?: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
```

A turn ID is also the stream/run correlation ID used by the webview. Retrying an
interrupted or failed invocation creates a new turn ID; an old turn record is never
changed back to `queued` or `running`.

### 4.3 Derived view status

The store persists task lifecycle, turns, dependencies, and explicit waits. The
UI status is computed:

```ts
type TaskViewStatus =
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'idle'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped';
```

Evaluation order is deterministic:

1. A terminal `TaskLifecycleState` maps directly to the terminal view status.
2. A live turn maps to `running` or `waiting_user`.
3. Unsatisfied dependencies map to `waiting_dependencies`, even when a queued turn
   records start intent.
4. A schedulable queued turn maps to `queued`.
5. `wait.kind === 'children'` maps to `waiting_children`.
6. `wait.kind === 'external'` maps to `blocked`.
7. A latest failed/interrupted turn with no replacement maps to `needs_recovery`.
8. Otherwise the open task is `idle`.

`ready`, `pending_deps`, `awaiting_children`, `paused`, and `stopped` are therefore
not persisted task lifecycle states.

---

## 5. Task lifecycle

```text
create
  └── open
      ├── queue turn ──► execute turns ──► open
      ├── accepted complete disposition ──► succeeded
      ├── accepted fail disposition ──────► failed
      ├── dependency/execution policy ────► failed | skipped
      └── cancel task ────────────────────► cancelled
```

Terminal outcomes are `succeeded`, `failed`, `cancelled`, and `skipped`. They are
settled for child wait sets. Only `succeeded` satisfies a dependency whose
`requiredOutcome` is `succeeded`.

### 5.1 Creating a task

`TaskEngine.createTask(input, callerContext)`:

1. Validates parent ownership and caller capability.
2. Validates dependency scope and rejects dependency cycles.
3. Applies host policy; the caller cannot choose arbitrary capabilities or limits.
4. Persists an `open` task without starting a turn.
5. Returns the task ID and derived view status.

Task creation and task starting are separate operations. A convenience
`delegate_task` MCP tool may atomically create a child and queue its first turn.

### 5.2 Starting and continuing

`startTask(taskId, inputs)` and `continueTask(taskId, inputs)` both create a new
queued `TaskTurn`. `startTask` is valid before the first turn; `continueTask` is
valid after at least one settled turn.

If dependencies are unresolved, the queued turn records start intent but is not
spawned. When dependencies resolve, the engine either schedules it or applies the
dependency's `onUnsatisfied` policy.

There may be at most one queued or active turn per task.

### 5.3 Interrupting and cancelling

- `interruptTurn(turnId)` aborts a live process and marks that turn
  `interrupted`. The task remains `open`.
- `retryTurn(turnId, recoveryInstruction)` creates a new turn. It does not revive
  or continue the same process.
- `cancelTask(taskId, cascadePolicy)` is terminal and marks the task `cancelled`.
- UI **Pause** maps to `interruptTurn`; UI **Cancel** maps to `cancelTask`.

Do not expose both `pause` and `stop` unless they have genuinely different domain
semantics.

### 5.4 Continuations after terminal outcomes

A terminal task is read-only. A user follow-up creates a new task with
`continuationOf` referencing the prior task. It receives a fresh session, or a
backend-native fork when explicitly supported. It never shares the old session ID.

The UI may group continuation tasks into one user-facing history, but dependency
nodes remain immutable.

---

## 6. Turn lifecycle and disposition commit

```text
queued ──scheduler starts process──► running
running ──ask_user registered──────► waiting_user
waiting_user ──answer submitted────► running
running ──adapter turnCompleted────► succeeded
running ──adapter error────────────► failed
running/waiting_user ──abort───────► interrupted | cancelled
```

Exactly one adapter terminal event closes a running turn, as defined by
`ADAPTER-SPEC.md`.

### 6.1 Applying a successful turn

On adapter `turnCompleted`, the engine atomically:

1. Marks the turn `succeeded`.
2. Commits the session ID according to §10.
3. Applies the staged disposition:
   - `complete` → task `succeeded`, bounded `result` persisted;
   - `fail` → task `failed`, bounded `error` persisted;
   - `wait_tasks` → task stays open and receives a child wait set;
   - `idle` or no disposition → task stays open without an automatic next turn.
4. Marks user-message inputs assigned to that turn as `complete`.
5. Emits task and turn updates.

A staged disposition is discarded if the adapter turn fails or is interrupted.
This prevents an MCP call made early in a failed invocation from prematurely
changing the task outcome.

Delegated prompts must instruct workers and coordinators to explicitly call
`complete_task`, `fail_task`, or `wait_for_tasks`. Missing disposition safely falls
back to `idle`; execution policy may later time out or fail an abandoned task.

### 6.2 Applying a failed turn

A failed turn does not automatically mean the domain work is impossible. The
task's execution policy decides whether to:

- enqueue a bounded retry;
- leave the task open for user/coordinator recovery; or
- mark the task `failed` after automatic retries are exhausted.

Policy decisions and retry turn IDs are persisted so reload cannot duplicate them.

---

## 7. Dependencies

For every `TaskDependency`:

- `requiredOutcome: 'settled'` is satisfied by any terminal dependency outcome.
- `requiredOutcome: 'succeeded'` is satisfied only by `succeeded`.
- A terminal non-success applies `onUnsatisfied`:
  - `block`: leave the task open and show the failed dependency;
  - `fail`: mark the dependent task failed;
  - `skip`: mark the dependent task skipped.

Dependencies must refer to tasks in the same root task graph unless a future
cross-root policy explicitly allows otherwise. The engine rejects cycles at create
or during a pre-start dependency update; dependencies become immutable when the
first turn is queued.

`dependencies` are the source of truth. Do not also persist equivalent task
blockers.

---

## 8. Coordinator protocol

Coordinator turns receive host-scoped task-management MCP tools. Workers receive
`ask_user`, progress tools, and self-disposition tools, but not graph-extension
tools.

### 8.1 Tool surface

| Tool | Caller | Purpose |
|------|--------|---------|
| `create_task` | Coordinator | Create a direct child without starting it |
| `delegate_task` | Coordinator | Atomically create a direct child and queue its first turn |
| `start_task` | Coordinator | Queue the first turn of an existing direct child |
| `interrupt_task` | Coordinator | Interrupt an active direct child turn |
| `cancel_task` | Coordinator | Terminally cancel a direct child according to policy |
| `wait_for_tasks` | Coordinator | Stage the caller turn's explicit child wait set |
| `get_task_status` | Coordinator | Read an authorized subtree summary |
| `complete_task` | Any task | Stage successful task completion on the caller turn |
| `fail_task` | Any task | Stage failed task completion on the caller turn |
| `report_progress` | Any task | Update optional progress metadata |
| `ask_user` | Any task | Block the caller's live turn for structured user input |

Tool names describe requested host actions. The MCP response confirms acceptance;
it does not bypass engine validation.

Each turn has at most one staged disposition. Repeating the same disposition with
the same tool-call/operation ID is idempotent; a conflicting disposition is
rejected. The engine derives mutation idempotency from `(turnId, toolCallId)` or an
equivalent stable operation ID.

### 8.2 Explicit child waiting

Coordinators never block a live CLI process while children run:

```text
1. Coordinator turn delegates or starts child tasks.
2. Coordinator calls wait_for_tasks({ taskIds }).
3. The MCP call stages TurnDisposition.wait_tasks and returns immediately.
4. Coordinator finishes its CLI turn.
5. On turnCompleted, the engine commits the wait set and releases the process.
6. Child tasks progress independently.
7. When every waited task is terminal, the engine queues one continuation turn.
8. That turn receives structured `child_results` followed by pending user messages
   in a deterministic order.
```

Only IDs explicitly passed to `wait_for_tasks` belong to the barrier. A child may
be fire-and-forget. A child that settles before the parent turn finishes is still
handled correctly: after committing the wait set, the engine immediately observes
that the barrier is complete and queues the continuation.

The wait set is keyed by the registering parent turn ID. Completion handling and
continuation creation use idempotency keys, preventing duplicate parent turns after
races or reload.

### 8.3 Child outcomes

All terminal child outcomes settle a wait barrier. They do not automatically fail
the parent. The continuation input contains each child's outcome plus a bounded
result or error, and the coordinator decides what to do next.

Child output is untrusted model-produced data. The continuation prompt must frame
it as structured child results, enforce size limits, and preserve message
boundaries rather than concatenating it with user instructions.

### 8.4 Authorization and resource policy

Every turn receives a short-lived bridge credential scoped to:

- root task ID;
- caller task ID;
- turn ID;
- allowed actions;
- expiry.

The host validates direct-child ownership and current state on every mutation.
Tool-list filtering improves prompting but is not the authorization boundary.

Default host policy must set finite limits for at least:

- maximum coordinator depth;
- maximum children per task and per root;
- maximum turns per task;
- maximum concurrently running turns;
- result size and task timeout.

---

## 9. User messages and focused-task chat

`send(taskId, message)` targets the focused task, but only while that task is open.

| Derived task state | Behavior |
|--------------------|----------|
| `idle` | Create a user-triggered queued turn |
| `waiting_dependencies` / `queued` | Persist the message as pending input |
| `running` / `waiting_user` | Persist it; do not inject it into the live process except through `submitAsk` |
| `waiting_children` / `blocked` | Persist it for the next continuation turn |
| `needs_recovery` | Persist it and offer explicit Retry or Continue recovery |
| terminal | Read-only; offer **Continue as new task** |

Chat messages are durable records, not raw queued strings. They provide both the
task transcript and delivery identity:

```ts
type TaskMessageState =
  | 'pending'
  | 'assigned'
  | 'complete'
  | 'partial';

interface TaskMessage {
  id: string;
  taskId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  state: TaskMessageState;
  createdAt: string;
  turnId?: string;
}
```

For user messages, `pending` means not yet assigned to a turn and `turnId` identifies
the assigned turn. Assistant output may be persisted as `partial` while streaming
and changed to `complete` on successful turn settlement. Assignment is atomic.
Messages are never silently deleted or reassigned after process failure; the prior
turn remains inspectable for explicit recovery and duplicate-send decisions.

Immediately before a queued turn becomes `running`, the engine atomically assigns
eligible pending messages, writes their IDs into `TurnInput`, and persists both
records. Messages arriving after process spawn remain pending for a later turn.

Opening a child lets the user inspect its stream, answer that child's `ask_user`,
or send a follow-up while it remains open. A direct parent observes only persisted
child outcome/result updates, not private session history.

---

## 10. Session ownership and failure ambiguity

Each task stores only its committed session ID. Each turn may store a candidate or
observed ID while it runs.

### 10.1 Successful turn

On `turnCompleted`, choose the session ID using the backend-specific fallback chain
from `SESSION-MANAGEMENT.md`, then commit it to the task. The task's backend binding
was fixed at creation and does not change when the session is committed.

### 10.2 Failed or interrupted turn

Do not replace the committed session ID. However, this does not roll back CLI-owned
history: a backend may already have persisted partial output under the same ID.

Therefore:

- never describe recovery as continuing the same process or turn;
- never automatically replay the old prompt;
- retain the old turn and candidate ID for diagnosis;
- make retry versus continue an explicit recovery decision;
- warn that a continued backend session may contain partial prior state.

For a first turn with no committed ID, a failed candidate session is not adopted
automatically. Recovery starts fresh unless the user or a verified backend-specific
policy explicitly adopts it.

---

## 11. Scheduling and concurrency

Correctness requires serialization per task/session, not globally per backend.

The scheduler enforces:

- at most one queued or active turn per task;
- at most one active turn for a session ID;
- backend-specific concurrency limits;
- global/root concurrency and resource limits.

Different tasks using the same backend may run concurrently because they own
different sessions, provided that backend is declared concurrency-safe. A backend
may conservatively default to concurrency `1` until verified; that is a backend
policy, not a task-model invariant.

---

## 12. Persistence and reload recovery

### 12.1 Task store

The MVP store may use `.muster-tasks.json`, but its envelope must include a schema
version and store revision:

```ts
interface TaskStoreFile {
  schemaVersion: number;
  revision: number;
  tasks: Record<string, MusterTask>;
  turns: Record<string, TaskTurn>;
  messages: Record<string, TaskMessage>;
}
```

Requirements:

- atomic replacement protects against partial files;
- a single-writer or compare-and-swap strategy prevents lost updates across VS
  Code windows;
- migrations are explicit and versioned;
- corrupt files are preserved for recovery instead of overwritten;
- `.muster-tasks.json` is gitignored and treated as potentially sensitive local
  data;
- retention/pruning policy bounds old turns and model output.

Derived indexes such as root IDs, child IDs, and view statuses are rebuilt from
authoritative records.

### 12.2 Reload algorithm

On extension activation:

1. Load and migrate the store.
2. Mark persisted `running` and `waiting_user` turns as `interrupted`.
3. Cancel their in-memory AskBridge entries; answers cannot resume dead processes.
4. Leave their tasks `open` for explicit recovery or execution policy.
5. Preserve child wait sets. Child tasks with interrupted turns remain unsettled.
6. Reconcile terminal children and idempotently create any missing continuation
   turn for a completed wait set.
7. Do not spawn or replay a CLI process automatically.
8. Present queued/recovery actions to the user and resume scheduling only after an
   explicit host or user action.

An inactive coordinator waiting for children has no process to pause. Its persisted
wait set is sufficient to recover orchestration state.

---

## 13. Engine responsibilities

`TaskEngine` is the single authority for task and turn transitions. It:

- validates graph ownership, cycles, capabilities, and limits;
- creates and persists tasks, turns, messages, wait sets, and dispositions;
- schedules turns through backend adapters;
- maps adapter events to the correct task and turn;
- commits session identity only after successful turns;
- routes AskBridge requests by task and turn ID;
- resolves dependencies and child barriers;
- applies retries and execution policy;
- emits task/turn patches to the webview;
- performs reload reconciliation and idempotent continuation scheduling.

`TaskStore` persists state but does not decide transitions. Backend adapters execute
turns but do not decide task outcomes.

---

## 14. Webview mapping

### 14.1 Screens

| Screen | Content |
|--------|---------|
| Task list | Root tasks and continuation grouping, derived status, updated time, **New task** |
| Task workspace | Task subtree plus the focused task's session thread |

Clicking **New task** opens an unpersisted composer. The first submitted message
creates the root coordinator task with that message as its goal and queues its first
turn. This avoids creating empty root tasks.

### 14.2 Protocol identity

All turn-scoped messages carry both `taskId` and `turnId`:

```text
turnStart      { taskId, turnId }
event          { taskId, turnId, event }
turnDone       { taskId, turnId }
turnError      { taskId, turnId, error }
askPending     { taskId, turnId, askId, questions }
taskUpdated    { taskId, revision, patch }
```

The webview ignores late events whose `turnId` is no longer active for that task.
`submitAsk` must include `taskId`, `turnId`, and `askId`.

### 14.3 Terminal tasks

Terminal threads are read-only. **Continue as new task** creates a continuation
task and focuses it. The UI may visually group the continuation with the prior
thread without changing the old task outcome.

---

## 15. Implementation phases

### Phase A — Domain types and transition tests

- [ ] `MusterTask`, `TaskTurn`, dependency, disposition, message, and store-envelope types
- [ ] Pure derived-status function
- [ ] Transition table/tests for every task and turn operation
- [ ] Dependency cycle and failure-policy tests
- [ ] Idempotency tests for child completion and continuation scheduling

### Phase B — Store and single-task engine

- [ ] Versioned `TaskStore` with atomic and concurrent-writer protection
- [ ] `TaskEngine` for one task/session and multiple turns
- [ ] Successful session commit and interrupted-turn recovery
- [ ] Explicit completion/failure disposition

### Phase C — Coordinator orchestration

- [ ] Scoped bridge credentials and host authorization
- [ ] Create/delegate/start child tools
- [ ] Explicit `wait_for_tasks` barrier
- [ ] Dependency resolution, retries, and resource limits

### Phase D — Webview

- [ ] Root task list and first-message task creation
- [ ] Focused task navigation and `taskId` + `turnId` protocol
- [ ] Durable messages/pending-input delivery and child `ask_user` interaction
- [ ] Continuation task UX

### Phase E — Migration and cleanup

- [ ] Migrate legacy `.muster-sessions.json` users
- [ ] Make task flow the default
- [ ] Remove legacy flat session path
- [ ] Add retention, archival, and recovery UI

---

## 16. Resolved design decisions

| Topic | Decision |
|-------|----------|
| Domain terminology | Use Task, Backend, Session, Turn, Process, and Engine; retire Executor |
| Main agent | Root coordinator is a normal task with host-issued coordinator policy |
| State model | Persist task lifecycle and turn status separately; derive UI status |
| Completion | Adapter `turnCompleted` completes only a turn; task disposition is explicit |
| Child waiting | Explicit turn-scoped wait set; no implicit per-turn spawn batch |
| Child failure | Settles the barrier but does not automatically fail the parent |
| Dependencies | Declare required outcome and failure policy |
| Terminal follow-up | Create immutable continuation task; never reopen a dependency node |
| Concurrency | Serialize per task/session, then apply backend and global limits |
| Interruption | Aborted/reloaded process becomes an immutable interrupted turn |
| Reload | Reconcile persisted state; never silently replay a process |
| Persistence | Versioned task/turn/message store with one authoritative copy of each fact |
| Delegation safety | Scoped authorization plus finite depth, count, turn, timeout, and concurrency limits |

---

## 17. References

- `docs/DESIGN.md` — per-turn process architecture
- `docs/SESSION-MANAGEMENT.md` — CLI session identity and backend resume behavior
- `docs/ADAPTER-SPEC.md` — exactly-one terminal event contract
- `docs/MUSTER-BRIDGE.md` — MCP transport, AskBridge, and bridge security
- `docs/WEBVIEW.md` — rendering and message protocol
