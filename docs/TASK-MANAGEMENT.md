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

**Outcome model (normative):** task **lifecycle** (open / succeeded / failed /
cancelled / skipped) is a **work outcome**, not the CLI process status. A new
task is always `open`. Lifecycle is sealed only by an **authorized actor** — the
**user** and/or a **coordinator task** when the user has enabled outcome
delegation (including a future **yolo** / full handoff mode). CLI turn success,
process exit, and adapter errors never by themselves set lifecycle to
`succeeded` / `failed` / `skipped`. Webview and host projections keep **three
separate axes**: task lifecycle, CLI process status, and orchestration activity
(see §4.3, §4.1.1, and §5).

---

## 1. Goals and boundaries

Muster coordinates durable units of work while invoking per-turn **ACP sessions**
(one `session/new` or `session/load` per adapter `run()`). The design must support:

- a root coordinator for each user request;
- delegated worker and sub-coordinator tasks;
- explicit dependencies and child wait sets;
- multiple turns backed by one CLI conversation per task;
- **authorized outcome sealing** — user always; coordinator when user delegates
  (default supervised gate; future **yolo** handoff for self-orchestration);
- deterministic cancellation (with cascade), soft-fail reopen, and reload recovery;
- host-enforced orchestration policy and resource limits.

This document does not standardize backend-specific CLI flags, normalized stream
events, or visual rendering details. Those belong to the related documents.

---

## 2. Glossary

| Term | Definition | Lifetime |
|------|------------|----------|
| **Task** | A unit of work with a goal, dependencies, policy, and user-facing **lifecycle** outcome | Until hard terminal; soft `failed` may reopen |
| **Lifecycle** | Persisted work outcome (`open` / `succeeded` / `failed` / `cancelled` / `skipped`) | Independent of CLI process |
| **CLI process status** | Whether a CLI process exists and is busy/idle/stopped (see §4.3.2) | Ephemeral / derived; not task outcome |
| **CLI last exit** | How the last process ended (`ok` / `error` / `cancelled` / …) — not a process phase | Attached when process is stopped |
| **Orchestration activity** | Graph/scheduling waits while open (deps, children, recovery, outcome proposal) | Ephemeral / derived |
| **Runtime activity** | Host-derived open-task activity (legacy compact name for orchestration + turn live signals) | Ephemeral / derived |
| **Outcome proposal** | Request to mark complete/fail; awaits an authorized sealer when not auto-sealed | Cleared on accept/reject/cancel/seal |
| **Outcome authority mode** | Who may seal lifecycle: user only vs user + delegated coordinator (yolo later) | Per root / workspace setting |
| **Backend** | A reusable adapter for one CLI family such as Claude, Codex, or Grok | Extension lifetime |
| **Session** | Backend-owned conversation history used by one task | Task lifetime |
| **Turn** | One requested interaction with a task's session | One CLI invocation |
| **Process** | The operating-system (or agent) process used to execute a turn | While that process is up |
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
   one CLI invocation succeeded. CLI process status never becomes task lifecycle.
2. **Lifecycle is sealed by authorized actors, never by the CLI.** A task leaves
   `open` for `succeeded` / `failed` / `skipped` / `cancelled` only via the
   **user** or an authorized **coordinator**, according to the active
   **outcome authority mode** (§4.1.1). Turn completion and process exit never
   seal lifecycle by themselves.
3. **Default is supervised; delegation is explicit.** In the default mode,
   coordinators **propose** outcomes and the user accepts/rejects. When the user
   enables **coordinator delegate** (and later **yolo**), a coordinator may
   **seal** outcomes in its scope without a per-decision human click. The user
   always retains override (cancel, skip, reject, reopen soft-fail, change mode).
4. **Lifecycle and runtime are separate axes.** Persisted `TaskLifecycleState` is
   the work outcome. Turn status, dependency readiness, child waits, and recovery
   needs are **runtime / activity** facts. They must not be collapsed into one
   enum that the UI treats as “the task status.”
5. **Create always yields `open`.** No other lifecycle is written at creation.
6. **Hard vs soft terminal:**
   - `succeeded`, `cancelled`, and `skipped` are **hard terminal** for
     dependents/outcome observation (the sealed node stays historically terminal
     until reopened). A new user **message on the same task id reopens** to
     `open` and may queue a turn; operators may still create a new/continuation
     task instead.
   - `failed` is **soft terminal**: no automatic coordinator turns; a new user
     message **reopens** the same task to `open` and may queue a turn. This is
     not a continuation task.
   - **Semantics:** `skipped` = created but user chose **not to perform**;
     `cancelled` = stop work that was (or could be) in progress; `failed` =
     user marked the attempt unsuccessful. See §5.6.
7. **Cancel cascades.** User cancel on a task marks that task and every
   descendant `cancelled`, interrupts live turns, and clears pending proposals.
   Workspace **revert of agent edits** is a planned future side effect, not
   required for the lifecycle transition itself. Skip on a parent may cascade
   skip (or cancel live work) on unfinished descendants — see §5.6.
8. **One task owns one session.** Session IDs are never shared by tasks.
9. **Identity is stable.** Parent, role, and backend binding do not change after
   task creation; dependencies do not change after the first turn is queued.
10. **One active turn per task/session.** Different tasks may run concurrently when
    backend limits allow it.
11. **Readiness is derived.** Dependency, scheduler, child-wait, and runtime state
    must not be copied into the persisted lifecycle field.
12. **Child waiting is explicit and turn-scoped.** The engine never infers a wait
    set from every child that happened to be started during a turn.
13. **The host is authoritative.** MCP calls express requested actions; the engine
    validates ownership, capability, state, and resource policy before applying them.
