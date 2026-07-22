# Task Management — domain model and coordinator protocol

Authoritative design for task orchestration in Muster. This document defines the
domain concepts and invariants that implementation types must preserve.

**Related documents:**

- [`DESIGN.md`](DESIGN.md) — extension architecture and per-turn process model
- [`SESSION-MANAGEMENT.md`](SESSION-MANAGEMENT.md) — backend-specific session identity and resume rules
- [`ADAPTER-SPEC.md`](ADAPTER-SPEC.md) — `NormalizedEvent`, `RunOptions`, and adapter turn lifecycle
- [`MUSTER-BRIDGE.md`](MUSTER-BRIDGE.md) — MCP transport; human ask via ACP elicitation / `ask_parent` (MCP `ask_user` removed)
- [`WEBVIEW.md`](WEBVIEW.md) — chat rendering and `postMessage` protocol

**Status:** Design contract for the task-management implementation. If another
document describes the legacy single-chat flow differently, this document is
authoritative for the task-based flow.

**Outcome model (normative):** task **lifecycle** (open / succeeded / failed /
cancelled / skipped) is a **work outcome**, not agent process status. A new
task is always `open`. Lifecycle is sealed only by an **authorized actor** — the
**user** and/or a **coordinator task** when the user has enabled outcome
delegation (including a future **yolo** / full handoff mode). Turn success,
process exit, and adapter errors never by themselves set lifecycle to
`succeeded` / `failed` / `skipped`. Product projections keep **lifecycle + turn
activity** (plus secondary orchestration panels); process/session stay
engine-internal (see §4.3, §4.1.1, and §5; plan `task-chat-turn-hide-cli`).

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
| **Lifecycle** | Persisted work outcome (`open` / `succeeded` / `failed` / `cancelled` / `skipped`) | Independent of agent process |
| **Turn activity** | Product chrome for current turn (`executing` / `waiting_you` / `queued` / `failed_turn` / ready) | Ephemeral / derived; not task outcome |
| **Process status** | Engine-internal: whether an agent process exists and is busy/idle/stopped | Ephemeral; **not** product chrome after Phase A |
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
  runTimeoutOverrideMs?: number; // optional shorter run; host setting is ceiling
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
  model?: string;
  committedSessionId?: string;
  /** Binding generation; missing legacy value migrates to 1. Increment on switch. */
  runtimeEpoch: number;

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
  /**
   * Most recent cross-runtime switch plus its one-shot continuation context.
   * The switch is already committed when this record exists; it never owns a
   * hidden source or receiver model turn and is never projected as chat.
   */
  handoff?: TaskHandoffState;
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
| Worker | None; self-disposition and `ask_parent` do not extend the graph |

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
  /** Task runtimeEpoch pinned when this turn is promoted. */
  runtimeEpoch: number;
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

Product UI exposes **task lifecycle + turn activity** (plus secondary
orchestration panels). **Process and session identity are engine-internal** —
not product chrome after Phase A of `docs/plans/task-chat-turn-hide-cli.md`.

| Axis | Question | Where in UI (normative) |
|------|----------|-------------------------|
| **Task lifecycle** | Is the work open / done / failed / cancelled / skipped? | Task list badge + workspace header |
| **Turn activity** | Is a turn working / waiting for you / queued / could not finish / ready? | Composer strip (`data-turn-activity`); optional turn-active list dot |
| **Orchestration activity** | Waiting on deps, children, recovery, outcome proposal? | Secondary line / action panels — not the task badge |
| **Process / session** (internal) | Agent process and `committedSessionId` | Engine-owned; **not** product chrome; not on webview wire (Phase B+) |

The store persists **lifecycle**, turns, dependencies, waits, and optional
`outcomeProposal`. Turn activity is **host-projected** as `currentTurnActivity`
(Phase B); orchestration may still appear via `runtimeActivity`.

#### 4.3.1 Task lifecycle (persisted work outcome)

```ts
type TaskLifecycleState =
  | 'open' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
```

Primary task badge only. Never set from agent/process exit alone. See §5.

#### 4.3.2 Turn activity (product) and process (engine-internal)

**Product strip** answers: **what is the current turn doing?** Labels:
Working / Waiting for you / Queued / Could not finish / (no strip when ready).

```ts
// Product-facing (Phase A client-derived; Phase B host-owned currentTurnActivity)
type TurnActivityState =
  | 'executing'    // live turn generating
  | 'waiting_you'  // elicitation / waiting_user
  | 'queued'       // turn queued, not yet live
  | 'failed_turn'  // needs_recovery / last turn failed
  | 'null';         // ready / between turns — no strip
```

**Engine-internal** process phase (not webview chrome) remains useful for
adapters: spawn, shared agent, exit codes, `committedSessionId`. Do **not**
project process phase labels (“CLI running/stopped/idle”) or session ids into
product UI.

##### Turn vs task error

| Situation | Turn activity (product) | Task lifecycle |
|-----------|-------------------------|----------------|
| Turn adapter error / crash | `failed_turn` (or recovery panel pre-Phase B) | stays `open` |
| User rejects completion without reason | none / ready | soft `failed` |
| User accepts complete | none / ready | `succeeded` |
| Tool error mid-stream | stays `executing` | unchanged |
| User Stop this turn | none / ready (transcript cancel) | stays `open` |

#### 4.3.3 Orchestration activity (open tasks)

Scheduling and graph waits — **not** turn activity labels and **not** lifecycle:

```ts
type TaskRuntimeActivity =
  | 'idle'
  | 'queued'
  | 'running'              // live turn generating → product turn activity = executing
  | 'waiting_user'         // live elicitation / ask_parent → product turn activity = waiting_you
  | 'waiting_dependencies'
  | 'waiting_children'
  | 'blocked'
  | 'needs_recovery'       // → product turn activity = failed_turn (Phase A)
  | 'awaiting_outcome';
```

Evaluation order (only when `lifecycle === 'open'`):

1. Non-null `outcomeProposal` → `awaiting_outcome` (no live turn strip).
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
| Task list badge | **Lifecycle only** (optional tiny **turn-active** dot, not a second status word; not “CLI running”) |
| Workspace header | **Task status card** = header (name + lifecycle badge + status menu). No separate title row that repeats the same badge. **Expand details** (collapsed by default) shows lifecycle copy, optional orchestration one-liner, continuation hint — **not** session id in product chrome. |
| Composer strip | **Turn activity** (`executing` / `waiting_you` / `queued` / `failed_turn`); **no strip** when ready. Do not show CLI process phases. Host-owned `currentTurnActivity` lands in Phase B (`docs/plans/task-chat-turn-hide-cli.md`). |
| Action panels | Recovery, resume queue; outcome accept/reject when product ships dedicated card (today: lifecycle status menu). Recovery copy talks about **turns**, not CLI process. |

Composer / send rules use lifecycle **and** turn/orchestration (see §9).

Do not map adapter exit codes onto lifecycle. Do not use a single chip that
says both “Failed” (task) and “Working” (turn) interchangeably from `turnDone`.

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

**Parent seal MCP (`set_task_lifecycle`):** when a **direct child** stays open
without staging disposition (e.g. agent omitted `complete_task`), a coordinator
with the `cancel_child` capability may seal that child via
`set_task_lifecycle`:

| Lifecycle | Scope | Notes |
|-----------|--------|--------|
| `succeeded` / `failed` | **Target child only** | Requires `result` / `error`; `sealedBy: { kind:'coordinator', mode:'parent_seal' }` |
| `cancelled` / `skipped` | **Subtree cascade** | Same class as host cancel/skip (unfinished descendants) |
| Compatible terminal replay | No-op | Exact payload equality; does **not** rewrite `sealedBy` / revision |
| Incompatible terminal | Error `already_terminal` | No overwrite |

Root policy: `mayParentSealDirect` / `childOrchestrationSeal`. Under
`propose_only`, parent seal is rejected. Under default
`parent_may_seal_direct`, it is allowed. Sealing the **root** via MCP is not
supported in v1 (user/host only).

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
running ──elicitation / ask_parent registered──────► waiting_user
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
progress tools and self-disposition tools, but not graph-extension tools.
Human-in-the-loop: root tasks use **ACP RFD elicitation**; non-root children use
**`ask_parent`** (MCP `ask_user` is removed).

