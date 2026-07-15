# Delegate-task hardening follow-up plan

**Status:** plan only (M011 S04 T03) — **no runtime changes in this milestone**  
**Audience:** next milestone planner / executor  
**Evidence date:** 2026-07-15 (M011 worktree)  
**Primary sources:** `src/task/engine-graph.ts`, `src/task/limits.ts`, `src/task/coordinator-tools.ts`, `src/task/resources.ts`, `src/task/transitions.ts`, `src/task/limits.test.ts`, `src/task/engine-graph.test.ts`, `src/task/coordinator-tools.test.ts`, `src/task/transitions.test.ts`, `docs/TASK-MANAGEMENT.md`, `scripts/smoke-child-model-opencode.mjs`

---

## 1. Purpose and non-goals

### Purpose

Produce an evidence-based hardening plan for the coordinator **delegate / create-child** path so a future milestone can close production gaps without rediscovering current behavior from code.

### Non-goals (this document)

- **No runtime, tool schema, or webview changes** as part of M011 S04 T03.
- **No** expansion into full multi-agent autonomy / “yolo” auto-approve product modes.
- **No** promotion of Playwright or smoke scripts into native Extension Development Host proof.
- **No** redesign of task lifecycle authority (user remains ultimate sealer; coordinator seal is gated).

### Required vs optional

| Class | Scope |
|-------|--------|
| **Required hardening** | Correctness, safety, persistence, and proof for existing coordinator tools: `delegate_task`, `create_task` + release, `wait_for_tasks`, `set_task_lifecycle`, `cancel_task` / `interrupt_task`, progress visibility, model resolution, child transcript navigation, resource limits |
| **Optional autonomy expansion** | Root auto-seal policies, unattended multi-wave orchestration, auto-retry of failed children without user review, “yolo” permission bypass, automatic git claim widening |

---

## 2. Confirmed current behavior (code facts)

### 2.1 Tool surface (coordinator)

| Tool | Role | Confirmed engine behavior |
|------|------|---------------------------|
| `create_task` | Coordinator (`create_child`) | Falls through into the shared create path with `releaseState: 'draft'` — **no first turn**, **no schedule** |
| `delegate_task` | Coordinator | Same create path with `releaseState: 'released'`, stamps `releasedAt` / `releaseAttemptId`, creates assigned user message + first turn, then **`onScheduleTurn`** (atomic create-and-run) |
| `release_tasks` / `start_task` | Coordinator | Separate release/start path for draft children (not re-documented here; still part of the non-atomic alternative to `delegate_task`) |
| `wait_for_tasks` | Coordinator | Stages turn disposition `{ kind: 'wait_tasks', taskIds }`; **direct children only** (`draftChildOwned`); subject to turn-cap checks |
| `set_task_lifecycle` | Coordinator | Parent seal of **owned direct child**; blocked when root `childOrchestrationSeal === 'propose_only'`; `cancelled`/`skipped` cascade descendants; `succeeded`/`failed` seal **target only** |
| `cancel_task` | Coordinator | Owned direct child; **cascades descendants**; remote lease → cancel request; local lease → abort + `transitionCancelTask` |
| `interrupt_task` | Coordinator | Same case arm as cancel with early branch: **no subtree cascade**; remote → interrupt request; local → interrupt live turn + hold queued follow-ups |
| `report_progress` | Worker/coordinator (tool exists) | **Ack-only**: returns `{ noted: note.slice(0, 512) }` — **no TaskStore write**, no snapshot field, no UI projection |
| `complete_task` / `fail_task` | Worker (self) | Stages **turn disposition** only (result/error size-checked); does **not** seal task lifecycle |
| `get_task_status` / `get_task_tree` / `list_task_types` / `get_host_context` | Read paths | Present; tree capped (e.g. 32 nodes) |

Implementation note: `case 'create_task':` immediately falls into `case 'delegate_task': { ... }` in `engine-graph.ts`. The branch chooses draft vs released via `command.kind === 'delegate_task'`.

