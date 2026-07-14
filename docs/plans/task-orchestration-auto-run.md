# Plan: Task orchestration auto-run (brief, release, dataflow)

## Status
**APPROVED** — codex-plan-review 2026-07-14-002 (2 rounds; ISSUE-12…17 fixed).  
Session: `.codex-review/sessions/codex-plan-review-20260714-002`.

Prior APPROVED plan was lost (never committed). This document is a full rewrite incorporating:

- Design consensus: codex-think-about `codex-think-about-20260714-001`
- Prior plan-review fixes ISSUE-1…11 + ISSUE-5 worker-seal clarification
- Round-1 re-review ISSUE-12…17 (sealedBy paths, trust, reload, startNewTask, promote wake-ups, wakeOn default)
- Current tree reality: store **schema v4**, M010 **TaskHandoff** on `MusterTask`, existing `create_task` / `delegate_task` / `start_task` / `wait_for_tasks` / `startNewTask`

Normative product language also belongs in [`docs/TASK-MANAGEMENT.md`](../TASK-MANAGEMENT.md) (extend §5/§7/§8 + orchestration section when APPROVED; do not fight M010 handoff section).

---

## Target product

User / coordinator mental model:

- **Everything executable is a task** (plan, implement, test, verify, coordinate).
- Coordinator **creates a graph** (rich briefs) and **waits**; does **not** start CLI processes.
- Engine **auto-runs** released tasks when dependencies + resources allow.
- **Serial / parallel** = dependency edges + concurrency limits (no “wave” engine primitive).
- **Shared cwd** by default; overlapping write paths serialize; worktrees optional later.

Example chain:

```text
root (coordinate)
  └─ plan (Codex) ──succeeded + summary──► implement* (parallel if disjoint writePaths)
                                         └─► test / verify (join)
```

---

## Evidence (current state)

**Already in tree**

- `MusterTask` / `TaskTurn` / deps / wait sets / op ledger (`src/task/types.ts`, `engine.ts`, `engine-graph.ts`, `transitions.ts`)
- MCP tools: `create_task` (inert child), `delegate_task` (create+queue), `start_task`, `wait_for_tasks`, `complete_task` / `fail_task` (`coordinator-tools.ts`, `bridge/server.ts`)
- Capability map + credential `allowedActions` enumerate tools explicitly (`capabilities.ts`)
- Lifecycle ≠ CLI exit (docs); child seal still uses `parentId !== null` heuristic in `applySuccessfulTurn`
- Limits, leases, reload interrupt without uncertain replay
- Schema **v4** + optional `handoff?: TaskHandoffState` (M010) — must remain compatible
- Credential TTL currently shorter than max turn timeout (must fix functionally in W8)

**Gaps this plan closes**

- No `TaskBrief` / structured `TaskResult` / `inputBindings` — deps are **ordering only**
- No paused + atomic **release** with durable `releaseState`
- Scheduler only promotes **existing queued turns** — release must create first-turn intents
- No attention wake state machine
- No path/resource conflict prevention
- MCP status/errors too thin for graph UX
- `sealedBy` / explicit parent-orchestration policy not fully modeled

---

## Goals

1. Land orchestration contract in code: brief, result, release, dataflow, attention, readiness.
2. Plan → implement chain auto-runs with **plan summary injected** into implement first prompt via bindings + durable pin.
3. Coordinator happy path: `create_task*` (draft) → `release_tasks` → `wait_for_tasks` (**no** coordinator `start_task`).
4. Single readiness evaluator for scheduler + UI + `get_task_status`.
5. Keep architecture: **records + pure transitions + `TaskEngine`** (no OOP `task.start()` domain entities). Coexist with existing M010 `TaskHandoff` aggregate.

## Non-goals (v1)

- Default / mandatory git worktrees
- Full named mutex catalog beyond writePaths + git mutation mutex
- Workspace revision fences / historical snapshot verify
- Strong FS sandbox or automatic rollback of agent edits
- MCP experimental Tasks as Muster lifecycle
- Full `yolo` / complete append-only audit log (`sealedBy` on seal is enough)
- OOP `task.start()` / Active-Record tasks
- Full multi-ref `create_task_graph` as the only API (paused + release is enough)
- Named `outputs` map on `complete_task` beyond **`summary`** (defer v1.1)