14. **Orchestration is idempotent.** Create, start, proposal staging, child
    completion, and continuation scheduling are keyed by stable operation or turn IDs.
15. **No automatic replay after uncertainty.** A process lost during reload becomes
    interrupted; Muster does not silently resend its input. Interrupted turns do
    not change lifecycle to `failed` or `cancelled` by themselves.
16. **Persist before side effects.** A queued/running turn and its input identity
    are stored before spawning a process.
17. **Delegation is bounded.** Depth, child count, turn count, and concurrency have
    host-configured limits even when sub-coordinators are enabled.

---

## 4. Domain model

The following types are design sketches. Concrete TypeScript may split records
between store modules, but must preserve their semantics.

### 4.1 Tasks

```ts
type TaskRole = 'coordinator' | 'worker';

/**
 * User-facing work outcome. Independent of whether a CLI process is running.
 * New tasks are always `open`.
 */
type TaskLifecycleState =
  | 'open'       // default; work may continue
  | 'succeeded'  // hard terminal — user accepted a completion proposal
  | 'failed'     // soft terminal — user rejected without reason (or explicit fail path)
  | 'cancelled'  // hard terminal — user aborted work in progress (cascades)
  | 'skipped';   // hard terminal — task exists but user chose not to perform it

/**
 * Agent (or host) proposal awaiting user decision. Does not change lifecycle
 * until the user accepts or rejects. Staged while the task remains `open`.
 */
type OutcomeProposal =
  | {
      kind: 'complete';
      result: string;
      proposedByTurnId: string;
      proposedAt: string;
    }
  | {
      kind: 'fail';
      error: string;
      proposedByTurnId: string;
      proposedAt: string;
    };

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

  // Outcome proposal (open tasks only) + sealed outcome fields
  outcomeProposal?: OutcomeProposal;
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
index, not duplicated task data. Child lifecycle and result are read from child
records; a persisted `childRuns` snapshot is not authoritative.

`capabilities` are issued and validated by the host. A caller cannot grant itself
new capabilities by passing them to `create_task`.

Default graph capabilities are:

| Role | Graph capabilities |
|------|--------------------|
| Root/sub-coordinator | Host-approved subset of all `TaskCapability` values |
| Worker | None; self-disposition and `ask_user` do not extend the graph |

#### 4.1.1 Outcome authority (who may seal lifecycle)

Lifecycle is a **governance** decision, not a process signal. Two classes of
actor may seal it:

| Actor | Always? | What they can do |
|-------|---------|------------------|
| **User** | Yes | Accept/reject proposals; cancel; skip; soft-fail reopen; change mode; always overrides the coordinator |
| **Coordinator task** | Only when mode allows | Seal `succeeded` / `failed` / `skipped` (and cancel children per policy) for tasks in its **authority scope** |

**Workers** never gain outcome-seal authority for the graph; they may only
propose self-completion or act through tools that the host routes to the parent
coordinator / engine.

##### Outcome authority mode

Host/workspace (or per-root) setting. Default is supervised so accidental YOLO
is impossible:

```ts
/**
 * Who may seal task lifecycle without a further human click.
 * User can always seal and always override.
 */
type OutcomeAuthorityMode =
  | 'user_confirm'           // default — supervised
  | 'coordinator_delegate'   // user delegated seal rights to coordinators
  | 'yolo';                  // future — full handoff / autonomous orchestration
```

| Mode | Root lifecycle seal | Child lifecycle seal | Intent |
|------|---------------------|----------------------|--------|
| **`user_confirm`** (default) | User only (Accept/Reject/Cancel/Skip). Coordinator **proposes** → `outcomeProposal`. | Parent coordinator may seal children for graph progress (orchestration), or also require proposals — product default: **coordinator may seal direct children** so waits can settle without N human clicks. | Safe default; human owns the user request. |
| **`coordinator_delegate`** | Root coordinator may seal its own root outcome (and descendants) via disposition / tools on turn commit. User still sees activity and may cancel/override. | Same as parent coordinator scope. | User says “you drive; mark done when you believe the goal is met.” |
| **`yolo`** (future) | Same seal path as `coordinator_delegate`, with **broader** defaults: higher concurrency/depth, fewer prompts, optional auto-continue. Still **not** CLI-exit → lifecycle. | Full subtree under the root coordinator. | User hands the job to the coordinator for self-orchestration (“fire and forget” within policy limits). |

```ts
// Illustrative placement — exact field may live on root task, workspace
// settings, or both (task overrides workspace default).
interface OutcomeAuthorityPolicy {
  mode: OutcomeAuthorityMode;
  /** When true, user still gets a non-blocking toast/card after coordinator seals. */
  notifyOnCoordinatorSeal?: boolean;
  /** Optional: even in delegate/yolo, require user confirm for root only. */
  alwaysConfirmRoot?: boolean;
}
```

##### Authority scope (coordinator)

When mode is `coordinator_delegate` or `yolo`, a coordinator may seal:

1. **Itself** (including the root coordinator sealing the root task), and
2. **Descendants** it is allowed to manage (`create_child` / cancel / skip tools),

subject to host capability checks and the same cascade rules as user cancel/skip.

A **sub-coordinator** seals only within its subtree, not sibling branches or the
root, unless the root mode and capabilities explicitly allow it.

##### What never seals lifecycle

- Adapter `turnCompleted` / process exit / non-zero exit alone  
- Exhausted automatic retries (leave `open` + `needs_recovery`, or coordinator
  *may* seal `failed` only if mode + tool path authorize it)  
- Reload / interrupted turns  
- Worker self-talk without host-validated tools  

##### Auditability

Every seal records **who** sealed it (for UI and debugging):

```ts
type OutcomeSealedBy =
  | { kind: 'user'; }
  | { kind: 'coordinator'; taskId: string; turnId?: string; mode: OutcomeAuthorityMode };