### 2.2 Create / delegate pipeline (shared)

Before mutation:

1. **Workspace trust** — `delegate_task` only: untrusted workspace → structured `workspace_untrusted` (retryable).
2. **Task type registry** — fail-closed `resolveCreateChildSpec` (taskType / backend / model / role / briefKind).
3. **Backend bind** — known backend id, `makeBackend`, MCP-capable (`backend_not_mcp` otherwise).

Inside store commit:

1. Caller must be **open**.
2. Deterministic child/turn ids from `(turnId, opId)`; ledger-backed idempotency on collision.
3. **Depth:** `parentDepth + 1 >= maxDepth` → `max depth exceeded`.
4. **Fan-out:** `children_per_task` and `children_per_root` via `checkLimit`.
5. Input bindings validated for release; brief merged from goal/description/paths.
6. Child **cwd inherits parent** (never falls back to process cwd).
7. Capabilities: coordinator child vs worker defaults by resolved role.
8. **`executionPolicy` always clamped** via `clampExecutionPolicy` (agent values never trusted raw).
9. `create_task` → draft only; `delegate_task` → released + first turn + schedule.

### 2.3 Default resource limits (`DEFAULT_RESOURCE_LIMITS`)

| Limit | Default |
|-------|---------|
| `maxDepth` | 8 |
| `maxChildrenPerTask` | 32 |
| `maxChildrenPerRoot` | 64 |
| `maxTurnsPerTask` | 50 |
| `maxConcurrentTurns` | 4 |
| `maxConcurrentPerRoot` | 4 |
| `maxConcurrentPerBackend` | 2 |
| `maxResultBytes` | 16_384 |
| `maxErrorBytes` | 4_096 |

Execution policy clamp bounds (`DEFAULT_EXECUTION_POLICY_BOUNDS`): turn timeout 1s–30m, task timeout 1s–4h, maxTurns ≤ 500, maxAutomaticRetries ≤ 20. Bridge token TTL covers turn budget with soft 15m floor and hard 2h cap (W8).

### 2.4 Resource conflicts

`hasResourceConflict` (`resources.ts`) enforces shared-cwd **writePaths / git mutex** among open mutating tasks. Release/promote paths consult this; pure create still records claims for later promotion.

### 2.5 Outcome authority

- **User** can always seal lifecycle (host UI).
- **Coordinator** may seal owned children via `set_task_lifecycle` / `cancel_task` when root policy allows (`mayParentSealDirect` + `childOrchestrationSeal`).
- Root policy **`propose_only`** rejects parent seal with a stable error string.
- Worker `complete_task` / `fail_task` only stage turn disposition; lifecycle remains open / awaiting outcome until user or authorized parent seals.
- Docs (`TASK-MANAGEMENT.md`): “Who seals lifecycle — User always; coordinator when outcome authority mode allows — never the CLI.”

### 2.6 Child model selection

- Spec may pass optional ACP `model`; omitted → agent default for backend.
- Registry resolution can supply model from task type.
- Smoke path: `scripts/smoke-child-model-opencode.mjs` + bridge fixture exercise child model on OpenCode (manual/smoke, not unit suite).
- Child model is persisted on the task row and projected in host snapshot (`task.model`).

### 2.7 Child transcript / navigation (webview)

- Focused task workspace shows a **Subtree** badge strip when `tasks.subtree.length > 1` (`TaskWorkspace.svelte`).
- Selecting a node uses the same `selectTask` path as the main list — full transcript swap, not an embedded child pane.
- No dedicated “return to parent” control beyond task list / subtree badges; no side-by-side parent+child transcripts.

### 2.8 Cancel vs interrupt semantics (confirmed)