### 8.1 Tool surface

| Tool | Caller | Purpose |
|------|--------|---------|
| `create_task` | Coordinator | Create a **draft** direct child (no first turn). **Required:** `goal`, **`taskType`**. Optional: `backend`/`model` **only as user overrides**, `role`, `dependencies`, `executionPolicy`, **`description`**, **`brief`**, **`inputBindings`**, **`claimsGit`**, **`writePaths`/`readPaths`**. Resolves `taskType` from workspace `muster.taskTypes` before persist |
| `delegate_task` | Coordinator | Atomically create a **released** child + queue first-turn intent (same args as `create_task`). Optional **`waitForCompletion: true`** stages wait on that child in the same op (requires `wait_child`) |
| `list_task_types` | Coordinator (`create_child`) | Live registry summary (id, backend, model?, role, briefKind) + diagnostics. **No `opId`**, no ledger. Prefer types already in first-turn host context; call to refresh only |
| `release_tasks` | Coordinator | Atomic draft→released for `taskIds[]` (+ optional dep closure); queues first-turn intents. Optional **`waitForTaskIds`** exact wait subset (requires `wait_child`). Uses **persisted** backend/model — never re-resolves registry |
| `delegate_tasks` | Coordinator | Batch create+release (up to 16). Optional **`waitForLocalIds`** exact wait subset. Intra-batch `dependsOn` / bindings → `succeeded`/`fail` deps |
| `interrupt_task` | Coordinator | Interrupt an active direct child turn (`interrupt_child` cap) |
| `cancel_task` | Coordinator | Cancel direct child + cascade unfinished descendants (`cancel_child` cap); `sealedBy.coordinator` |
| `set_task_lifecycle` | Coordinator | **Parent-seal** a direct child's lifecycle (`succeeded`/`failed`/`cancelled`/`skipped`) when the child omitted disposition (`cancel_child` cap). See §5.3 |
| `wait_for_tasks` | Coordinator | Stage the caller turn's explicit child wait set (`wakeOn` default: terminal + attention) |
| `get_task_status` | Coordinator | Subtree summary: lifecycle, `releaseState`, **readiness**, attention, result.summary |
| `get_host_context` | **Any task** | Read-only role-filtered host env / self / rules / **taskTypes** JSON (same builder as first-turn host block). **No `opId`**, no op ledger |
| `complete_task` | Any task | Stage successful completion; **seal or propose** per outcome mode + role (§4.1.1) |
| `fail_task` | Any task | Stage failure; seal or propose per mode + role |
| `report_progress` | Any task | Update optional progress metadata |
| `ask_parent` | Non-root task | Block child turn; route structured questions to parent (`answer_child_question`) |
| `answer_child_question` | Parent coordinator | Answer a pending child `ask_parent` and queue child continuation |
| `define_workflow` | Coordinator (`create_child`) | Persist an immutable one-node workflow definition version (`definitionId`+`version`). Same fingerprint replays; conflict fails closed. Topology is frozen `one_node_v1` in S01 |
| `start_workflow` | Coordinator (`create_child`) | Idempotent compound start (`startIdempotencyKey`) for a frozen definition; creates exactly one ordinary queued entry turn when the entry gate is satisfied. Agents never supply run/task/turn/gate IDs |

**Task types (v1):** Config SoT is resource-scoped VS Code setting `muster.taskTypes` (id → `{ backend, model?, role?, briefKind?, description? }`). Empty registry → create/delegate fail with `task_types_not_configured` (zero mutations). Malformed → `invalid_task_type_config`. Unknown type → `unknown_task_type` even if `backend` override is present. Typo backend id → `backend_unsupported`. Shipped defaults provide `coordinate`, `plan`, `breakdown`, `explore`, `implement`, `verify`, and `research`; explicit workspace maps remain authoritative and are not silently merged with defaults.

**Happy paths (prefer compound wait fields):**  
- Simple: `delegate_task({ waitForCompletion: true })`  
- Parallel: `delegate_tasks({ waitForLocalIds: [...] })`  
- Planned graph: `create_tasks` → `release_tasks({ waitForTaskIds: [...] })`  

Standalone `wait_for_tasks` is **advanced** (re-arm barrier / earlier fire-and-forget).  
Omitted wait fields = fire-and-forget. Compound wait requires `wait_child` in addition to `create_child`.  
Coordinator does **not** start CLI processes via `start_task`.

**Capability grants:** root coordinators and coordinator-role children include
`cancel_child` (+ `interrupt_child`) so `cancel_task` / `set_task_lifecycle` are
listed. `list_task_types` is under `create_child`. Store load backfills missing
`cancel_child` on existing coordinators. Workers never receive graph mutators.

**First-turn host context:** every task's **sequence-1** turn freezes a compiled
prompt: `# Muster host context` (role-tiered; coordinators with types get
`## Task types` + protected type rules; raw backends/models demoted when types
present) → brief → untrusted pins. Turn 2+ does not re-prefix host; agents may
call `get_host_context` / `list_task_types` to refresh.

**Dataflow:** `inputBindings` + `TaskResultV1` (`summary` only v1); durable pin on turn before dispatch.  
**Ordering** still uses `dependencies` separately.

Tool names describe requested host actions. The MCP response confirms the host
**accepted the staging** (and, when mode allows, that a seal will apply on
`turnCompleted`). Under `user_confirm`, staging is not a root lifecycle seal.

Each turn has one disposition kind. Wait dispositions are monotonic: compound and
standalone wait calls stable-union their owned child IDs, and redundant waits
succeed. A wait never replaces complete/fail/idle, which remain conflicting.
Successful wait responses return `nextAction: end_current_turn` and
`doNotPoll: true`; the coordinator must finish the turn so the host can park the
task in `waiting_children`. The engine derives mutation idempotency from
`(turnId, toolCallId)` or an equivalent stable operation ID.

User decisions and mode control are **host/webview commands** (not MCP). Implemented
today: `setTaskLifecycle` (user status menu; cancel/skip cascade via engine). Planned
dedicated cards: `acceptOutcome`, `rejectOutcome { reason?: string }`,
`setOutcomeAuthorityMode { mode }`.

### 8.2 Explicit child waiting

Coordinators never block a live CLI process while children run:

```text
1. Coordinator turn delegates (optionally with waitForCompletion / waitForLocalIds)
   or releases (optionally with waitForTaskIds).
2. Prefer compound wait fields so create/release + wait stage in one MCP call.
   Advanced: call wait_for_tasks({ taskIds }) separately.
3. The staged TurnDisposition.wait_tasks returns immediately with an explicit
   end-turn/do-not-poll instruction (no process block).
4. Coordinator finishes its CLI turn.
5. On turnCompleted, the engine commits the wait set and releases the process.
6. Child tasks progress independently.
7. When every waited task is terminal (or attention wake), the engine queues one
   continuation turn.
8. That turn receives structured `child_results` followed by pending user messages
   in a deterministic order.
```

Only IDs explicitly passed via compound wait fields or `wait_for_tasks` belong to
the barrier. Batch `dependsOn` edges use `onUnsatisfied: fail` so sink-only waits
do not hang forever on upstream failure. A child may be fire-and-forget. A child
that settles before the parent turn finishes is still handled correctly: after
committing the wait set, the engine immediately observes that the barrier is
complete and queues the continuation.

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
both constrain behavior.

### 9.0 File-mention autocomplete and host filesystem authority

Composer `@` autocomplete is a focused-task UX surface with **host-owned path
authority**:

- The webview posts only `requestFileMentionSuggestions` with `requestId`,
  optional focused `taskId`, bounded `parentDepth` (`0` current / `1` parent /
  `2` grandparent), and a relative query string. It never supplies cwd or
  absolute paths.
- The host resolves cwd from task or draft context, ascends at most two parent
  levels, optionally refines into a relative directory under that scope, lists
  one directory non-recursively, and returns relative suggestion items only.