---

## Product contract (normative summary)

| Topic | Decision |
|-------|----------|
| Create default (MCP / inert host create) | `releaseState: 'draft'` — not scheduler-eligible |
| Atomic released create-and-run exceptions | (1) MCP `delegate_task` (2) **host/user `TaskEngine.startNewTask`** (VS Code composer) — both create as `released` + first turn in one transaction |
| Run (multi-node graph) | Atomic `release_tasks` |
| Auto-run | Scheduler-eligible when ready — not guaranteed immediate spawn |
| First-turn mechanism | **At release, every released task gets a durable first-turn intent** (queued turn; may stay blocked) |
| Dataflow | Explicit `inputBindings` + `TaskResultV1` + **pinned revision + frozen resolved inputs** before dispatch |
| Binding selectors (v1) | **`summary` only** |
| Serial / parallel | Deps + concurrency only |
| Isolation | Shared cwd + conflict prevention (**not** a security sandbox) |
| Attention | Durable non-terminal state; may wake parent; **never** seals lifecycle |
| Child seal (supervised) | Named host parent-orchestration policy; **workers stage only**; every seal records `sealedBy` user\|coordinator |
| `start_task` | **Host / recovery only** — not in coordinator MCP `allowedActions` |
| Product enablement | W1–W8 AC + W9 trust/reload AC (not W1–W6 alone) |
| Credential TTL | **Functional:** token lifetime ≥ turnTimeoutMs for that turn |

---

## Resolved product decisions (v1)

| # | Decision |
|---|----------|
| Tool name | `release_tasks` |
| Release set | Explicit `taskIds[]` + optional `includeDependencies?: boolean` (default **false**) |
| Binding selectors | **`summary` only** until v1.1 adds structured outputs to `complete_task` |
| Git claim | Host field `claimsGit?: boolean` (default **false**) |
| Mutator classification | Mutating if `writePaths` non-empty **OR** `claimsGit` **OR** brief.kind ∈ {`implement`} (host kind table) |
| Child-seal policy | Workspace default copied onto **root** at root creation: `childOrchestrationSeal: 'parent_may_seal_direct'` |
| Path overlap | Workspace-relative normalize; overlap if equal **or** ancestor/descendant prefix |
| Credential TTL | Extend bridge credential TTL to cover turn budget (not “document only”) |
| Worker seal | **Never.** Workers only **stage** disposition; host seals eligible children via parent policy |

---

## Persisted state additions (cross-cutting)

Bump store `schemaVersion` (v4 → **v5**). Migrate in `store.ts`. Preserve M010 `handoff` unchanged.

```ts
type TaskReleaseState = 'draft' | 'released';

// On MusterTask (additive):
releaseState?: TaskReleaseState; // migrate: any turn exists → 'released'; else 'draft'
releasedAt?: string;
releaseAttemptId?: string;
brief?: TaskBriefV1;
taskResult?: TaskResultV1;       // structured; keep legacy result?: string as summary mirror
inputBindings?: TaskInputBinding[];
claimsGit?: boolean;
attention?: {
  code: 'missing_disposition' | 'missing_input' | 'dependency_blocked' | 'recovery_exhausted' | string;
  message: string;
  at: string;
  sourceTurnId?: string;
};
sealedBy?: { kind: 'user' } | { kind: 'coordinator'; taskId: string; turnId?: string; mode: string };
childOrchestrationSeal?: 'parent_may_seal_direct' | 'propose_only'; // primarily on roots

// On TaskTurn:
resolvedInputs?: ResolvedInputPin[]; // durable pin before dispatch
compiledPrompt?: string;             // optional frozen first prompt

// Wait extension (children kind):
// wakeOn?: Array<'terminal' | 'needs_attention'>;
// phase?: 'active' | 'suspended_attention';
// attentionContinuationTurnId?: string;
// terminalObserved?: Record<string, 'succeeded' | 'failed' | 'cancelled' | 'skipped'>;
```

**Migration rules**

- Tasks with ≥1 turn → `releaseState: 'released'` (do not block legacy work).
- Tasks with zero turns → `releaseState: 'draft'`.
- Missing brief → synthesize from `goal` / `description`.
- Legacy `result` string → optional `taskResult { version:1, revision:1, summary }` on read when needed for dataflow.
- Never auto-run draft tasks after migration.