| Action | Subtree | Live remote lease | Live local lease | Task lifecycle |
|--------|---------|-------------------|------------------|----------------|
| `interrupt_task` | No cascade | Write interrupt request | Abort + `interruptTurn` + hold queued follow-ups | Unchanged |
| `cancel_task` | Cascade descendants (post-order) | Cancel request with coordinator seal metadata | Abort + `transitionCancelTask` | Terminal `cancelled` when seal applies |
| `set_task_lifecycle` cancelled/skipped | Cascade descendants | Deferred cancel/interrupt requests | Local seal + cleanup | Terminal as requested |
| `set_task_lifecycle` succeeded/failed | Target only | Interrupt request if remote live | Cleanup live | Terminal on target |

### 2.9 Progress

`report_progress` is intentionally shallow today: truncated note echoed in the tool result. **No persistence, no event stream, no webview field.** Handoff progress is a separate surface (`TaskSummary.handoffProgress`) and must not be confused with worker progress notes.

---

## 3. Test coverage map (current)

### 3.1 Present (evidence)

| Area | Where | What is covered |
|------|-------|-----------------|
| Limit math / clamp / TTL | `src/task/limits.test.ts` | Depth, children per task/root, turns (incl. queued), result/error size, execution policy clamp, bridge token TTL floors/caps |
| Create / delegate graph | `src/task/engine-graph.test.ts` | create_task via credential; draft vs released; depth/children limits; workspace trust; task type resolution; cancel paths; set_task_lifecycle seals; resource conflict at promote; zero children / invalid type |
| Coordinator arg mapping | `src/task/coordinator-tools.test.ts` | Schema mapping for create/delegate (incl. rich fields); rejects public create without taskType; get_host_context / list_task_types shape |
| Transitions | `src/task/transitions.test.ts` | User/coordinator seal, reopen, interrupt live turn, cancel task+turn, outcome proposal clear on seal |
| Capabilities | `src/task/capabilities.test.ts` | Coordinator action grants; `start_task` not granted from `start_child` alone |
| Resource mutex | `src/task/resources.test.ts` | writePaths / git conflict detection |
| Child model smoke | `scripts/smoke-child-model-opencode.mjs` | Live OpenCode child model (environment-dependent) |

### 3.2 Gaps (production risk)

| Gap | Why it matters | Severity |
|-----|----------------|----------|
| **No single vertical unit that drives `delegate_task` end-to-end** through create → schedule hook → child turn row → parent `wait_for_tasks` settle | Regressions can pass isolated unit tests and still break the coordinator loop | **High** |
| **`wait_for_tasks` thin engine coverage** (~2 references in graph tests) | Wake/suspend and non-owned taskIds are under-proved | **High** |
| **`report_progress` has zero persistence tests** (behavior is no-op) | Coordinators/workers believe progress is stored; operators see nothing | **High** (product honesty) |
| **Interrupt vs cancel matrix incomplete at engine layer** | Shared case arm is easy to break when editing cancel cascade | **Medium** |
| **Model resolution matrix incomplete** (registry default vs explicit override vs invalid model) | Wrong model silently runs expensive backends | **Medium** |
| **Child transcript navigation has no Playwright contract** | Subtree badges can regress without failing unit tests | **Medium** |
| **Outcome `propose_only` vs parent_seal modes** partially covered | Mis-sealing children under propose_only is a trust bug | **High** |
| **Concurrent fan-out at `maxConcurrentPerRoot` / backend** | 10× child spawn can stall without clear tool errors | **Medium** |
| **Idempotent re-`delegate_task` / op ledger collision** lightly covered | Double-submit from flaky bridges may create ghosts | **Medium** |
| **No automated proof that Playwright ≠ host** for delegate flows | Same class of error fixed for file-mention in M011 | **Low** (process) |

---

## 4. Production capability gaps

### 4.1 Required hardening (ship before treating delegate as production-complete)

1. **Progress authority**
   - Persist last N progress notes (or single latest + timestamp) on the task row **or** as structured messages.
   - Project into host snapshot + webview (sanitized, size-capped).
   - Keep tool ack; make store write the source of truth.