// On MusterTask when lifecycle leaves open:
// sealedBy?: OutcomeSealedBy;
```

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

/**
 * Staged by MCP on a live turn. On turnCompleted, host applies authority mode
 * (§4.1.1):
 * - If sealer is not authorized yet → `complete`/`fail` become outcomeProposal
 * - If coordinator is authorized (delegate/yolo, or child orchestration) → seal
 * - `wait_tasks` / `idle` → orchestration only (no lifecycle change)
 */
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

### 4.3 Status axes (normative)

Muster exposes **three independent axes**. Mixing them into one badge is a
product bug.

| Axis | Question | Where in UI (normative) |
|------|----------|-------------------------|
| **Task lifecycle** | Is the work open / done / failed / cancelled / skipped? | Task list badge + workspace header |
| **CLI process status** | Is a CLI process not started, running, idle (alive), or stopped? | Near composer / send–stop (process chrome) |
| **Orchestration activity** | Waiting on deps, children, recovery, outcome proposal? | Secondary line / action panels — not the task badge, not the CLI phase |

The store persists **lifecycle**, turns, dependencies, waits, and optional
`outcomeProposal`. CLI process status and orchestration activity are **derived**.

#### 4.3.1 Task lifecycle (persisted work outcome)

```ts
type TaskLifecycleState =
  | 'open' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
```

Primary task badge only. Never set from CLI exit alone. See §5.

#### 4.3.2 CLI process status

CLI status answers: **does a process exist, and is it generating?** It is
orthogonal to task lifecycle.

##### Internal layers (implementation)

```ts
/** Whether a process is up for this task’s current agent session. */
type CliProcessPhase =
  | 'not_started'  // never spawned for this task (or only queued, not yet spawned)
  | 'starting'     // optional: between schedule and first live event (may fold into not_started)
  | 'on'           // process is alive
  | 'stopped';     // process was up and has exited

/** What the live process is doing — only meaningful when phase === 'on'. */
type CliProcessActivity =
  | 'busy'          // streaming, tools, reasoning — “đang trả lời”
  | 'idle'          // alive but not generating (rare if each turn is one process)
  | 'waiting_user';  // alive, blocked on ask_user (still on)

/**
 * How the last process ended — NOT a peer of process phase.
 * Present when phase === 'stopped' (and optionally on history).
 */
type CliLastExit =
  | 'ok'          // clean turnCompleted / normal stop
  | 'error'       // adapter error, non-zero failure, missing terminal
  | 'cancelled'   // user/host interrupt or cancel of the live process
  | 'unknown';
```

**Error is not a CLI phase.** A failed run is:

- process **phase** → `stopped`, and  
- **lastExit** → `error` (or turn `failed` / recovery UI),  

not `CliProcessStatus = 'error'`. Tool errors mid-turn leave phase `on` and
activity `busy`; they are transcript events, not process phase.

##### Product-facing CLI view (MVP chip)

Collapse phase + activity into four user-visible values (composer chrome):

```ts
/**
 * Product CLI chip. Derived; never persisted as task.lifecycle.
 * Map: not_started | running (on+busy) | idle (on+idle|waiting_user) | stopped
 */
type CliViewStatus =
  | 'not_started'  // chưa bật — no process yet
  | 'running'      // đang bật + đang trả lời (on + busy)
  | 'idle'         // đang bật nhưng không generate (on + idle | waiting_user)
  | 'stopped';     // đã tắt — process exited (see lastExit for why)
```

| `CliViewStatus` | Phase | Activity | Typical labels |
|-----------------|-------|----------|----------------|
| `not_started` | `not_started` (or `starting`) | — | CLI not started |
| `running` | `on` | `busy` | CLI running |
| `idle` | `on` | `idle` or `waiting_user` | CLI idle / waiting for you |
| `stopped` | `stopped` | — | CLI stopped (+ optional last exit subtitle) |

Derivation sketch (from turns + live stream flags):

1. Live turn `status === 'running'` and generating (or webview `thread.running` without ask) → **`running`**.
2. Live turn `status === 'waiting_user'` (or process on but paused for ask) → **`idle`** (detail: waiting for you). Process is still **on**.
3. Turn `queued` only (not yet spawned) → **`not_started`** (optional: show Starting if `starting` is modeled).
4. Latest process settled, or orchestration with no live process (`needs_recovery`, `waiting_children`, `awaiting_outcome`, hard/soft terminal with prior process) → **`stopped`**; set `lastExit` from latest terminal turn when known.
5. Open task, never spawned → **`not_started`**.

**Reload / derive hints (webview):** until the host projects `cliViewStatus`, treat a prior process as known when `thread.hadProcess` is true **or** the task has a `committedSessionId` (bound conversation implies a prior successful process). Empty open task with neither → `not_started`.

Under Muster’s common **one process per turn** model, `on + idle` between user
messages is uncommon (process usually exits → `stopped`). `idle` is still
required for **ask_user** (process alive, not generating). If a backend later
holds a long-lived process between prompts, `idle` covers that too.

##### CLI vs task error

| Situation | CLI view | Task lifecycle |
|-----------|----------|----------------|
| Process crash / turn adapter error | `stopped` + `lastExit: error` | stays `open` (often orchestration `needs_recovery`) |
| User rejects completion without reason | `stopped` (or `not_started`) | soft `failed` |
| User accepts complete | `stopped` + `lastExit: ok` | `succeeded` |
| Tool error mid-stream | stays `running` | unchanged |

#### 4.3.3 Orchestration activity (open tasks)

Scheduling and graph waits — **not** CLI phase and **not** lifecycle:

```ts
type TaskRuntimeActivity =
  | 'idle'
  | 'queued'
  | 'running'              // live turn generating (feeds CLI view = running)
  | 'waiting_user'         // live ask_user (feeds CLI view = idle)
  | 'waiting_dependencies'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'
  | 'awaiting_outcome';