**Immutability after release:** brief, dependencies, inputBindings, writePaths, claimsGit fail-closed if mutated while `releaseState === 'released'` (except host cancel/skip/lifecycle seal).

---

## Workstreams

### W1 — TaskResultV1 + inputBindings + durable pin

**Files:** `types.ts`, `src/task/dataflow.ts` (new), `transitions.ts` (seal writes `taskResult`), promote/execute path in `engine.ts` / `engine-graph.ts`, tests.

- `TaskResultV1`: `{ version:1, revision, summary }` only in v1.
- `complete_task` → stage disposition; on seal/propose persist `taskResult` + mirror `result` string.
- Bindings: `output: 'summary'` only; reject other keys at release validation.
- **Durable pin (same store commit before process dispatch):**
  1. `resolveInputBindings(bindings, producers)`
  2. Persist `turn.resolvedInputs` (+ optional `compiledPrompt`)
  3. Assign first-turn message / agent text from pin
  4. Never re-pin with different content (producer reopen cannot rewrite pin)
- Missing required summary after producer terminal without result → dependent `attention: missing_input`.

**AC**

- [ ] Implement with binding to plan `summary` receives plan text in first turn input.
- [ ] Unbound dependency does not inject predecessor content.
- [ ] Producer reopen after pin does not change persisted pin texts.
- [ ] No dispatch without persisted pin when bindings non-empty.

### W2 — TaskBriefV1 + prompt compiler + schema migrate

**Files:** `types.ts`, `src/task/brief.ts` (new), create/release paths, `store.ts` v5 migrate, tests.

Minimal `TaskBriefV1`:

```ts
{
  version: 1;
  kind: 'coordinate' | 'plan' | 'implement' | 'test' | 'verify' | 'research' | 'generic';
  title: string;
  objective: string; // mirrors MusterTask.goal
  context?: string;
  nonGoals?: string[];
  constraints?: string[];
  acceptanceCriteria: string[];
  definitionOfDone?: string[];
  readPaths?: string[];
  writePaths?: string[];
  verification?: { commands?: string[]; manualChecks?: string[] };
  expectedOutputs?: string[]; // v1: only "summary" meaningful
  inputBindings?: TaskInputBinding[]; // may live on task root instead; one source of truth
}
```

- `compileTaskPrompt(brief, resolvedInputs, meta) → string` with untrusted-input framing.
- Kind preambles host-owned (plan/implement/test/verify).
- Migration tests for v4 → v5.

**AC**

- [ ] Old stores load; goal preserved; releaseState correct.
- [ ] Compiler unit tests: framing, truncation, kind preamble.

### W3 — Paused create + atomic release + first-turn intents + start_task lockdown + MCP

**Files:** `types.ts`, `store.ts`, `deps.ts`, `capabilities.ts`, `coordinator-tools.ts`, `bridge/server.ts`, `engine-graph.ts`, `engine.ts`, tests.

#### 3.1 Durable release

- `create_task` → `releaseState: 'draft'`, no first turn.
- `release_tasks` `{ requestKey|opId, taskIds[], includeDependencies?: boolean }`:
  - Resolve set; **all-or-nothing** validate (cycles, limits, brief, bindings summary-only, backends, path normalize, ownership).
  - Success: `released` + freeze + `releaseAttemptId`.
  - Failure: no member leaves draft; structured per-task errors; no schedule notify.

#### 3.2 First-turn intent for every released node (critical)

On successful release, for each task in set without a first turn:

- Create durable `TaskTurn` `status: 'queued'`, `trigger: 'engine'`.
- If not ready: remains queued; readiness reports blockers; **do not spawn**.
- When deps/resources clear: existing promote loop runs after W1 pin commit.

Do **not** rely solely on scanning released tasks with zero turns.

**Atomic released create-and-run paths (must not become permanent draft):**

| API | releaseState | First turn |
|-----|--------------|------------|
| MCP `create_task` | `draft` | none until `release_tasks` |
| Host inert `createTask` (if any) | `draft` | none |
| MCP `delegate_task` | `released` | queued in same txn |
| Host **`startNewTask`** (VS Code send) | `released` | queued + schedule in same txn |

Regression test: extension/`startNewTask` path still runs first turn (not stuck draft).