2. **Child lifecycle settlement loop**
   - Documented, tested path: `delegate_task` → child runs → parent `wait_for_tasks` → wakeOn attention → parent reads status → `set_task_lifecycle` / user seal.
   - Explicit failure modes when children are cancelled mid-wait or never start.

3. **Cancel / interrupt contract freeze**
   - Table-driven tests for local vs remote lease, cascade vs non-cascade, queued follow-up hold, rescan after cancel.
   - Stable tool result shapes (`cancelled`, `interrupted`, `requested`, `noop`).

4. **Outcome authority modes**
   - Enumerate root `childOrchestrationSeal` modes and UI copy.
   - Prove `propose_only` cannot parent-seal; prove allowed mode can seal succeeded/failed/cancelled/skipped.
   - Clarify relationship between worker turn complete and task terminal state (still user/parent seal).

5. **Model selection clarity**
   - Tool result always returns resolved `{ backend, model?, role, briefKind, taskType }`.
   - Reject unknown model ids where the backend can validate; otherwise surface “agent default” explicitly in UI.

6. **Child transcript navigation**
   - Minimum: subtree strip + parent breadcrumb + keyboard-accessible select.
   - Proof: Playwright focuses child, sees child messages only, returns to parent without losing composer draft rules already established for task focus.

7. **Limit observability**
   - When depth/children/turns/concurrency reject, return **structured codes** (not only free-text reason) so coordinators can adapt.
   - Surface near-limit warnings in diagnostics (optional but recommended).

8. **Security / trust**
   - Keep workspace trust gate on release/delegate.
   - Keep executionPolicy clamp and result/error byte caps.
   - Keep writePaths/git mutex at promote.
   - Never allow coordinator to widen capabilities beyond role defaults without an explicit future product decision.

### 4.2 Optional autonomy / “yolo” expansion (explicitly out of required hardening)

- Auto-approve all child tool permissions.
- Auto-seal succeeded children without parent or user review.
- Unbounded recursive coordinator children (raising `maxDepth` / removing caps).
- Cross-workspace cwd override from agent input.
- Silent git force / unscoped writePaths.
- Multi-root orchestration without user-created roots.

These items must not land as silent defaults under “hardening.”

---

## 5. Proposed vertical slices (future milestone)

Order is dependency-aware; each slice is independently demoable.

### S-A — Progress persistence and projection

**Goal:** `report_progress` becomes an observable task fact.  
**Demo:** Worker reports progress; refresh/reload shows last note on the focused task.  
**Proof:** unit (store write + size cap) + snapshot projection + webview render.  
**Depends:** none.

### S-B — Delegate happy-path integration suite

**Goal:** One scripted TaskEngine suite (temp store, fake backend) covering `delegate_task` → scheduled turn → child complete disposition → parent `wait_for_tasks` wake → parent seal.  
**Demo:** Test file name greppable; fails if schedule hook or wait settle regresses.  
**Proof:** contract/unit only (no VS Code).  
**Depends:** none (can parallel S-A).

### S-C — Cancel / interrupt / remote-lease matrix

**Goal:** Table-driven engine tests for all cells in §2.8.  
**Demo:** Matrix test titles list lease × action × cascade.  
**Proof:** unit.  
**Depends:** S-B fixtures reusable.

### S-D — Outcome authority + propose_only

**Goal:** Root seal policy modes tested and documented with UI affordances.  
**Demo:** propose_only rejects parent seal; allowed mode seals child succeeded with result.  
**Proof:** unit + webview copy snapshot if UI changes.  
**Depends:** S-B.

### S-E — Model resolution matrix

**Goal:** Registry default, explicit override, invalid type, unsupported backend — all structured errors.  
**Demo:** coordinator-tools + engine-graph cases; optional smoke remains environment-gated.  
**Proof:** unit; smoke classified ENVIRONMENT BLOCKED when host missing.  
**Depends:** none.