- Accepted file mentions insert relative tokens into the draft; on send the
  transcript keeps short display text while optional `llmText` expands bound
  chips for the agent (`TaskMessage.agentContent`).
- Task focus changes re-scope subsequent requests; stale or cross-task responses
  must not paint. Full trigger grammar, keyboard controls, limits, exclusions,
  and proof boundary live in `WEBVIEW.md` §12.1.

`send(taskId, message)` targets the focused task. Lifecycle and runtime activity
both constrain behavior:

| Lifecycle | Runtime activity (if open) | Behavior |
|-----------|----------------------------|----------|
| `open` | `idle` | Queue a user-triggered turn (`send`) |
| `open` | `waiting_dependencies` / `queued` | `send` creates another distinct FIFO queued turn (or binds per engine policy); inspect / edit / delete via `queuedTurns` |
| `open` | `running` | `send` queues a FIFO follow-up (no interrupt); **Ctrl+Enter** `sendLiveInput` → reserve follow-up then interrupt live turn (cut & continue). `submitAsk` remains the path for structured ask answers |
| `open` | `waiting_user` | Answer the pending ask via `submitAsk`; free-form composer may still queue follow-ups when product policy allows |
| `open` | `waiting_children` / `blocked` | Persist / queue for the next continuation turn |
| `open` | `needs_recovery` | Persist; free-form send accepted as continuation; soft “Could not finish” card + optional Retry / Continue |
| `open` | `awaiting_outcome` | Prefer Accept/Reject when an outcome card exists. **Composer stays writable:** a new `send` clears `outcomeProposal`, keeps lifecycle `open`, and queues a turn (continue session). Do **not** block send solely because a proposal is pending. |
| `failed` (soft) | — | **Reopen** to `open`, then queue a turn with the message |
| `succeeded` / `cancelled` / `skipped` | — | **Reopen** to `open` on the same task id, then queue a turn (same as soft-fail). Operators may still create a new task instead |

### 9.1 Multi-queued FIFO follow-ups and interrupt & send

**Normative send rule (R012):** every focused-task `send` creates a **distinct queued turn** bound to that user message, or **refuses visibly** when a turn cannot be allocated (turn cap, hard recovery block). Concurrent sends while a turn is live or already queued still create additional queued turns; the scheduler promotes **one active (running) turn per task**, only the **earliest** queued sequence (FIFO), and drains **multiple queued follow-ups** in order after **successful** settlement. After **failed** or **forced/unconfirmed interrupted** settlement, queued follow-ups remain queued (not auto-promoted) until recovery/resume policy allows. After a **confirmed** interrupt settlement with queued follow-ups (interrupt & send / Enter-then-Stop), FIFO auto-promotes.

| Operator action | Engine / host API | Notes |
|-----------------|-------------------|-------|
| Enter / Send | `send` | FIFO follow-up turn; composer stays editable while running/queued |
| Ctrl+Enter while running | `sendLiveInput` → `interruptAndSend` | Reserve FIFO follow-up, then interrupt live turn; no concurrent inject; no delivered banner |
| Ctrl+Enter while idle | `send` | Immediate normal turn (same as Enter) |
| Edit pending queue item | `editQueuedTurn` | Only while `turnId` remains in the live `queuedTurns` projection; clears stale `agentContent` |
| Delete pending queue item | `deleteQueuedTurn` | Undispatched only; never cancels a running turn |

**Projection:** snapshots include optional `queuedTurns` (`turnId`, `sequence`, `status: 'queued'`, `messageIds`, `createdAt`, optional `previewText`) so the webview can render an inspectable FIFO panel and lock edit/delete at the dispatch boundary. User messages bound to still-`queued` turns are **omitted from the chat transcript** until the turn promotes to running; they are visible only in the queue panel (and via `previewText`).

**Interrupt & send outcomes:**

- Success → reserve follow-up + interrupt; after **confirmed** settle, FIFO-promote (no `liveInputResult` banner).
- Reserve failure (terminal task, turn cap, …) → **commandError**; live turn keeps running (no interrupt).
- Confirmed interrupt with queued follow-ups → clear `holdAutoPromote` and FIFO-promote; pure Stop with empty queue promotes nothing.
- Stale `editQueuedTurn` / `deleteQueuedTurn` (missing, foreign, or already dispatched turn) → `commandError` with a clear stale-mutation message; controls should already be locked when the projection drops the turn.

`sendLiveInput` means **interrupt & send**: host calls `TaskEngine.interruptAndSend` (reserve follow-up, then interrupt). It does **not** call concurrent `backend.sendLiveInput`. After a **confirmed** interrupt settlement, same-task queued follow-ups promote FIFO and observed session may bind to `committedSessionId` when unset. Forced/unconfirmed cancel keeps holds and does not auto-promote. Webview keyboard policy maps Ctrl/Meta+Enter to `sendLiveInput` when a live turn is running; otherwise Ctrl/Meta+Enter uses `send`.

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

Opening a child lets the user inspect its stream, answer that child's `ask_parent`
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

### 12.1 Task repository

The authoritative shipping store is the SQLite-backed `TaskRepository` under
`globalStorageUri` (see `SQLITE-STORAGE.md`). JSON task files are not used
history, not an allowed sidecar for new orchestration state. The repository schema
and every projected snapshot retain explicit schema/store revisions.

Requirements:

- SQLite transactions protect multi-record state changes from partial commits;
- repository commands, revisions, and compare-and-swap/lease checks prevent lost
  updates across VS Code windows;
- migrations are explicit and versioned;
- corrupt databases are quarantined/preserved for recovery instead of overwritten;
- repository data is treated as potentially sensitive local data;
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

`SqliteTaskRepository` persists state but does not decide transitions. Backend adapters execute
turns but never seal lifecycle. User and authorized coordinators do.

---

## 14. Webview mapping

### 14.1 Screens