#### 3.3 `start_task` cannot bypass release

- Remove `start_task` from coordinator credential tools / `allowedActions`.
- Engine rejects coordinator-credential start on `draft`.
- Host recovery may start/release with host context only.

#### 3.4 Full MCP wiring for `release_tasks`

- `ToolAction` + `CAPABILITY_TO_ACTIONS` (`create_child` includes `release_tasks`).
- Bridge schema, list, dispatch, credential filter.
- Structured errors: `{ code, message, taskErrors?, retryable?, blockedBy? }`.
- E2E: create×N → release → wait; no `start_task`; invalid release atomic.

**AC**

- [ ] Multi-child draft: none run until release succeeds.
- [ ] Partial validation → entire set stays draft.
- [ ] Idempotent release with same requestKey.
- [ ] Dependent with unsatisfied deps still has queued first-turn after release; runs after dep succeeds.
- [ ] Coordinator MCP cannot start_task a draft child.
- [ ] E2E bridge path success + atomic fail.

### W4 — Minimal authority alignment + sealedBy on **all** terminal paths

**Files:** `types.ts`, `transitions.ts`, `engine.ts` (every lifecycle writer), tests.

**Locked v1 policy**

Workers **never** seal. They only **stage** `complete_task` / `fail_task`.  
`sealedBy` is only `{ kind:'user' }` or `{ kind:'coordinator', … }`.  
**Every** transition that writes a terminal lifecycle **must** persist `sealedBy` (no optional path).

| Terminal-writing path (current main) | Who seals | `sealedBy` |
|--------------------------------------|-----------|------------|
| Root disposition complete/fail under `user_confirm` | User Accept/Reject via `setTaskLifecycle` / acceptOutcome | `{ kind:'user' }` |
| Direct child disposition + root `parent_may_seal_direct` | Host parent-orchestration on turn commit | `{ kind:'coordinator', taskId: parentId, turnId, mode }` |
| Worker stages disposition only | **No seal** | — |
| User cancel / skip / status menu (`setTaskLifecycle`) | User | `{ kind:'user' }` |
| Coordinator `cancel_task` (and cascade) | Coordinator (caller task) | `{ kind:'coordinator', taskId: caller, … }` |
| Cancel/skip **cascade** to descendants | Same actor as root of the cancel/skip action | Same `sealedBy` as the initiating seal (copy actor) |
| Dependency `onUnsatisfied: fail` / `skip` | Host policy as coordinator orchestration under root | `{ kind:'coordinator', taskId: dependent.parentId ?? rootId, mode: 'dependency_policy' }` |
| CLI success without disposition | **No seal** | `attention.missing_disposition` |

Replace bare `parentId !== null` with named policy check. Persist `sealedBy` on `setTaskLifecycle` (today accepts but may not store — fix).

**AC**

- [ ] Root complete → proposal, open.
- [ ] Eligible direct child → sealed + `sealedBy.kind === 'coordinator'`.
- [ ] Worker stage alone → no seal.
- [ ] No disposition → open + attention.
- [ ] User cancel/skip and cascades set `sealedBy.user`.
- [ ] Coordinator cancel sets `sealedBy.coordinator`.
- [ ] Dependency fail/skip sets `sealedBy.coordinator` with mode `dependency_policy`.
- [ ] No terminal lifecycle write without `sealedBy` in new code paths (test matrix over transitions).

### W5 — Readiness evaluator

**Files:** `src/task/readiness.ts` (new), `scheduler.ts`, promote, snapshot/status.

One function → structured reasons, e.g.:

- `paused_not_released` / `draft`
- `waiting_dependencies`
- `missing_input_binding`
- `waiting_resource` / `path_conflict` / `git_mutex`
- `held_reload` / `held_after_failure`
- `needs_attention`
- `ready` / `queued` / `running`

Scheduler promote and `get_task_status` / UI consume the **same** evaluator. W7 conflict rules used at promote.

#### 5.1 Centralized schedule rescan (critical — ISSUE-16)

Current main mainly rescans queued turns after an **executing turn settles**. That is insufficient.

**Normative:** after any store commit that may change readiness, engine calls a single `rescanSchedulableTurns(rootId | affectedTaskIds)` (name flexible) which re-evaluates queued released turns via the readiness evaluator and promotes when eligible.