### S-F — Child transcript navigation UX

**Goal:** Parent breadcrumb + subtree focus preserves composer/live-input contracts.  
**Demo:** Playwright selects child from subtree, asserts transcript isolation, returns to parent.  
**Proof:** browser; native host separate ledger if UI is host-visible.  
**Depends:** none for minimal; richer UX after S-A if progress shown on child.

### S-G — Structured limit errors + concurrency pressure

**Goal:** Depth/children/turns/concurrency return stable codes; concurrent fan-out under caps.  
**Demo:** Spawn to cap+1; tool error code asserted.  
**Proof:** unit + optional load harness.  
**Depends:** S-B.

### S-H — Docs + evidence ledger

**Goal:** TASK-MANAGEMENT / CONTRIBUTING / WEBVIEW describe the frozen contracts; optional live-host ledger with PASS|FAIL|ENVIRONMENT BLOCKED (same honesty pattern as M011 file-mention).  
**Depends:** S-A–S-G as implemented.

---

## 6. Acceptance criteria (required hardening milestone)

A future milestone is **done** when:

1. **Delegate loop:** Automated engine test proves create-and-run, wait, and seal without VS Code.
2. **Progress:** At least one progress note survives reload and appears in UI/snapshot.
3. **Cancel ≠ interrupt:** Matrix tests green; docs match code.
4. **Outcome authority:** propose_only and parent_seal modes both proved; user seal still works when coordinator cannot.
5. **Model:** Resolved model visible on child task summary; invalid type/backend fail closed with codes.
6. **Navigation:** User (or Playwright) can open a child transcript from the parent workspace and return.
7. **Limits:** Exceeding depth/children/turns yields structured, greppable errors; defaults unchanged unless product explicitly revises them.
8. **Security:** Trust gate, policy clamp, byte caps, and writePaths/git mutex remain enforced; no yolo defaults.
9. **Proof boundary:** Browser proof is not labeled native host proof; host scenarios use PASS|FAIL|ENVIRONMENT BLOCKED.

---

## 7. Proof classes

| Class | Use for |
|-------|---------|
| **Contract / unit** | Engine graph, limits, transitions, coordinator-tools schema, resources mutex |
| **Integration (in-process)** | Temp TaskStore + scripted Backend generators (existing pattern MEM028) for full delegate loop |
| **Browser (Playwright)** | Child transcript navigation, subtree focus, composer live-input preservation |
| **Smoke / manual host** | Real OpenCode/Claude child model (`smoke-child-model-opencode.mjs`); Extension Development Host cancel/wait UX |
| **Native host ledger** | Optional UAT file with PASS\|FAIL\|ENVIRONMENT BLOCKED — never filled from Playwright alone |

---

## 8. Recommended sequencing

```text
S-B (delegate loop tests) ──┬── S-C (cancel/interrupt)
                            ├── S-D (outcome authority)
                            └── S-G (structured limits)
S-A (progress) ─────────────── can parallel S-B
S-E (model matrix) ─────────── can parallel S-B
S-F (transcript nav) ───────── after or parallel S-A if showing progress
S-H (docs + ledger) ────────── last
```

**First executable slice:** **S-B** — pure tests, no product risk, immediately raises confidence for every later change.

**Do not start with:** raising limits, auto-seal, or permission yolo.

---

## 9. Failure modes to design for (implementation checklist)

| Dependency | Failure | Expected handling |
|------------|---------|-------------------|
| Workspace trust API | Untrusted | `workspace_untrusted`, no release/delegate |
| Task type registry | Missing/invalid type | Fail closed before store write |
| Backend factory | Unknown / non-MCP | `backend_unsupported` / `backend_not_mcp` |
| Store commit | Caller not open / id collision | Reasoned error; ledger idempotency on retry |
| Scheduler | `onScheduleTurn` not wired | Child released but never runs — must be tested |
| Child backend hang | Turn timeout | Policy timeout + parent wait does not seal success |
| Remote lease owner dead | Cancel/interrupt request orphan | Lease recovery path (existing) must re-scan |
| Progress flood | Huge/rapid notes | Truncate 512+; cap stored history; drop oldest |
| Concurrent children | Cap hit | Structured reject; no partial graph corruption |