| Screen | Content |
|--------|---------|
| Task list | Root tasks; **lifecycle** badge only; optional **turn-active** dot; updated time; **New task** |
| Task workspace | **Task status card as header** (name + lifecycle + status menu; expand for detail); thread; composer **turn-activity strip**; orchestration / recovery panels; outcome card when shipped |

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
currentTurnActivity  // host-owned product chrome (TurnActivity | null)
// Do not project cliViewStatus / process phases / committedSessionId as product chrome
outcomeProposal?   OutcomeProposal
```

Host projects **turn activity** as `currentTurnActivity`. Webview prefers that
field and falls back to client derive only if absent.

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

- [x] SQLite `SqliteTaskRepository` with transactional writes (see `SQLITE-STORAGE.md`)
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
- [ ] Durable messages/pending-input delivery and child `ask_parent` interaction
- [ ] Continuation task UX

### Phase E — Migration and cleanup

- [x] SQLite-only storage (no JSON task/session migration path)
- [ ] Make task flow the default
- [ ] Remove legacy flat session path
- [ ] Add retention, archival, and recovery UI

### Phase F — Task orchestration auto-run (implemented)

Plan: [`plans/task-orchestration-auto-run.md`](plans/task-orchestration-auto-run.md).

- [x] W1 — `TaskResultV1`, `inputBindings`, durable pin before dispatch
- [x] W2 — `TaskBriefV1`, prompt compiler, schema v5 migrate (`releaseState` + brief)
- [x] W3 — Draft create, atomic `release_tasks`, first-turn intents, `start_task` lockdown
- [x] W4 — `sealedBy` on all terminal paths; root `childOrchestrationSeal` policy
- [x] W5 — Shared readiness evaluator + `rescanSchedulableTurns`
- [x] W6 — Attention wake on `wait_for_tasks` (`wakeOn`, suspend phase)
- [x] W7 — Shared-cwd writePaths / git mutex at promote
- [x] W8 — Credential, ACP prompt and lease expiry derive from the frozen run deadline (up to the supported 8h ceiling plus cleanup buffers)
- [x] W9 — Workspace trust gate + safe reload auto-resume for released never-dispatched turns

---

## 16. Resolved design decisions

| Topic | Decision |
|-------|----------|
| Domain terminology | Use Task, Backend, Session, Turn, Process, and Engine; retire Executor |
| Main agent | Root coordinator is a normal task with host-issued coordinator policy |
| Two axes | Persist **lifecycle** (work outcome) separately from **turn/runtime activity** (CLI and waits) |
| New task | Always `lifecycle: open` |
| Who seals lifecycle | **User always**; **coordinator** when outcome authority mode allows — never the CLI |
| Status axes | Lifecycle ≠ turn activity ≠ orchestration (§4.3); process/session stay engine-internal |
| Turn activity (product) | `executing` \| `waiting_you` \| `queued` \| `failed_turn` \| none (ready); Phase A client-derived, Phase B host-owned |
| Process status | Engine-internal only — not product chrome after Phase A |
| Placement | Task badge = lifecycle; turn strip near composer (§4.3.4, WEBVIEW) |
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

---

## 18. Task Markdown export

Operators may export one task's **committed visible conversation** as a versioned Markdown document. Export is a **point-in-time** projection for reading/sharing; it is **not a backup** or restore format and does not round-trip into the task store.

### Document contract (`muster-task-export/v1`)

- Marker: `<!-- muster-task-export/v1 -->` at the top of every document.
- Title and disclaimer that this is a point-in-time export, not a backup/restore format.
- **Task** metadata: task id, goal, lifecycle status, backend, optional model, source revision (store revision used for the projection), and export timestamp (`exportedAt`, ISO-8601).
- **Conversation** section built from the canonical transcript, allowlisting only **user/assistant** display content. Tool, reasoning, system, and queued-draft items are **omitted** even when present in the store projection.
- Retention truncation markers in allowlisted content are preserved verbatim.
- Atomic render bound: exceeding the Markdown character budget fails closed with `render_bound` and returns **no** partial document.

### Filename and host I/O

- Suggested Save As basename is an ASCII slug of the task goal with a `.md` suffix; unsafe/empty/Unicode-only goals fall back to deterministic `task-export.md`.
- Host opens native **Save As**, writes UTF-8 on approval, and never mutates the task store for export.
- Webview posts `exportTask` `{ taskId }` for the focused task; host replies with `exportResult` carrying **basename-only** `fileName` plus `taskId`, `sourceRevision`, and `exportedAt`. Absolute destinations never leave the host route.
- User cancel is a **silent cancel** outcome (no `exportResult`, no `commandError`).
- Failures map to stable generic messages (`invalid_request`, `task_not_found`, `render_bound`, `write_failed`, `dialog_failed`) via task-scoped **sanitized** `commandError` text — no absolute paths, raw stacks, credentials, or other-task content.

Webview trigger, notice chrome, and proof-class separation are specified in [WEBVIEW.md](WEBVIEW.md) §16 and [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 19. Cross-runtime model switch and continuation (destination contract)

A model/backend switch is a fast, local binding change. It does not call the source
agent, create a receiver session, or wait for model output. The next real turn on the
target runtime starts a fresh session through the same bootstrap path as a newly
created task, with one additional compact continuation block.

This section is the normative destination design. The legacy source-summary turn,
receiver-bootstrap turn, `preparing_receiver`/`transferring` phase machine, and
`completeRuntimeHandoff` second step are obsolete and must be removed during
implementation.

### Prompt layers and ownership

Every fresh agent session receives the same first-session contract, whether it is
the first session for a new task or the first target session after a model switch:

1. **Runtime contract (always):** identity, role, task id, operating rules,
   permission policy, coordination strategy, and the tools actually available.
2. **Task contract (always):** goal, brief, cwd/workspace context, resolved inputs,
   skills, and host context.
3. **Continuation context (handoff only):** compact history and current work state
   captured before the switch.
4. **Current input (always):** the user message or queued engine instruction that
   starts this turn.

Layers 1–2 must be produced by the same shared first-session prompt builder. A
handoff must not maintain a separate bootstrap prompt that can drift from new-task
behavior. Layer 3 is an optional argument to that builder, not another model call.

Tool availability has two mandatory halves:

- The target session is created through the normal turn runner so its `RunOptions`
  contains the same MCP servers/config and credentials as any other task turn.
- The runtime contract advertises only those attached capabilities and explains
  their operating semantics. Prompt text alone cannot provide a tool, and wiring a
  tool without the common runtime contract loses strategy and policy.

### Atomic switch invariants

- **No hidden model work:** switching never prompts the source or target agent.
- **No source summary:** conversation and durable task state are canonical; no LLM
  summary is generated, cached, persisted, or required.
- **Immediate commit:** one store transaction validates the request, records the
  context cutoff, increments `task.runtimeEpoch`, changes
  `task.backend`/`task.model`, clears `committedSessionId`, and records the completed
  switch.
- **No receiver rollback:** authentication, session creation, prompt, tool, or model
  failures on the next turn are ordinary turn failures. They never restore the old
  backend/model.
- **Fresh target session:** the source session id is never copied into handoff state
  or passed to the target. The first target turn creates and then commits its own
  session id.
- **Stale-source isolation:** a live source turn is interrupted before the binding
  commit. Any late event or settlement from the old runtime generation may settle
  its own turn but must not overwrite the new task binding/session.
- **Repeated switches:** an unconsumed prior continuation is not an active-handoff
  gate. A newer valid switch interrupts/fences any assigned target turn, recomputes
  the cutoff from canonical records, and atomically supersedes the prior switch.
- **Not chat:** continuation metadata and rendered compact context do not create
  synthetic `TaskMessage` rows and do not appear as extra user/assistant messages in
  transcript, snapshot, or Markdown export.

### Persisted shape (`TaskHandoffState` v2)

The handoff record represents an already-completed binding switch plus a one-shot
continuation payload. It is not an asynchronous phase machine.

```ts
interface TaskHandoffRuntimeLabel {
  backend: string;
  model?: string;
  runtimeEpoch: number;
}

interface TaskHandoffContextCutoff {
  throughMessageId?: string; // absent when no committed conversation exists
  throughToolCallId?: string; // absent when no committed tool call exists
  throughTurnSequence: number; // 0 when the task has no source turn
  sourceStoreRevision: number;
  messageCount: number;
  toolCallCount: number;
  contextDigest: string;
  capturedAt: string;
}

type TaskHandoffContinuation =
  | { status: 'pending' }
  | { status: 'assigned'; turnId: string; assignedAt: string }
  | { status: 'consumed'; turnId: string; consumedAt: string };

