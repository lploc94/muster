# Plan: Coordinator host context + parent seal MCP + queue UX

## Status
**DRAFT** — ready for plan-review / implementation after compact.

Depends on: Phase F orchestration (W1–W9) landed on `main` (`docs/plans/task-orchestration-auto-run.md`).

Live evidence motivating this plan (2026-07-14 Grok + opencode child):

- Root first turn = user message only; no backends/models/MCP playbook in prompt.
- Child `turn.settle.ok` with `disposition: null`, `lifecycle: open` (missing `complete_task`).
- Parent `wait_for_tasks` → queued continuation `#2` with **no user message** → UI `(empty queued message)`.
- No MCP for **parent** to seal child success/fail (only auto-seal when child stages disposition, plus `cancel_task`).

---

## Goals

1. **Host context** — root/coordinator first turn (and optionally on demand) knows: available CLIs, sample models, workspace, trust, tool surface, orchestration rules.
2. **Parent seal MCP** — coordinator can set direct-child lifecycle (`succeeded` / `failed` / …) with `sealedBy.coordinator`, matching product rule: **user | coordinator** seal; workers stage only.
3. **Queue UX** — engine/wait continuations never look like empty user messages.
4. Keep architecture: records + pure transitions + `TaskEngine`; no OOP task entities.

## Non-goals

- Full `coordinator_delegate` / yolo mode for **root** self-seal (separate product switch; only child parent-seal in this plan).
- Auto-map `brief.kind` → backend (plan→codex); optional later.
- Fix model-picker remount spam (track as follow-up bug; not enablement-blocking).
- Strong sandbox / worktrees.

---

## Product contract (normative)

### Host context

| Topic | Decision |
|-------|----------|
| When | Inject on **root first turn** (user `startNewTask` / first `send` on root with `sequence === 1`) as **prefix** of agent prompt (or frozen `compiledPrompt` on that turn only). |
| Also | Optional read-only MCP `get_host_context` for re-fetch mid-session (same payload shape). |
| Source | Host already has: `detectAvailableBackends()`, model catalog cache (`enumerateModels`), `cwd`, trust, capability map. |
| Trust framing | Host block is **trusted system context** (not untrusted predecessor pins). |
| Workers | Same optional thin context (cwd + available backends) optional; **rich playbook only for coordinator role**. |

Payload sketch (v1):

```ts
{
  version: 1;
  workspace: { cwd: string; trusted: boolean };
  availableBackends: string[];  // PATH-detectable only
  models: Record<string, { current?: string; options: { value: string; name: string }[] }>;
  // Cap options per backend (e.g. 12) to bound prompt size
  self: { taskId: string; role: TaskRole; backend: string; model?: string };
  tools: string[];  // allowed coordinator tool names for this turn credential
  rules: string[];  // short bullets: draft→release, no start_task, seal policy, …
}
```

Rendered as markdown section `# Muster host context` before user objective.

### Parent seal MCP

| Topic | Decision |
|-------|----------|
| Tool name | `set_task_lifecycle` (preferred) or `seal_task` |
| Caller | Coordinator only (`create_child` or new cap `seal_child` — prefer **reuse `create_child` or `cancel_child` family**; recommend **`cancel_child` → expand to lifecycle mutations** OR map under `create_child` + explicit allowlist). **v1 map:** `create_child` gains `set_task_lifecycle` (same ownership domain as graph). |
| Args | `{ opId, taskId, lifecycle: 'succeeded'\|'failed'\|'cancelled'\|'skipped', result?, error? }` |
| Scope | **Direct children** of caller only (v1). Descendants optional later. |
| Effect | Same as host `setTaskLifecycle` / cancel paths: persist lifecycle, `sealedBy: { kind:'coordinator', taskId: caller, turnId, mode: 'parent_seal' }`, settle queued turns on target, **rescan** dependents. |
| Idempotency | Op ledger like other mutators. |
| Workers | Never granted. |
| Root self-seal | **Out of scope** unless mode is `coordinator_delegate` (future). |

### Wait / queue UX

| Topic | Decision |
|-------|----------|
| `previewText` for queued turns | If inputs are only `child_results` / recovery: host sets `previewText` e.g. `Continuation after wait` / `Recovery turn` — never omit so UI falls back to `(empty queued message)`. |
| User empty Enter | Keep rejecting empty send at host (already); do not create empty message turns. |

---

## Workstreams

### W1 — Host context builder + root first-turn inject