---

## 10. Load profile (10×)

Assume a coordinator that today fans out ~3–5 children:

| Resource | 10× pressure | First breakpoint | Protection already present | Hardening needed |
|----------|--------------|------------------|----------------------------|------------------|
| Children per task | ~50 | `maxChildrenPerTask` (32) | Hard reject | Structured code + coordinator guidance |
| Tree depth | deep recursion | `maxDepth` (8) | Hard reject | Same |
| Concurrent turns | many live backends | `maxConcurrentTurns` / per-root / per-backend | Scheduler caps | Prove queueing vs error at tool layer |
| Progress notes | chatty workers | Memory/UI spam | Ack truncates only | Persist with ring buffer |
| Result payloads | large complete_task | `maxResultBytes` | Reject oversized | Keep |

---

## 11. Negative tests to add (minimum set)

1. `delegate_task` when workspace untrusted.
2. `delegate_task` with unknown taskType / unsupported backend.
3. Depth at `maxDepth - 1` succeeds; next fails.
4. Children at cap+1 fails without creating partial rows.
5. `wait_for_tasks` with non-owned or non-direct child ids.
6. `set_task_lifecycle` under `propose_only`.
7. `set_task_lifecycle` self-seal rejected.
8. `interrupt_task` does not cancel sibling/descendant tasks.
9. `cancel_task` cancels descendants and rescans.
10. `report_progress` oversize note truncated; after S-A, persisted form size-capped.
11. Double `delegate_task` same opId is idempotent (ledger).
12. `complete_task` result over `maxResultBytes` rejected.

---

## 12. Observability surfaces (current vs target)

| Surface | Current | Target after hardening |
|---------|---------|------------------------|
| Tool result | create/delegate returns taskId/turnId/resolved | Keep + structured error codes |
| Op ledger | Writes on graph ops | Keep; assert in tests |
| Progress | None | Task field or messages + snapshot |
| Diagnostics | Limits as free-text reasons | Codes + optional metrics counters |
| Webview | Subtree badges, lifecycle chips | + progress line; + parent breadcrumb |

---

## 13. Explicit exclusions (do not sneak into hardening)

- Auto-yolo tool permissions for children.
- Removing depth/children/concurrency caps.
- Agent-chosen arbitrary cwd outside parent inheritance without a separate security review.
- Treating smoke or Playwright as Extension Development Host PASS.
- Changing export rules to include child tasks inside parent export (M009 contract: children excluded).

---

## 14. References

| Path | Why |
|------|-----|
| `src/task/engine-graph.ts` | create/delegate/wait/lifecycle/cancel/interrupt/progress handlers |
| `src/task/limits.ts` | Resource + execution policy bounds |
| `src/task/resources.ts` | writePaths/git conflict |
| `src/task/coordinator-tools.ts` | MCP arg mapping |
| `src/task/transitions.ts` | Lifecycle/turn transitions + outcomeProposal clearing |
| `docs/TASK-MANAGEMENT.md` | Product contract (tools table, outcome authority, Phase C history) |
| `docs/plans/task-orchestration-auto-run.md` | Prior orchestration plan style / W5–W8 safety gates |
| `scripts/smoke-child-model-opencode.mjs` | Environment-gated child model smoke |

---

## 15. M011 boundary statement

M011 S04 T03 **only** adds this plan file. It does **not**:

- modify `engine-graph.ts` or coordinator tools,
- change defaults in `limits.ts`,
- add or alter tests beyond documentation,
- claim delegate-task production readiness.

Follow-up work starts by filing a milestone that consumes **S-B** first, then S-A/S-C/S-D as capacity allows.