interface TaskHandoffState {
  version: 2;
  operationId: string;
  source: TaskHandoffRuntimeLabel;
  target: TaskHandoffRuntimeLabel;
  contextCutoff: TaskHandoffContextCutoff;
  continuation: TaskHandoffContinuation;
  switchedAt: string;
}
```

The cutoff stores identity/count/digest metadata only. `throughTurnSequence` bounds
assistant segments and persisted tool calls; pending queued messages are excluded so
the first target message is not duplicated as history. Conversation bodies and
tool-event details remain in their canonical task/turn records and are rebuilt at
prompt compilation time. Handoff state never contains source or target session ids.

### Store and migration policy

| On-disk shape | Behavior |
|---------------|----------|
| No `handoff` field | Valid task with no pending continuation. |
| Well-formed v2 `handoff` | Reload exactly; pending/assigned continuation remains durable. |
| Legacy v1 terminal handoff | Preserve the task's already-committed binding, then discard/migrate the legacy progress metadata; never run hidden recovery turns. |
| Legacy v1 active handoff | Keep the binding currently stored on the task, discard the active legacy operation, and require an explicit new switch; never auto-summarize or auto-bootstrap. |
| Malformed handoff | Strip only the handoff field; keep the task and conversation. |
| Unparseable store file | Existing store-corrupt quarantine policy (unchanged). |

Reload must never manufacture a source-summary call or receiver turn. A pending v2
continuation waits for the next eligible real turn after reload.

### Engine switch (`TaskEngine.requestRuntimeHandoff`)

The engine owns one synchronous store operation. It validates static/local gates,
preempts source work, captures the cutoff, and commits the target binding without
calling `runTurn`.

**Command shape**

```ts
engine.requestRuntimeHandoff({
  taskId: string;
  targetBackend: string;
  targetModel?: string;
}): Promise<EngineResult<{
  operationId: string;
  boundBackend: string;
  boundModel?: string;
  switchedAt: string;
}>>
```

**Happy path**

1. Reject missing task, invalid/same target binding, malformed labels, or a target
   backend that cannot support the task's required MCP contract.
2. Interrupt a running/waiting source turn immediately. Keep queued turns FIFO; do
   not delete their user messages and do not wait for the source process to exit.
3. In the binding commit, increment `task.runtimeEpoch`; every promoted turn pins
   its epoch, and late source events may commit session binding only when the turn
   epoch still equals the task epoch.
4. Capture a deterministic cutoff over committed pre-switch messages/events.
5. Atomically write the incremented runtime epoch,
   `task.backend = targetBackend`, `task.model = targetModel`,
   `task.committedSessionId = undefined`, and `TaskHandoffState` v2 with
   `continuation.status = pending`.
6. Release scheduling. The oldest eligible queued turn consumes the continuation;
   otherwise it waits for the user's next message.
7. Return success immediately after the store commit. No backend authentication,
   session creation, source summary, receiver acknowledgement, or model timeout is
   part of this command.

**Fail-closed gates** (no binding mutation, no handoff write on rejection)

| Condition | Behavior |
|-----------|----------|
| Missing task | Reject; store unchanged |
| Running / `waiting_user` source turn | Interrupt and fence it; switch without waiting |
| Queued turns | Preserve FIFO; first eligible turn receives continuation after commit |
| Target backend factory throws | Reject (`target backend unavailable`) |
| Target lacks MCP | Reject (`backend does not support MCP`) |
| Static validation/store commit fails | Source binding remains unchanged; return task-scoped error |

Backend availability may change after the local check. A later target-session
startup failure belongs to that turn and does not retroactively fail the switch.

### Compact continuation context (`muster-continuation/v2`)

The continuation is a deterministic model-facing projection of canonical records,
not a stored JSON dump and not an LLM summary. It is rebuilt only up to
`contextCutoff` and rendered chronologically under a strict token/character
budget.

Priority order under truncation:

1. Common runtime/task bootstrap and current input (never displaced by history).
2. Task goal/brief and the latest unfinished user request.
3. Current durable state: last turn outcome, changed files, verification commands
   and results, pending questions, and child results relevant to this task.
4. Recent user/assistant text and state-changing/error tool events.
5. Older conversation from newest to oldest until the remaining budget is full.

Render rules:

| Canonical record | Compact model form |
|------------------|--------------------|
| User/assistant message | Role plus `agentContent` when present, otherwise display text |
| Edit/write tool | Operation, workspace-relative path, success/failure, bounded diff summary when available |
| Shell tool | Command, exit code, and bounded relevant stdout/stderr tail |
| Test/verification | Command, pass/fail, and failing cases/error excerpt |
| Read/search tool | Omit repetitive successes or render a short operation/result line; preserve failures and state-relevant findings |
| Permission/elicitation | Decision plus the answer needed to continue; omit transport ids |
| Turn terminal | Completed/failed/interrupted plus bounded actionable error |

Always omit message/tool/request ids, timestamps, token usage, protocol envelopes,
absolute host paths, credentials, and unrelated raw output. The renderer consumes
structured records internally but sends compact text rather than JSON, for example:

```text
## Continuation context

User requested the model-switch timeout bug be fixed.

Assistant:
I will update file A, then run the handoff tests.

edit A
result: success

bash npm run test
exit: 1
output:
  receiver init timed out