```

Evaluation order (only when `lifecycle === 'open'`):

1. Non-null `outcomeProposal` → `awaiting_outcome` (CLI usually already `stopped`).
2. Live turn → `running` or `waiting_user`.
3. Unsatisfied dependencies → `waiting_dependencies`.
4. Schedulable queued turn → `queued`.
5. `wait.kind === 'children'` → `waiting_children`.
6. `wait.kind === 'external'` → `blocked`.
7. Latest failed/interrupted turn, no replacement → `needs_recovery`.
8. Otherwise → `idle`.

```ts
/** Compact single-axis (legacy indexes only). Prefer explicit axes. */
type TaskViewStatus = TaskLifecycleState | TaskRuntimeActivity;
```

#### 4.3.4 Presentation rules (webview)

| UI surface | Shows |
|------------|--------|
| Task list badge | **Lifecycle only** (optional tiny live-process dot, not a second status word) |
| Workspace header | **Task status card** = header (name + lifecycle badge + status menu). No separate title row that repeats the same badge. **Expand details** (collapsed by default) shows lifecycle copy, optional orchestration one-liner, bound session id, continuation hint — not when collapsed. |
| Composer strip | **CLI view** (`not_started` / `running` / `idle` / `stopped`); optional lastExit when stopped |
| Action panels | Recovery, resume queue; outcome accept/reject when product ships dedicated card (today: lifecycle status menu) |

Composer / send rules use lifecycle **and** live CLI/orchestration (see §9).

Do not map adapter exit codes onto lifecycle. Do not use a single chip that
says both “Failed” (task) and “Running” (CLI) interchangeably from `turnDone`.

---

## 5. Task lifecycle (user-facing outcome)

```text
create ──────────────────────────────────────────────► open

open + agent proposes complete/fail ─────────────────► open (outcomeProposal set)
open + user Accept (complete proposal) ──────────────► succeeded   [hard]
open + user Reject complete WITH reason ─────────────► open        (reason → next turn input; clear proposal)
open + user Reject complete WITHOUT reason ──────────► failed      [soft]
open + user Accept fail proposal (if any) ───────────► failed      [soft]
open + user Reject fail proposal WITH reason ────────► open
open + user Cancel ──────────────────────────────────► cancelled   [hard, cascade]
open + user Skip ────────────────────────────────────► skipped     [hard; won’t perform]
failed + user sends message ─────────────────────────► open        (reopen; queue turn)
succeeded / cancelled / skipped + user sends message ► open        (reopen same id; queue turn)
succeeded / cancelled / skipped + explicit new work ─► new task (or continuationOf) optional
```

```text
                    ┌──────────────────────────────────────────────┐
                    │                    open                       │
                    │  (CLI may run / idle / wait children)         │
                    └───┬──────────┬──────────┬──────────┬─────────┘
       Accept complete  │   Cancel │     Skip │          │ Reject complete
                        ▼          ▼          ▼          │ no reason
                  succeeded   cancelled   skipped        ▼
                   [hard]      [hard]      [hard]      failed ──user msg──► open
                        work done   abort      won’t do   [soft]