**Trigger matrix (minimum):**

| Event | Must rescan dependents / queued |
|-------|----------------------------------|
| `release_tasks` success | Yes — released set |
| Turn settle (success/fail/interrupt/cancel) | Yes — task + waiters + dependents |
| User/coordinator lifecycle seal (`setTaskLifecycle`, accept/reject outcome) | Yes — dependents of sealed task |
| Cancel/skip cascade | Yes — affected subgraph |
| Dependency policy terminal (fail/skip dependent) | Yes |
| Resource/lock free (turn leaves running) | Yes |
| Handoff completion (M010) if it unblocks work | Yes if task becomes runnable |
| Workspace trust granted | Yes — all held-for-trust |
| Safe reload recovery complete | Yes — safe queued released turns |

**AC**

- [ ] Same fixture → identical reasons in scheduler gate and status API.
- [ ] Draft vs waiting_deps vs path_conflict distinguished.
- [ ] User Accept on producer unblocks queued dependent implement (not stuck forever).
- [ ] Release of blocked dependents leaves first-turn queued until producer seals, then auto-promotes after rescan.

### W6 — Attention wake (durable state machine)

**Files:** wait types, `engine-graph.ts` / `engine.ts`, `wait_for_tasks` schema, reload, tests.

1. Parent registers `wait_for_tasks`.
2. **`wakeOn` default (normative):** if omitted on a **new** wait, default to `['terminal', 'needs_attention']`. Legacy migrated waits without field → treat as `['terminal']` only.
3. Persist wait: `phase: 'active'`, `terminalObserved: {}`, `wakeOn` stored explicitly after defaulting.
4. Child terminal → record observation; if all terminal and wakeOn includes terminal → one continuation (idempotent key).
5. Child attention + wakeOn includes `needs_attention` → `phase: 'suspended_attention'`; one attention continuation; **do not** clear terminalObserved.
6. **Re-arm:** new `wait_for_tasks` call = new wait epoch (supersedes suspended).
7. Reload: rehydrate; no duplicate continuations.

**AC**

- [ ] Parent wait **without** explicit wakeOn still wakes on missing child disposition (default both).
- [ ] Legacy wait without wakeOn remains terminal-only after migration.
- [ ] Terminal preserved across suspend; re-arm works.
- [ ] No duplicate continuations on double event or reload.

### W7 — Shared-cwd serialization

**Files:** readiness / promote transaction, brief writePaths, tests.

1. Normalize workspace-relative paths; reject `..` escape.
2. Overlap: equal or ancestor/descendant prefix (`src` ∩ `src/a.ts`).
3. Conflict if both mutating and (paths overlap **or** unscoped mutator **or** both claimsGit).
4. Non-mutating: no write lock.
5. **Acquire in same `store.commit` as queued→running**; on conflict leave queued.
6. Concurrent promote tests (two writers cannot both win).

**AC**

- [ ] Overlapping writePaths never concurrent running.
- [ ] Disjoint may concurrent under global cap.
- [ ] Ancestor paths detected.
- [ ] Race-safe promote.

### W8 — MCP UX + credential lifetime

**Files:** `bridge/server.ts`, `credentials.ts`, capabilities, status projection, tests.

- Rich tool descriptions for create/release/wait/status/complete.
- Structured release errors.
- `get_task_status`: lifecycle, releaseState, readiness, wait phase, attention, result.summary.
- **Credential TTL:** `ttlMs` covers turnTimeoutMs (extend token). Test disposition after former 15m boundary within configured turn timeout.

**AC**

- [ ] Status explains “why not running”.
- [ ] Invalid release → structured per-task errors.
- [ ] complete_task authorized for full turnTimeoutMs.

### W9 — Safety gates (product enablement)

#### 9.1 Workspace Trust integration contract (ISSUE-13)

| Layer | Responsibility |
|-------|----------------|
| `src/extension.ts` | Read `vscode.workspace.isTrusted`; pass `isWorkspaceTrusted: () => boolean` (or equivalent) into `TaskEngineConfig`; subscribe `onDidGrantWorkspaceTrust` → engine `onWorkspaceTrustGranted()` → rescan |
| `TaskEngine` | Gate **all** paths that create-and-queue as released or promote/spawn: `release_tasks`, `delegate_task`, `startNewTask`, promote/runTurn, host recovery start, safe reload auto-resume |
| Refusal | Structured error `{ code: 'workspace_untrusted', message, retryable: true }` — draft create may still persist graph without running |
| Trust granted | Clear trust holds; `rescanSchedulableTurns` for released queued turns |