Current state:
- A has been changed.
- Tests still fail in receiver initialization.
- No commit has been created.
```

Workspace files remain the source of truth for edits. The compact context helps the
new agent orient itself; it does not replace inspecting current files when needed.
“Current state” lines must be derived from explicit persisted task/turn fields and
tool outcomes, never guessed by another model or inferred from missing events.

### First target turn and durable attachment

A handoff creates no turn by itself. The oldest eligible queued turn, or the next
message sent by the user, becomes the first target turn. A future explicit
“switch and continue” feature may enqueue an ordinary visible continuation turn,
but it must remain separate from switch success.

When the first target turn is promoted, one transaction:

1. Claims the `pending` continuation for that `turnId` (`assigned`).
2. Rebuilds compact history only through the stored cutoff, so the current message
   cannot appear both as history and current input.
3. Compiles and freezes the prompt as:

   ```text
   common runtime contract
   + common task contract
   + compact continuation context
   + current turn input
   ```

4. Creates normal MCP configuration/credentials through `buildRunOptionsForTurn`.
5. Starts a fresh target session without `resumeId` and records the new observed
   session id through the ordinary session-commit rules.

Assignment is durable and tied to the target runtime epoch. A successful first
target turn commits its session id and marks the continuation `consumed`. A proven
pre-dispatch failure returns it to `pending`; a clean terminal failure with no
committed target session may reattach the same frozen continuation on an explicit
retry/recovery turn. An ambiguous prompt remains `assigned` and must use normal turn
recovery—it must not be silently replayed or moved to an unrelated later message.

If the target turn fails to authenticate, create a session, invoke a tool, or finish
within its normal run deadline, surface a normal turn error. The selected
backend/model remains bound, and the user may retry or switch again.

### Host route (`routeRuntimeHandoff`)

The webview posts one typed `requestRuntimeHandoff` message (`taskId`,
`targetBackend`, optional `targetModel`). The route:

1. Validates the inbound payload (safe labels only — no session ids, paths, or control characters).
2. Refuses missing tasks and same-binding switches without calling engine APIs.
3. Calls the single atomic engine switch operation.
4. Refreshes the task snapshot and returns a bounded success acknowledgement.
5. Surfaces local validation/commit failures as task-scoped `commandError` with
   sanitized text (no stacks, absolute paths, or secrets).
6. Never calls `completeRuntimeHandoff` and never returns session ids, digests, or
   continuation bodies on the wire.

Final binding labels are observed through `TaskSummary.backend` / `model` on
snapshot/taskUpdated. The continuation lifecycle is internal task metadata, not a
chat turn and not a long-running host request.

### Webview projection

The switch has no multi-phase progress bar because there is no model work to wait
for. Task chrome may show a short one-shot success notice after the host confirms
the commit. Persisted task summaries project:

| Field | Included |
|-------|----------|
| `backend` / `model` | yes; authoritative selected binding |
| Last switch source/target labels and `switchedAt` | optional bounded diagnostics/notice only |
| Pending/assigned/consumed continuation status | omit from ordinary user chrome unless needed for diagnostics |

Never projected on `TaskSummary`, transcript, or Markdown export conversation bodies:

- source or target session ids
- context cutoff digests/counts/ids
- compiled continuation prompt bodies
- raw CLI output, credentials, or absolute paths

Refusals use task-scoped `commandError`; success uses the updated binding plus a
brief notice. Neither path invents a chat message.

### Webview model-switch control

On an **open** task the composer always shows an interactive CLI+model picker
(`data-testid="task-model-switch"`). Start uses the same picker to choose a binding;
later changes post `requestRuntimeHandoff` with labels only. A valid switch should
feel local and immediate: the picker may optimistically show the target, then the
host-confirmed snapshot becomes authoritative.

If a source turn is live, the engine interrupts and fences it without waiting. Queued
messages remain FIFO and the first eligible one runs on the new binding with compact
continuation context. If nothing is queued, no agent runs until the user sends the
next message. Same-binding picks are local no-ops; missing-task, invalid-target, and
commit failures restore the confirmed picker value and show `commandError`.

The UI must not show “Preparing receiver” or wait on a fixed source/receiver model
timeout. A later target-turn failure appears in normal turn activity/error chrome and
does not make the completed model switch look rolled back.

---

## 20. Gate-routed agent workflows (`NEXT` / `PREV` target design)

This section is the normative source of truth for the next workflow model. It defines
the target behavior; it does **not** claim that the current `TaskEngine`, dependency,
wait, or coordinator-tool implementation already provides the complete protocol.
Existing lifecycle, turn, session, persistence, authorization, and resource-limit
invariants in this document continue to apply unless this section explicitly narrows
the workflow meaning of a term.

### 20.1 Purpose and base model

A coordinator may define a **workflow** containing task nodes, dependency gates, and
routing edges. The same model applies to the root request: a top-level task entering
and eventually returning from a workflow is not a separate orchestration mechanism.

The engine, rather than an agent or CLI, owns graph topology and routing. A task works
only with its current input, provenance-bearing dependency inputs, and the outcomes
`NEXT` and `PREV`. It does not need to know whether another task is its parent, child,
peer, or a node inside a nested workflow.

The model has two separate graphs:

1. **Dependency graph:** determines when a task has enough inputs to execute.
2. **Routing graph:** determines where a completed `NEXT` result or `PREV` feedback
   is delivered.

Do not infer execution order from visual levels or waves. Independent nodes execute
as soon as their own gates are satisfied, subject to scheduler limits. A “wave” is a
projection for explanation or UI only, never a synchronization barrier.

### 20.2 Normative workflow invariants

Implementations of this protocol must preserve all of the following:

1. **One task owns one logical CLI conversation.** All workflow activations for that
   task resume its committed session; no other task shares that session ID.
2. **No waiting process.** A process or adapter run exists only while executing one
   turn. After the turn settles, compute resources are released. `waiting` describes
   durable orchestration state, not a sleeping CLI, process, thread, or connection.
3. **A partial gate never executes its consumer.** One dependency result is persisted
   into the gate, but cannot by itself create a downstream turn when other required
   results are absent.
4. **One satisfied gate creates one turn.** The engine closes a gate atomically,
   builds one aggregate input message, and queues exactly one turn for that gate.
5. **A task/session is serialized.** At most one turn may run against a task session;
   different task sessions may run concurrently.
6. **`NEXT` is routing, not lifecycle success.** It publishes the result of the
   current turn to workflow routing. It never by itself seals the task lifecycle as
   `succeeded`.
7. **`PREV` is feedback, not replay.** It adds a new feedback message to existing
   target task sessions. It does not create replacement tasks, replacement sessions,
   or replay a prior prompt.
8. **Feedback joins before requester resume.** A requester that emits `PREV` is not
   resumed by the first target response. Its feedback gate must receive all required
   target responses for that round.
9. **Inputs and responses have provenance.** Routing and aggregation use stable run,
   task, gate, message, and artifact identities rather than list position or arrival
   order.
10. **No implicit ancestor broadcast.** `PREV` addresses selected direct dependencies
    or all direct dependencies. A target may independently propagate another `PREV`
    to its own dependencies.
11. **Late and duplicate events are harmless.** A response can satisfy only its
    named open gate and feedback round; idempotency prevents duplicate turns.
12. **Loops are bounded.** Feedback rounds, turns, time, depth, and concurrency remain
    subject to host policy and have an explicit exhaustion/escalation outcome.
13. **Task routing never fans out.** A task node has at most one direct downstream
    consumer in its workflow run. Many upstream tasks may join into one consumer, but
    one task result is never shared by two consumers.
14. **One feedback authority per task.** Because a task has one direct consumer and
    belongs to one workflow run, only that consumer can route `PREV` into its session.
    Competing downstream sessions cannot issue conflicting feedback to the same task.

### 20.3 Vocabulary and execution units

| Term | Meaning |
|------|---------|
| **Workflow definition** | Versioned task nodes, dependency gates, routing edges, contracts, and policies created by a coordinator or host |
| **Workflow run** | One durable execution of a frozen workflow definition |
| **Task session** | The task's logical backend conversation, identified by its committed session ID; data, not a waiting process |
| **Turn** | One adapter `run()` that opens or loads the task session, sends one aggregate input message, and settles |
| **Activation** | Engine decision to create a turn because one dependency or feedback gate became satisfied |
| **Dependency gate** | Durable accumulator for the initial/current required upstream `NEXT` results |
| **Feedback round** | One `PREV` request plus its target set, feedback gate, and correlated responses |
| **Input reference** | Stable logical name exposed to a task for an input, backed by source-task and artifact provenance |
| **Artifact revision** | Immutable version of a task result; updating a result creates a revision rather than mutating prior input |
| **Continuation** | Engine-owned return address used when a nested workflow completes |

A task may have multiple turns over its lifetime, but never one turn per partial
dependency arrival. Typical planner behavior is:

```text
planner session
├── turn 1: dependency gate complete -> produce plan revision 1 -> NEXT
└── turn 2: feedback gate complete   -> revise plan          -> NEXT
```

There is no live planner process between those turns.

### 20.4 Workflow definition and frozen run

The concrete TypeScript may differ, but it must preserve these semantics:

```ts
interface WorkflowDefinitionV1 {
  id: string;
  version: number;
  entryTaskIds: string[];
  tasks: Record<string, WorkflowTaskDefinition>;
  terminalTaskId: string;
  policy: {
    maxFeedbackRounds: number;
    maxTurnsPerTask: number;
    runTimeoutMs: number;
    failure: 'fail_workflow';
  };
}

interface WorkflowTaskDefinition {
  taskId: string;
  dependencies: Array<{
    inputRef: string;
    sourceTaskId: string;
    required: true;
  }>;
  next?: {
    destinationTaskId: string;
    destinationInputRef: string;
  };
}
```

For v1, the coordinator defines the graph before execution and the engine freezes the
definition version into the workflow run. Dynamic addition/removal of nodes during a
run, partial/streaming gates, `ANY`, quorum, and arbitrary predicate gates are outside
the base contract. They may be added later without changing the v1 rule that a gate
must close before it activates its consumer.

The engine validates before release:

- every task and edge exists inside the permitted workflow scope;
- every `inputRef` is unique within its consumer;
- v1 allows at most one direct dependency/input reference from a given source task
  to a given consumer;
- every task belongs to exactly one workflow run and has zero or one outgoing routing
  edge: the unique terminal has none and every non-terminal task has exactly one;
- each routing edge maps to exactly one matching destination dependency declaration,
  and every non-entry dependency declaration has exactly one source routing edge;
- missing, duplicate, conflicting, or ambiguous route-to-gate mappings are rejected;
- dependency edges are acyclic;
- routing targets are valid;
- caller input contracts for every entry are defined and exactly one terminal task
  exists;
- session ownership, task depth/count, capabilities, and resource bounds hold.

Feedback creates bounded backward control flow over the otherwise acyclic dependency
graph; it does not make dependency readiness itself cyclic.

### 20.4.1 Run start and entry activation

Starting a workflow is one idempotent repository command. It:

1. Persists the frozen definition version, workflow run, caller continuation (when
   nested), and caller-supplied entry artifacts.
2. Creates one dependency gate for every task. Entry gates include the exact declared
   caller-input references; an entry with no caller data receives one explicit
   engine-authored start artifact rather than an implicit empty prompt.
3. Contributes and pins all caller inputs to their named entry gates.
4. For every entry gate satisfied by those inputs, atomically closes the gate and
   inserts its aggregate message and queued `TaskTurn` in the same transaction.
5. Commits before any process or adapter run is started.

The start operation has a stable idempotency key. Repeating it returns the existing
workflow run and cannot create duplicate gates, messages, or entry turns. An entry
whose declared caller inputs are incomplete remains blocked; release validation must
reject a run request that cannot ever supply its required entry contract.

### 20.5 Dependency gate and aggregate activation

Each consumer gets a durable gate for the exact required input set and run revision:

```ts
interface DependencyGateV1 {
  gateId: string;
  workflowRunId: string;
  consumerTaskId: string;
  requiredInputRefs: string[];
  received: Record<string, ArtifactRef>;
  status: 'open' | 'satisfied' | 'consumed' | 'failed' | 'cancelled';
  activationTurnId?: string;
}
```

Arrival of a dependency `NEXT` performs only the following until the gate is full:

1. Validate workflow run, source, `inputRef`, artifact revision, and idempotency key.
2. Persist the result under that `inputRef`.
3. Re-evaluate the gate.
4. If required inputs are still missing, do not queue or resume the consumer.

When the last required result arrives, one repository transaction changes
`open -> satisfied`, pins all input artifact revisions, inserts one deterministic
aggregate message, and inserts its queued `TaskTurn` with the reserved
`activationTurnId`. There is no reservation/enqueue crash window and no post-commit
callback is required for correctness. The scheduler may claim that already-persisted
turn only after commit. The turn consumes inputs ordered by the workflow
definition/input reference, not by nondeterministic arrival time.

The gate changes `satisfied -> consumed` in the same successful settlement transaction
that commits its activation turn's staged workflow outcome. A failed or interrupted
turn leaves the gate tied to that existing activation identity for explicit retry or
recovery; recovery never re-closes the gate or creates a second activation.

Example:

```text
explore-1 NEXT ─┐
explore-2 NEXT ─┼─> planner dependency gate ──(3/3)──> one planner turn
explore-3 NEXT ─┘