```

### 5.1 Creating a task

`TaskEngine.createTask(input, callerContext)`:

1. Validates parent ownership and caller capability.
2. Validates dependency scope and rejects dependency cycles.
3. Applies host policy; the caller cannot choose arbitrary capabilities or limits.
4. Persists a task with **`lifecycle: 'open'`** and no `outcomeProposal`, without
   starting a turn (unless a convenience API also queues the first turn).
5. Returns the task ID, lifecycle, and derived runtime activity.

Task creation and task starting are separate operations. A convenience
`delegate_task` MCP tool may atomically create a child and queue its first turn.
Children are also created `open`.

### 5.2 Starting and continuing (runtime only)

`startTask(taskId, inputs)` and `continueTask(taskId, inputs)` both create a new
queued `TaskTurn`. They do **not** change lifecycle. `startTask` is valid before
the first turn; `continueTask` is valid after at least one settled turn while the
task is `open` (including after soft-fail **reopen**).

If dependencies are unresolved, the queued turn records start intent but is not
spawned. When dependencies resolve, the engine either schedules it or applies the
dependency's `onUnsatisfied` policy (see §5.6 for `skip`).

There may be at most **one active (running) turn** per task. Operators may stack
**multiple queued follow-ups** (FIFO); the scheduler promotes one-at-a-time after
settlement. See §9.1.

### 5.3 Outcome sealing (user and coordinator)

Lifecycle is sealed by **authorized actors** (§4.1.1), never by CLI exit alone.

Shared tool path: during a live turn the agent calls `complete_task` /
`fail_task` / skip tools. The engine **stages** a disposition, then on
`turnCompleted` either **proposes** or **seals** according to mode and role.

#### 5.3.1 Supervised path (`user_confirm` — default)

Proposal / approval: the coordinator asserts “I think we’re done”; the **user**
seals (especially the root).

1. Stage disposition on the live turn.
2. On `turnCompleted`:
   - turn status → `succeeded` (CLI OK only);
   - for root (and any task requiring confirm): copy into `outcomeProposal`;
     lifecycle stays `open`;
   - for children under default orchestration policy: parent coordinator may
     already be allowed to seal the child (graph progress).
3. Webview shows an **outcome card** when a proposal awaits the user.
4. User actions:

| User action | Lifecycle | Side effects |
|-------------|-----------|--------------|
| **Accept** complete proposal | `succeeded` | Persist `result`; clear proposal; `finishedAt`; `sealedBy: user` |
| **Reject** complete **with reason** | stays `open` | Clear proposal; inject reason; may auto-queue continuation turn |
| **Reject** complete **without reason** | `failed` | Soft terminal; no automatic further turns; `sealedBy: user` |
| **Accept** fail proposal | `failed` | Soft terminal; `sealedBy: user` |
| **Reject** fail proposal **with reason** | stays `open` | Clear proposal; coordinator may continue |
| **Reject** fail proposal **without reason** | stays `open` (default) | Clear proposal; user declined the agent’s self-fail |

#### 5.3.2 Delegated path (`coordinator_delegate` and future `yolo`)

User has **turned on** outcome delegation so the coordinator can mark success
(and other outcomes) without a per-decision click — including sealing the **root**
when the goal is met. This is the foundation for later **yolo**: hand the job to
the root coordinator for self-orchestration within host limits.

1. Stage disposition as today (`complete` / `fail` / skip / cancel-child tools).
2. On `turnCompleted`, if the caller is a coordinator **and** mode + capabilities
   authorize the target task:
   - seal lifecycle immediately (`succeeded` / `failed` / …);
   - set `sealedBy: { kind: 'coordinator', taskId, turnId, mode }`;
   - **do not** require `outcomeProposal` / Accept card (optional notify toast).
3. If authorization fails (worker, wrong subtree, mode is `user_confirm` for that
   target), fall back to proposal or reject the tool.

| Mode | Typical root behavior on `complete_task` |
|------|------------------------------------------|
| `user_confirm` | Proposal → user Accept/Reject |
| `coordinator_delegate` | Coordinator seals `succeeded` on the root when it completes its own turn with `complete` |
| `yolo` | Same seal mechanics as delegate; policy defaults favor autonomy (limits, auto-continue, fewer UI blocks) |

**User override is never removed:** cancel, skip, soft-fail reopen, force-fail,
and switching mode back to `user_confirm` always work. A coordinator seal does
not lock the user out of the workspace.

**Yolo (future product):** not a separate state machine — it is
`OutcomeAuthorityMode = 'yolo'` plus looser execution policy (depth, concurrency,
timeouts, optional auto-retry). Lifecycle rules stay: only user or authorized
coordinator seals; CLI never does.

### 5.4 Interrupting (runtime) vs cancelling (lifecycle)

| UI / API | Domain effect | Lifecycle |
|----------|---------------|-----------|
| **Pause / Stop turn** → `interruptTurn` | Abort live process; turn → `interrupted` | stays `open` |
| **Cancel task** → `cancelTask` (or `setTaskLifecycle` → `cancelled`) | Task + **all descendants** → `cancelled`; live turns cancelled; proposals cleared | hard terminal |
| **Skip task** → `skipTask` (or `setTaskLifecycle` → `skipped`) | Authorized actor marks **won’t perform**; cascades unfinished descendants; see §5.6 | hard terminal |
| **User status menu** → `setTaskLifecycle` | Direct lifecycle seal from UI: `succeeded` / `failed` / `open` (soft reopen only) / routes cancel & skip as above | per target state |

- `retryTurn` / recovery create a **new** turn; they never revive a dead process
  and never set lifecycle by themselves.
- Do not expose both `pause` and `stop` unless they have genuinely different
  domain semantics.
- **Revert workspace changes** on cancel is **out of scope for the lifecycle
  transition**; track as a future enhancement (e.g. snapshot/worktree rollback).
  Cancel must still succeed as a pure state transition without revert.

### 5.5 Soft fail reopen vs hard terminal continuation

| State | User wants more work | Mechanism |
|-------|----------------------|-----------|
| `failed` (soft) | Send a message on the **same** task | Reopen → `open`, clear `finishedAt` / optional error retention for history, queue turn |
| `succeeded` / `cancelled` / `skipped` (hard) | Follow-up or “do it after all” | Same as soft-fail: next `send` **reopens** the same task id to `open` and may queue a turn. Operators may still create a **new task** / continuation instead |

The UI may group related work visually. Reopen keeps the same task id; a second
task ID is created only when the user explicitly starts a new task.

### 5.6 `skipped` — created, user chooses not to perform

`skipped` means: the task **record exists** (created by user, coordinator, or
graph), but an **authorized actor decided it will not be executed**. It is a
deliberate “won’t do,” not an error and not an abort of in-flight work.

| Aspect | Rule |
|--------|------|
| Who sets it | **User** always; **coordinator** when outcome mode allows (`coordinator_delegate` / `yolo`) for tasks in scope. Dependency policy `onUnsatisfied: 'skip'` may also mark a blocked dependent skipped (host policy, not CLI). Workers do not seal skip on the root without going through coordinator tools + mode checks. |
| When | Typically while `open`, often **before** meaningful work (no turns, or only idle). If a live turn exists, skip should interrupt/cancel that turn first, then seal `skipped` (or product may require cancel instead when work already started — prefer: skip allowed anytime on `open`, with interrupt of live process). |
| vs `cancelled` | **Cancel** = stop / abandon work that was accepted as in progress. **Skip** = choose not to do this unit of work (backlog triage, “not now / not this”). |
| vs `failed` | **Failed** = attempt judged unsuccessful. **Skipped** = never (or no longer) attempting. |
| Descendants | Default: unfinished descendants are also **skipped** (or cancelled if they had live turns — implementation may map live children → cancel process then skip). Cascade must leave no open orphan work under a skipped parent. |
| Hard terminal | Composer stays writable; next `send` reopens same id to `open`. New task remains available if preferred. |
| Wait / deps | Settles wait barriers. Does **not** satisfy `requiredOutcome: 'succeeded'`. Dependents with `onUnsatisfied: 'skip'` may themselves become `skipped`. |
| CLI | Never maps process exit or missing disposition to `skipped`. |

Host path (implemented): webview posts `setTaskLifecycle { taskId, lifecycle: 'skipped' }`;
host routes to engine `skipTask` (cascade + interrupt live turns). Optional `reason`
may be added later for transcript/history only.

### 5.7 Settled outcomes for waits and dependencies

For child wait barriers and dependencies:

- `succeeded`, `failed`, `cancelled`, and `skipped` all **settle** a wait set
  (barrier complete).
- Only `succeeded` satisfies `requiredOutcome: 'succeeded'`.
- Soft-fail reopen of a dependency after a parent has already continued is an
  advanced case: parents that already consumed a settled barrier do not re-fire;
  new work uses new turns / new wait sets.

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

1. Marks the turn `succeeded` (**turn** status only).
2. Commits the session ID according to §10.
3. Applies the staged disposition **without conflating it with CLI success**,
   using outcome authority (§4.1.1, §5.3):
   - **`complete` / `fail` + sealer authorized** (user already confirmed offline
     N/A; **coordinator** under `coordinator_delegate` / `yolo`, or child under
     orchestration policy) → **seal** lifecycle, set `sealedBy`, clear proposal.
   - **`complete` / `fail` + sealer not authorized** → stage/refresh
     `outcomeProposal`; lifecycle stays `open` until user (or later authorized
     coordinator) seals.
   - `wait_tasks` → task stays `open` and receives a child wait set.
   - `idle` or no disposition → task stays `open` without an automatic next turn
     and without a new outcome proposal.
4. Marks user-message inputs assigned to that turn as `complete`.
5. Emits task and turn updates (lifecycle + proposal + runtime activity + mode).

A staged disposition is discarded if the adapter turn fails or is interrupted.
This prevents an MCP call made early in a failed invocation from becoming a
completion proposal or an unauthorized seal.

Agents should call `complete_task` / `fail_task` or `wait_for_tasks` when
appropriate. Missing disposition safely falls back to `idle`. Turn/task
**timeouts** are runtime events: leave `open` + `needs_recovery`, unless an
authorized coordinator explicitly seals `failed` under delegate/yolo policy.

### 6.2 Applying a failed turn

A failed **turn** does not mean the **task** lifecycle is `failed`. The task
stays `open`. Execution policy may:

- enqueue a bounded automatic retry; or
- leave the task open for user/coordinator recovery (`needs_recovery`).

Do **not** auto-transition lifecycle to `failed` solely because retries are
exhausted. Sealing `failed` requires an authorized actor (§5.3) — user action or
coordinator under delegate/yolo — not the CLI. Policy decisions and retry turn
IDs are persisted so reload cannot duplicate them.

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
| `cancel_task` | Coordinator | Request cancel of a direct child (host may cascade per policy) |
| `wait_for_tasks` | Coordinator | Stage the caller turn's explicit child wait set |
| `get_task_status` | Coordinator | Read an authorized subtree summary (lifecycle **and** runtime activity) |
| `complete_task` | Any task | Stage successful completion; **seal or propose** per outcome mode + role (§4.1.1) |
| `fail_task` | Any task | Stage failure; seal or propose per mode + role |
| `report_progress` | Any task | Update optional progress metadata |
| `ask_user` | Any task | Block the caller's live turn for structured user input |

Tool names describe requested host actions. The MCP response confirms the host
**accepted the staging** (and, when mode allows, that a seal will apply on
`turnCompleted`). Under `user_confirm`, staging is not a root lifecycle seal.

Each turn has at most one staged disposition. Repeating the same disposition with
the same tool-call/operation ID is idempotent; a conflicting disposition is
rejected. The engine derives mutation idempotency from `(turnId, toolCallId)` or an
equivalent stable operation ID.

User decisions and mode control are **host/webview commands** (not MCP). Implemented
today: `setTaskLifecycle` (user status menu; cancel/skip cascade via engine). Planned
dedicated cards: `acceptOutcome`, `rejectOutcome { reason?: string }`,
`setOutcomeAuthorityMode { mode }`.

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

`send(taskId, message)` targets the focused task. Lifecycle and runtime activity
both constrain behavior:

| Lifecycle | Runtime activity (if open) | Behavior |
|-----------|----------------------------|----------|
| `open` | `idle` | Queue a user-triggered turn (`send`) |
| `open` | `waiting_dependencies` / `queued` | `send` creates another distinct FIFO queued turn (or binds per engine policy); inspect / edit / delete via `queuedTurns` |
| `open` | `running` | `send` queues a FIFO follow-up; **Ctrl+Enter** may call `sendLiveInput` for concurrent inject when supported (no queue fallback). `submitAsk` remains the path for structured ask answers |
| `open` | `waiting_user` | Answer the pending ask via `submitAsk`; free-form composer may still queue follow-ups when product policy allows |
| `open` | `waiting_children` / `blocked` | Persist / queue for the next continuation turn |
| `open` | `needs_recovery` | Persist; offer explicit Retry / Continue recovery (free-form send blocked while recovery is required) |
| `open` | `awaiting_outcome` | Prefer Accept/Reject when an outcome card exists. **Composer stays writable:** a new `send` clears `outcomeProposal`, keeps lifecycle `open`, and queues a turn (continue session). Do **not** block send solely because a proposal is pending. |
| `failed` (soft) | — | **Reopen** to `open`, then queue a turn with the message |
| `succeeded` / `cancelled` / `skipped` | — | **Reopen** to `open` on the same task id, then queue a turn (same as soft-fail). Operators may still create a new task instead |

### 9.1 Multi-queued FIFO follow-ups and live inject

**Normative send rule (R012):** every focused-task `send` creates a **distinct queued turn** bound to that user message, or **refuses visibly** when a turn cannot be allocated (turn cap, hard recovery block). Concurrent sends while a turn is live or already queued still create additional queued turns; the scheduler promotes **one active (running) turn per task**, only the **earliest** queued sequence (FIFO), and drains **multiple queued follow-ups** in order after **successful** settlement. After failure/interrupted settlement, queued follow-ups remain queued (not auto-promoted) until recovery/resume policy allows.

| Operator action | Engine / host API | Notes |
|-----------------|-------------------|-------|
| Enter / Send | `send` | FIFO follow-up turn; composer stays editable while running/queued |
| Ctrl+Enter while running | `sendLiveInput` | Concurrent instruction into the locally owned active session when capability evidence exists. **No queue fallback** on refusal |
| Ctrl+Enter while idle | `send` | Immediate normal turn (same as Enter); not inject |
| Edit pending queue item | `editQueuedTurn` | Only while `turnId` remains in the live `queuedTurns` projection; clears stale `agentContent` |
| Delete pending queue item | `deleteQueuedTurn` | Undispatched only; never cancels a running turn |

**Projection:** snapshots include optional `queuedTurns` (`turnId`, `sequence`, `status: 'queued'`, `messageIds`, `createdAt`) so the webview can render an inspectable FIFO panel and lock edit/delete at the dispatch boundary.

**Live inject outcomes:**

- Success → `liveInputResult` `{ taskId, code: 'delivered', sessionId }` (webview status notice).
- Refusal (unsupported backend, not local owner, no active turn, validation failure, engine not ready, …) → sanitized `commandError`. Never invent a queued turn from a refused inject.
- Stale `editQueuedTurn` / `deleteQueuedTurn` (missing, foreign, or already dispatched turn) → `commandError` with a clear stale-mutation message; controls should already be locked when the projection drops the turn.

`sendLiveInput` is distinct from `continueTask` / `send`: inject does not allocate a new turn. Webview keyboard policy maps Ctrl/Meta+Enter to `sendLiveInput` only when a live turn is running; otherwise Ctrl/Meta+Enter uses `send`.

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

- at most one **active (running)** turn per task (multiple queued follow-ups allowed; FIFO drain — §9.1);
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
- creates and persists tasks, turns, messages, wait sets, dispositions, and
  outcome proposals;
- applies **user** accept/reject/cancel/skip/reopen decisions to lifecycle;
- applies **coordinator** seals when outcome authority mode allows (§4.1.1);
- enforces outcome mode and capability scope on every seal;
- schedules turns through backend adapters;
- maps adapter events to the correct task and turn (**turn** status only for CLI);
- commits session identity only after successful turns;
- routes AskBridge requests by task and turn ID;
- resolves dependencies and child barriers;
- applies retries and execution policy without CLI-driven lifecycle seals;
- emits task/turn patches with lifecycle + runtime activity + authority mode;
- performs reload reconciliation and idempotent continuation scheduling;
- cascades cancel/skip to descendants.

`TaskStore` persists state but does not decide transitions. Backend adapters execute
turns but never seal lifecycle. User and authorized coordinators do.

---

## 14. Webview mapping

### 14.1 Screens

| Screen | Content |
|--------|---------|
| Task list | Root tasks; **lifecycle** badge only; optional CLI live dot; updated time; **New task** |
| Task workspace | **Task status card as header** (name + lifecycle + status menu; expand for detail); thread; composer **CLI strip**; orchestration / recovery panels; outcome card when shipped |

Clicking **New task** opens an unpersisted composer. The first submitted message
creates the root coordinator task (`lifecycle: open`) with that message as its
goal and queues its first turn. This avoids creating empty root tasks.

### 14.2 Protocol identity

All turn-scoped messages carry both `taskId` and `turnId`:

```text
turnStart      { taskId, turnId }
event          { taskId, turnId, event }
turnDone       { taskId, turnId }          // turn settled — not task lifecycle
turnError      { taskId, turnId, error }
askPending     { taskId, turnId, askId, questions }
taskUpdated    { taskId, revision, patch } // patch includes lifecycle, proposal, runtime
```

Preferred summary fields (additive):

```text
lifecycle          TaskLifecycleState
runtimeActivity    TaskRuntimeActivity      // orchestration + live turn signals
cliViewStatus?     CliViewStatus            // not_started | running | idle | stopped
cliLastExit?       CliLastExit              // when stopped
outcomeProposal?   OutcomeProposal
```

Until the host projects `cliViewStatus`, the webview **derives** it from
`runtimeActivity`, live turn flags, transcript/`hadProcess`, and
`committedSessionId` (§4.3.2).

The webview ignores late events whose `turnId` is no longer active for that task.
`submitAsk` must include `taskId`, `turnId`, and `askId`.

Host commands for user seals and mode:

```text
# Implemented
setTaskLifecycle           { taskId, lifecycle, result?, error? }
  // lifecycle: open | succeeded | failed | cancelled | skipped
  // open      → reopen from soft failed or hard terminal (same task id)
  // cancelled → engine cancelTask (cascade descendants)
  // skipped   → engine skipTask (cascade unfinished descendants)
  // terminal seals interrupt local live turns; remote-owned → interrupt request
  // send on any terminal lifecycle also reopens then queues a turn