**Files:** new `src/task/host-context.ts` (pure format), `engine.ts` (inject path), `extension.ts` (pass backends/models/trust into `TaskEngineConfig`), tests.

- Add `TaskEngineConfig`:
  - `getHostEnvironment?: () => HostEnvironmentSnapshot` (sync or cached from extension).
- Extension wires: available backends + models cache + `isTrusted` + workspace cwd.
- On root first user turn promote/dispatch (or at `startNewTask` message compose): if coordinator role, prefix `formatHostContextMarkdown(snapshot)`.
- Unit tests: formatter; engine test that first root prompt contains `availableBackends` / rules.

**AC**

- [ ] New root coordinator turn prompt includes host context section with backends list (from snapshot).
- [ ] Worker-only first turns do not get full coordinator playbook (or get thin cwd-only — pick one; **recommend thin cwd for workers**).
- [ ] Snapshot missing → inject minimal `{ cwd, trusted, rules }` without failing turn.

### W2 — MCP `get_host_context` (optional but small)

**Files:** `capabilities.ts`, `coordinator-tools.ts`, `bridge/server.ts`, `engine-graph.ts`.

- Non-mutating tool; returns JSON same shape as inject payload.
- Coordinator + optionally any task.

**AC**

- [ ] `tools/list` shows tool when allowed; dispatch returns snapshot.

### W3 — MCP `set_task_lifecycle` parent seal

**Files:** capabilities, coordinator-tools, bridge schema, engine-graph (ownership + seal), transitions reuse `setTaskLifecycle` / `cancelTask` with `TaskSealedBy`, rescan, tests, `TASK-MANAGEMENT.md` §8.

**AC**

- [ ] Coordinator seals direct child `succeeded` with result → child terminal + `sealedBy.coordinator` + dependents unblocked.
- [ ] Coordinator seals `failed` with error.
- [ ] Reject: non-child, worker caller, terminal already (idempotent or clear error).
- [ ] After seal, `rescanSchedulableTurns` / wait resolution can proceed (no stuck wait solely because child never called `complete_task`).
- [ ] User can still override via UI.

### W4 — Queued turn preview for non-message inputs

**Files:** `src/host/snapshot.ts` `previewTextForQueuedTurn`, webview fallback copy optional, tests in `snapshot.test.ts`.

**AC**

- [ ] Wait continuation shows non-empty preview (not `(empty queued message)`).
- [ ] Real empty user message still shows empty/placeholder only if that path exists (should be rare).

### W5 — Docs + regression matrix

- Update `docs/TASK-MANAGEMENT.md` §8 tool table + §5.3 parent seal.
- Link plan from `docs/README.md`.
- Manual smoke: Grok root + opencode child + parent `set_task_lifecycle` succeeded without child `complete_task`.

---

## Implementation order

```text
W4 queue preview          } fast UX win, independent
W1 host context inject    } needs extension wiring
W2 get_host_context       } thin after W1
W3 set_task_lifecycle     } core product gap
W5 docs + smoke
```

---

## Test matrix

| Case | Expect |
|------|--------|
| Root start prompt | Contains host context backends + rules |
| `get_host_context` | JSON matches inject sources |
| Parent seal success | Child succeeded, sealedBy coordinator, wait can complete |
| Parent seal non-child | Rejected |
| Wait continuation queue | Preview not empty |
| Child still can complete_task | Auto-seal path unchanged |
| Empty user send | Still rejected / no empty turn |

```bash
npm test -- src/task/ src/host/snapshot.test.ts
npm run smoke:child-model-opencode   # existing
# new: optional smoke parent-seal after W3
```

---

## Open questions (resolve in plan-review if needed)

1. Capability bucket for `set_task_lifecycle`: under `create_child` vs new `seal_child` vs extend `cancel_child`.
2. Whether parent may seal **any** descendant or only **direct** children (plan default: **direct**).
3. Inject on **every** root turn vs **first only** (plan default: **first only** + MCP refresh).

---

## References

- Phase F plan: `docs/plans/task-orchestration-auto-run.md`
- Domain: `docs/TASK-MANAGEMENT.md` §4.1.1, §5.3, §8
- Live gap: child disposition null + empty queue `#2` (2026-07-14 session)
- Code: `src/task/engine.ts`, `engine-graph.ts`, `capabilities.ts`, `coordinator-tools.ts`, `host/snapshot.ts`, `host/backend-availability.ts`, `backends/model-catalog.ts`, `extension.ts`