At 1/3 and 2/3: persist only; no planner process and no planner turn.
```

Two planners may depend on **disjoint** explorer sets. Each explorer routes to only one
planner; sharing one explorer between both planners is invalid fan-out and requires two
separate explorer tasks with independently owned sessions. Each planner activates when
its own required set is complete; tasks at the same visual level never wait for one
another without an explicit dependency.

### 20.6 `NEXT` contract

`NEXT` is one of three mutually exclusive workflow dispositions (`NEXT`, `PREV`, or
workflow `FAIL`) that an agent may stage on its live turn. Staging is idempotent by
turn and does not route work immediately. As with existing turn dispositions, only
adapter `turnCompleted` may commit it. The successful turn-settlement repository
transaction commits session identity, the staged workflow disposition, artifacts,
gate/round contributions, and durable outgoing routing messages together. A failed
or interrupted turn discards its staged workflow disposition and cannot activate
downstream work.

`NEXT` yields the current task result to the engine:

```ts
interface NextOutcomeV1 {
  type: 'next';
  change: 'updated' | 'unchanged';
  artifact: ArtifactRef;
  respondingToFeedbackRoundId?: string;
}
```

- `updated` publishes a new immutable artifact revision.
- `unchanged` is a valid response when feedback does not apply or the existing result
  already satisfies it. It still satisfies the named feedback gate.
- A normal `NEXT` contributes the artifact to its one configured downstream dependency
  gate using the edge's destination `inputRef`.
- A coordinator/caller with no configured downstream consumer may select the
  child-workflow invocation route defined in §20.12; it remains a `NEXT` disposition,
  not a fourth base outcome. A non-terminal workflow task that already has `next`
  cannot invoke a child workflow in v1.
- A `NEXT` responding to feedback satisfies only the matching feedback-round target;
  it cannot accidentally close a later or unrelated round.
- If the node is terminal, `NEXT` completes the nested workflow result and resolves
  its engine-owned continuation. The caller then receives that workflow result through
  its own gate; the terminal task does not need to know the caller identity.

For a feedback response, artifact lineage is validated before commit:

- `unchanged` must reference exactly the target's pinned base artifact ID and revision;
- `updated` must reference a newly persisted revision in the same artifact lineage,
  owned by that target task and produced for the named feedback round;
- cross-task artifacts, unrelated lineage, reused stale revisions, and revisions not
  produced by the responding turn fail closed and do not satisfy the round.

### 20.7 `PREV` targeting and feedback routing

`PREV` asks existing upstream task sessions to continue with additional feedback:

```ts
interface PrevOutcomeV1 {
  type: 'prev';
  feedback: unknown;
  route:
    | { type: 'inputs'; inputRefs: string[] }
    | { type: 'all_direct_dependencies' };
}
```

Targeted routing is preferred. The engine gives every task provenance-bearing inputs:

```ts
interface WorkflowInputV1 {
  inputRef: string;
  sourceTaskId: string;       // routing metadata; topology remains engine-owned
  artifactId: string;
  artifactRevision: number;
  value: unknown;
}
```

The task names logical `inputRef` values, not parent/peer relationships or raw graph
positions. The engine resolves those references to direct source sessions. When the
problem is cross-cutting or its source is unknown, `all_direct_dependencies` targets
every direct dependency. Broadcast is a fallback, not the default for known provenance.

An empty/invalid selected target set fails closed and cannot silently become a broad
broadcast. A task with no direct dependency cannot route `PREV` locally; at a workflow
entry boundary the engine may bubble the feedback through the workflow continuation
according to the caller's declared route, otherwise it reports a bounded routing
failure/escalation.

### 20.8 Feedback round and join

One `PREV` atomically creates one feedback round:

```ts
interface FeedbackRoundV1 {
  feedbackRoundId: string;
  workflowRunId: string;
  requesterTaskId: string;
  requesterTurnId: string;
  targets: Array<{
    feedbackTargetId: string;
    taskId: string;
    inputRef: string;
    baseArtifact: ArtifactRef;
  }>;
  responses: Record<string, NextOutcomeV1>; // keyed by feedbackTargetId
  status: 'open' | 'satisfied' | 'consumed' | 'failed' | 'cancelled';
  resumeTurnId?: string;
}
```

V1 uses an `ALL` join:

1. Resolve selected input references to unique source task/sessions, assign one stable
   `feedbackTargetId` to each, then persist the round, targets, feedback message, and
   base revisions. Release validation has already rejected multiple direct input
   references from the same source task to one consumer, so one source session receives
   exactly one feedback turn per round.
2. Deliver feedback to each target's durable queue. A target process need not be alive.
3. Each target resumes its existing task session when schedulable and eventually emits
   `NEXT(updated)` or `NEXT(unchanged)`. It may first emit another `PREV` to its own
   dependencies.
4. Each target response is keyed by its exact `feedbackTargetId` and persisted into
   the feedback gate. The `ALL` join ranges over that deduplicated target set.
   Responses may run in parallel across different task sessions.
5. Before every target has responded, do not execute the requester.
6. The final response atomically closes the round, pins all response revisions, creates
   one aggregate feedback-results message, and queues exactly one requester turn.

```text
planner PREV(targets = research, security)
    ├── research session resumes -> NEXT(updated)
    └── security session resumes -> NEXT(unchanged)
             both responses present
                       ↓
             one planner resume turn
```

A requester cannot open another feedback round while its current round is open, because
it has no runnable turn until the current `ALL` join completes. A target has only one
direct consumer, so no second downstream requester can address it. Repeated correction
is therefore sequential: finish round N, resume requester once, then optionally create
round N+1. Every response still carries `feedbackRoundId`, so late delivery from an old
round cannot satisfy the next one.

### 20.9 Sessions, turns, processes, and durable waiting

The workflow protocol follows the existing ACP turn model:

```text
gate becomes satisfied
    -> persist aggregate message and queued turn
    -> scheduler claims turn/session lease
    -> session/new or session/load
    -> session/prompt with aggregate message
    -> task emits NEXT, PREV, or FAIL
    -> atomically persist outcome and outgoing routing records
    -> settle turn and release execution resources