# Planned (outcome card / settings)
acceptOutcome              { taskId }
rejectOutcome              { taskId, reason?: string }  // empty reason on complete → failed
setOutcomeAuthorityMode    { mode }                     // user_confirm | coordinator_delegate | yolo
```

Engine also exposes `cancelTask` / `skipTask` directly for host/coordinator paths;
the webview status menu uses `setTaskLifecycle` only.

### 14.3 Outcome UX and terminal chrome

- **Header:** task status card (name + lifecycle badge + status menu). Expand
  details for lifecycle/orchestration/session copy; collapsed by default so the
  badge is not duplicated in a second header row.
- While `lifecycle === 'open'` and `outcomeProposal` is set (`awaiting_outcome`):
  prefer Accept / Reject when a dedicated card ships. **Until then**, the status
  menu can seal lifecycle; **composer remains writable** and send clears the
  proposal and continues (§9). Do **not** show the task as Succeeded merely
  because `turnDone` arrived.
- Surface **outcome authority mode** (supervised / delegate / yolo) so users know
  whether the coordinator may mark success without confirmation.
- When a coordinator seals under delegate/yolo, show a non-blocking notice
  (who sealed, when) rather than an Accept card — unless `alwaysConfirmRoot`.
- **Failed** (soft): composer remains available; send reopens to `open`. Status
  menu may also **Reopen** → `setTaskLifecycle` `open`.
- **Succeeded** / **Cancelled** / **Skipped**: composer remains available; next
  `send` reopens the same task id to `open` and may queue a turn. Operators may
  still start a new task instead.
- **Cancel task** = abort in-progress work (cascade). **Skip task** = won’t
  perform this created task (cascade unfinished descendants). Both are distinct
  from **stop/interrupt turn**.

### 14.4 Anti-patterns (webview)

- Using a single status chip that shows `running` / `succeeded` interchangeably
  from turn events without a separate lifecycle field.
- Setting list status to “failed” when a CLI turn errors.
- Treating `turnDone` as task completion.
- Duplicating task name + lifecycle in both App chrome and the workspace status
  card (status card **is** the header).
- Blocking composer solely because `runtimeActivity === 'awaiting_outcome'`.
- Blocking composer solely because lifecycle is hard-terminal (reopen-on-send is allowed).
- Auto-sealing root success in **`user_confirm`** mode on agent `complete_task`.
- Blocking all coordinator seals in **`coordinator_delegate` / `yolo`** as if
  every outcome still required a human click (defeats handoff).
- Using **Skip** and **Cancel** as synonyms in the UI copy.

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
| Two axes | Persist **lifecycle** (work outcome) separately from **turn/runtime activity** (CLI and waits) |
| New task | Always `lifecycle: open` |
| Who seals lifecycle | **User always**; **coordinator** when outcome authority mode allows — never the CLI |
| Status axes | Lifecycle ≠ CLI process ≠ orchestration; three axes (§4.3) |
| CLI view (MVP) | `not_started` \| `running` \| `idle` \| `stopped`; error is `lastExit`, not a phase |
| CLI idle | Process on but not generating (incl. ask_user); common under long-lived process or mid-ask |
| CLI placement | Task badge = lifecycle; CLI strip near composer (§4.3.4, WEBVIEW) |
| Default mode | `user_confirm` — coordinator proposes, user Accept → `succeeded` |
| Delegate mode | `coordinator_delegate` — user enables coordinator to mark success/fail/skip in scope (incl. root) |
| Yolo (future) | `yolo` — same seal path as delegate + freer execution policy for self-orchestration handoff |
| Reject complete with reason | Stay `open`; inject reason; coordinator continues |
| Reject complete without reason | Soft `failed`; no auto turns until user messages |
| Soft fail reopen | New user message on `failed` reopens same task to `open` |
| Hard terminal follow-up | `succeeded` / `cancelled` / `skipped` → reopen same id on next `send` (or new task if user prefers) |
| Cancel | Authorized cancel seals `cancelled` and **cascades** descendants; workspace revert is future work |
| Skip | Created task marked **won’t perform** → `skipped` (hard); user or authorized coordinator |
| CLI / turn failure | Never seals lifecycle by itself; leave `open` + recovery (unless authorized sealer acts) |
| Disposition commit | Propose vs seal decided by mode + role on `turnCompleted` (§5.3, §6.1) |
| Audit | Persist `sealedBy` (user vs coordinator + mode) |
| Child waiting | Explicit turn-scoped wait set; no implicit per-turn spawn batch |
| Child failure | Settles the barrier but does not automatically fail the parent root |
| Dependencies | Declare required outcome and failure policy |
| Concurrency | Serialize per task/session, then apply backend and global limits |
| Interruption | Aborted/reloaded process → interrupted **turn**; lifecycle stays `open` |
| Reload | Reconcile persisted state; never silently replay a process |
| Persistence | Versioned task/turn/message store with one authoritative copy of each fact |
| Delegation safety | Scoped authorization plus finite depth, count, turn, timeout, and concurrency limits |
| Webview status | Show lifecycle badge + runtime activity; do not conflate with CLI status |

---

## 17. References

- `docs/DESIGN.md` — per-turn process architecture
- `docs/SESSION-MANAGEMENT.md` — CLI session identity and backend resume behavior
- `docs/ADAPTER-SPEC.md` — exactly-one terminal event contract
- `docs/MUSTER-BRIDGE.md` — MCP transport, AskBridge, and bridge security
- `docs/WEBVIEW.md` — rendering and message protocol