Trust check **not** only inside `release_tasks` — any bypass path above must enforce the same predicate.

#### 9.2 Reload policy (locked v1) (ISSUE-14)

| On-disk / observed state | Reload classification | v1 action |
|--------------------------|----------------------|-----------|
| Queued, never `running`, `dispatchPhase` missing or only pre-queue | **safe_never_dispatched** | If task `released` and trusted: eligible for auto-resume after reconcile (clear defer hold for these only) |
| `running` / `waiting_user` orphan | interrupt → **uncertain** if prompt may have started | Hold; no silent replay; user/host recovery |
| `dispatchPhase: 'pre_dispatch'` only (promoted but prompt not sent) | **safe_to_retry** | May re-promote under same rules as safe queued |
| `dispatchPhase: 'prompt_outstanding'` | **uncertain** | Hold; never silent replay |
| `dispatchPhase: 'terminal_received'` | settled | No replay |
| Draft + any queued (should not happen) | invalid | Do not run; repair to draft without turns or mark needs_attention |

**Default vs today:** today `deferReloadQueuedTurns` holds **all** queued. v1 **narrows** defer to non-safe / uncertain only; **safe_never_dispatched released** engine turns auto-resume after reload when workspace trusted.

**AC**

- [ ] Untrusted: release, delegate_task, startNewTask, promote all refuse with `workspace_untrusted`.
- [ ] Trust grant rescans and allows previously held safe work.
- [ ] Reload: safe released queued auto-resumes; uncertain never silent replay.
- [ ] Outside-writePaths detection = optional v1.1 (not enablement-blocking).

---

## Implementation order

```text
W1 Result/bindings + durable pin
W2 Brief/prompt + schema v5 migrate     } overlap after types
W3 Paused + release + first-turn + start_task lockdown + MCP wire
W4 Authority min + sealedBy               } parallel tests
W5 Readiness
W6 Attention durable wake
W7 Path/git serialize in promote txn
W8 MCP UX + credential TTL
W9 Trust + reload gates
```

**Product enablement gate:** multi-task auto-run defaults only after **W1–W8 AC** and **W9 trust/reload AC**.

---

## Test matrix (contract)

| Case | Expect |
|------|--------|
| Serial plan → implement `summary` binding | First prompt contains plan summary; pin survives producer reopen |
| Parallel disjoint writePaths | Concurrent under cap |
| Parallel overlapping / ancestor paths | Serialized |
| Join test deps [A,B] | First-turn exists after release; not ready until both succeeded |
| Release validation fail | All remain draft |
| Coordinator start_task on draft | Rejected / not offered |
| Missing disposition | Attention wake parent; lifecycle open |
| Attention then terminal | Re-arm; no lost terminal; no dup continuations |
| Reload mid-queue | No uncertain replay; draft stays draft; released queued preserved |
| Credential past old 15m | complete_task still works within turnTimeout |
| Untrusted workspace | No auto-run / release denied |
| Child cancel cascade | Descendants cancelled; waits settle |
| Idempotent release / wait | No duplicate turns |
| E2E MCP create → release → wait | No start_task; happy path |

```bash
npm test -- src/task/
npm run test:source-boundary
```

---

## Docs follow-up (after APPROVE, with implementation)

- Update `TASK-MANAGEMENT.md`: create vs release, ordering vs dataflow, attention wake, tool surface, Phase F checklist (do not drop M010 handoff section).
- Link this plan from `docs/README.md`.

---

## References

- Prior think-about: `.codex-review/sessions/codex-think-about-20260714-001`
- Prior plan-review: `.codex-review/sessions/codex-plan-review-20260714-001`
- [`docs/TASK-MANAGEMENT.md`](../TASK-MANAGEMENT.md)
- [`docs/MUSTER-BRIDGE.md`](../MUSTER-BRIDGE.md)
- [`docs/DESIGN.md`](../DESIGN.md)
- Code: `src/task/*`, `src/bridge/server.ts`