```

After settlement the records may read:

```text
task lifecycle: open
orchestration activity: waiting on dependency/feedback/next route
session binding: committed and resumable
turn: succeeded
live task process: none
```

Do not represent a workflow wait by keeping an adapter call, subprocess, promise,
socket, or in-memory callback alive. Durable gates and queued messages are sufficient
to recover the wait after extension restart. Reload does not manufacture a turn for
an incomplete gate and does not replay an uncertain running turn.

### 20.10 Persistence, ordering, and idempotency

Every routed event must carry enough identity to reject cross-run, stale, and duplicate
delivery. The concrete envelope must include equivalents of:

```ts
interface WorkflowMessageIdentityV1 {
  messageId: string;
  workflowRunId: string;
  sourceTaskId: string;
  sourceTurnId: string;
  destinationTaskId: string;
  gateId: string;
  feedbackRoundId?: string;
  artifactId?: string;
  artifactRevision?: number;
  idempotencyKey: string;
}
```

Required transaction boundaries:

- persist a gate contribution before acknowledging its routed message;
- close a gate and insert its aggregate message plus single queued activation turn
  atomically;
- persist `PREV`, its resolved targets, and its feedback round before delivery;
- on successful adapter settlement, atomically commit the turn/session, its one staged
  workflow disposition, artifacts, affected gates/rounds, and outgoing messages before
  scheduling destination turns;
- claim at most one running turn per task/session using a lease and revision/CAS check;
- make redelivery idempotent by message, gate contribution, feedback response, and
  activation-turn identity.

Artifact revisions are immutable and pinned by each gate. A feedback update does not
silently rewrite a prior consumed input. Only the unique requester waiting on that
feedback round is resumed. V1 has no other consumers to notify and therefore no
cross-branch revision cascade.

All workflow definitions/runs, artifacts/revisions, gates/contributions, feedback
rounds/responses, routed messages, continuations, turns, and idempotency records belong
to the existing SQLite `TaskRepository` transaction domain. They must not be held only
in memory or placed in a JSON/sidecar store. Each atomic boundary in this section is
one repository command and one SQLite transaction alongside affected task, turn, and
message records.

### 20.11 Failure, cancellation, and bounded loops

Workflow outcomes are distinct from infrastructure failures:

| Event | Meaning | Engine behavior |
|-------|---------|-----------------|
| `NEXT(updated)` | Relevant work produced a new revision | Contribute to named gate/round |
| `NEXT(unchanged)` | Feedback was irrelevant or already satisfied | Satisfy named feedback target without revision mutation |
| `PREV` | More work is required from upstream sessions | Create and await a feedback round |
| `FAIL` | Task cannot produce the required workflow result | Apply v1 `fail_workflow`; never reinterpret as `NEXT` |
| Adapter crash/timeout/interruption | Execution uncertainty or infrastructure failure | Preserve turn evidence and use existing explicit recovery policy; do not silently replay |

V1 has one required fail-fast policy, `failure: 'fail_workflow'`. An upstream workflow
`FAIL`, invalid route, run timeout, exhausted feedback/turn budget, cancelled required
target, or unrecoverable target failure atomically:

1. marks the workflow run `failed` (or `cancelled` when cancellation caused it);
2. marks its open dependency gates and feedback rounds `failed`/`cancelled`;
3. prevents reserved-but-not-running turns from starting and interrupts running turns
   in that workflow scope under existing interruption rules;
4. records one bounded aggregate reason and resolves a nested continuation with a
   typed failed/cancelled workflow result; and
5. recursively applies the caller workflow's same fail-fast rule, or, at the root,
   creates durable attention for the owning coordinator/user.

This workflow-run result is orchestration state. It never independently seals any
task lifecycle; authorized user/coordinator outcome rules still decide lifecycle.
There is no v1 per-edge choice to skip, continue, or guess another target. A future
policy variant must be separately versioned.

Cancellation closes open gates/rounds in the cancelled scope, prevents their reserved
activations from starting, and follows the existing descendant-cascade and lifecycle
authority rules. Late `NEXT`/`PREV` messages for closed rounds are retained as bounded
diagnostics or rejected idempotently; they never reopen work automatically.

### 20.12 Child-workflow invocation and return boundary

V1 supports the coordinator/caller-continuation case: a currently executing task may
create and enter one child workflow, then be resumed when that child returns. V1 does
**not** represent an arbitrary child workflow as a static node inside another frozen
workflow graph. General nested graph nodes with their own incoming/outgoing edges are
a future versioned extension.

Every workflow definition has exactly one terminal task. The caller stages `NEXT` with
a child-workflow invocation route as its mutually exclusive workflow disposition for
the current turn. The invocation explicitly maps caller artifacts into child entry
inputs and creates a one-result return gate for the caller:

```ts
interface ChildWorkflowInvocationV1 {
  invocationId: string;
  callerTaskId: string;
  callerTurnId: string;
  callerWorkflowRunId?: string;
  childDefinitionId: string;
  childDefinitionVersion: number;
  entryBindings: Array<{
    callerArtifact: ArtifactRef;
    childEntryTaskId: string;
    childInputRef: string;
  }>;
}

interface WorkflowContinuationV1 {
  continuationId: string;
  invocationId: string;
  callerTaskId: string;
  callerTurnId: string;
  callerWorkflowRunId?: string;
  childWorkflowRunId: string;
  returnGateId: string;
  status: 'pending' | 'resolved' | 'consumed' | 'failed' | 'cancelled';
  resultArtifact?: ArtifactRef;
}
```

On successful caller-turn settlement, one repository transaction validates every
entry binding against the frozen child definition, persists the child run and unique
continuation, creates all child gates, contributes the pinned caller artifacts, and
inserts queued turns for child entry gates that are satisfied. A missing, duplicate,
or type-incompatible entry binding fails the caller disposition without partially
starting the child. The caller then has no live process; its durable return gate is the
wait state.

Invocation validation also requires that the caller has no configured downstream
consumer, no open feedback round, and no pending child continuation. While the child
run is open, that continuation is the caller's sole resume authority. Child entry tasks
cannot route `PREV` across the workflow boundary into the caller; they may address only
their own direct dependencies. A child entry task with no dependency that emits `PREV`
fails the child workflow under §20.11. Thus multiple child entry sessions can never
become competing feedback authorities for the caller session.

- The unique terminal task's committed `NEXT` atomically resolves the continuation,
  contributes its artifact to the return gate, closes that one-result gate, and inserts
  one aggregate return message plus one queued caller turn.
- The caller resumes only from that aggregate return message. If it belongs to another
  workflow, it may then emit its own `NEXT` or `PREV` through that workflow normally.
- Entry-boundary `PREV` never bubbles to the caller in v1; §20.11 fail-fast handling
  applies.
- Resolution and consumption are idempotent; reload can distinguish an unresolved,
  resolved-but-not-consumed, consumed, failed, or cancelled continuation. A failed or
  cancelled child follows §20.11 and cannot resolve twice.
- Workflow return is an engine operation distinct from `PREV`, even if product-level
  explanations describe it as control returning to the coordinator.

### 20.13 Canonical planning example

```text
Coordinator turn
    creates and releases PlanningWorkflow

research-1 ─┐
research-2 ─┼──> Planner ──NEXT──> PlanVerifier
research-3 ─┘                       │
                                   ├──PREV(inputRefs=[plan])──> Planner
                                   │                              │
                                   │             Planner may PREV selected research
                                   │                              │
                                   │<──────────── Planner NEXT ───┘
                                   │
                                   └──NEXT(approved), terminal
                                                │
                                      workflow continuation
                                                │
                                      resume Coordinator gate/turn
```

Operationally:

1. Research tasks run concurrently because their entry gates are independently ready.
2. Each research `NEXT` only contributes to the planner gate. Planner does not run at
   1/3 or 2/3.
3. At 3/3 the engine aggregates the three pinned results and creates one planner turn.
4. Planner `NEXT` contributes the plan artifact to the verifier gate.
5. Verifier `PREV` creates feedback for the existing planner session. If planner needs
   source corrections, it targets selected research `inputRef` values or all direct
   dependencies and waits for that feedback gate.
6. Every feedback join resumes its requester exactly once with all target responses.
7. Verifier terminal `NEXT` completes the workflow and satisfies the coordinator's
   continuation gate. Only then does the coordinator receive one aggregate resume turn.

### 20.14 Explicit v1 exclusions and future extensions

The base contract intentionally excludes:

- executing a consumer on partial dependency results;
- streaming/speculative activation;
- `ANY`, quorum, or arbitrary predicate joins;
- dynamic graph mutation after a workflow run is frozen;
- automatic semantic selection of `PREV` targets by an LLM inside the engine;
- implicit broadcast beyond direct dependencies;
- task-result fan-out to multiple downstream consumers;
- concurrent feedback rounds for one requester or competing feedback requesters for
  one target session;
- keeping a CLI process alive while waiting;
- treating `NEXT`, turn completion, or process exit as task lifecycle success;
- exactly-once process execution claims. The contract is durable, idempotent
  at-least-once delivery with at-most-one committed activation per gate.

Future extensions may add richer gates, dynamic sub-workflows, feedback coalescing,
or incremental computation, but they must be versioned and must not weaken session
ownership, aggregate-before-execute, provenance, bounded-loop, durability, or
lifecycle-separation invariants.
