# Plan: User-defined task types (type → backend/model presets)

## Status
**IMPLEMENTED** — W1–W6 on main (pure registry → host config → MCP → engine-graph → first-turn → docs/smoke).

Depends on: Phase F orchestration + host-context/parent-seal (W0–W6) on `main`.

## Problem

Today MCP `create_task` / `delegate_task` **require `backend`** (optional `model`). Coordinators must invent CLI + model ids. User intent is different:

> Define task types once (plan → codex/gpt-5.5, implement → grok-4.5, verify → …).  
> Coordinator creates by **type** in a runbook; only pass model/backend when the **user** named an override.

Raw “available backends/models” is **not** the primary agent path (catalog noise; agent should not “pick” models). Keep `get_host_context` for optional refresh; task types become the coordinator surface.

## Goals

1. **Registry SoT** — user/workspace-defined `taskType` → `{ backend, model?, role?, briefKind?, description? }`.
2. **Create by type** — MCP create/delegate require `taskType`; resolve to concrete backend/model before persist.
3. **Overrides** — explicit `backend`/`model` only when user named them; strict precedence (see §Resolution).
4. **Discoverability** — `list_task_types` (coordinator, read-only) + first-turn host section when types configured.
5. **Fail-closed** — unknown type / malformed config / missing registry → structured error, **zero** store mutations.
6. Architecture: pure resolve helpers + engine-graph wiring; transitions stay registry-agnostic.

## Non-goals

- Graph/runbook DSL or batch `create_task_graph`.
- Infer `taskType` from goal / `brief.kind` / legacy tasks.
- Retroactive rebinding of drafts when config changes.
- Worker create authority; yolo root self-seal.
- ACP system prompt; adapter-specific rules files.
- Separate “trust backend” product (workspace trust + MCP capability gates remain).
- Arbitrary preset templates (paths, caps, git claims, executionPolicy) in v1.
- Primary path = available-backends/models MCP (diagnostic only).

---

## Product contract (normative)

### Configuration SoT

| Topic | Decision |
|-------|----------|
| Store | VS Code contributed setting **`muster.taskTypes`** (object map), **resource-scoped** (workspace + multi-root folder) |
| Read | `vscode.workspace.getConfiguration('muster', Uri.file(callerCwd))` so folder settings follow task cwd inheritance |
| Shape | See below; unknown keys fail-closed at parse |
| Not SoT | Task store (only resolved fields + optional provenance id); free-form agent write |

```json
{
  "muster.taskTypes": {
    "plan": {
      "description": "Produce an actionable implementation plan",
      "backend": "codex",
      "model": "gpt-5.5",
      "role": "worker",
      "briefKind": "plan"
    },
    "implement": {
      "backend": "grok",
      "model": "grok-4.5",
      "briefKind": "implement"
    },
    "verify": {
      "backend": "codex",
      "briefKind": "verify"
    },
    "coordinate": {
      "backend": "grok",
      "model": "grok-4.5",
      "role": "coordinator",
      "briefKind": "coordinate"
    }
  }
}
```

**Per entry**

| Field | Required | Notes |
|-------|----------|--------|
| `backend` | yes | ACP backend id |
| `model` | no | ACP model id; omit → agent default for that backend |
| `role` | no | default `worker` |
| `briefKind` | no | maps to `TaskBriefKind`; default `generic` |
| `description` | no | selection help for coordinator (bounded length) |

Limits (implement):

| Limit | Value | Notes |
|-------|-------|--------|
| Max types | **32** | Hard cap |
| Type id | `^[a-z][a-z0-9_-]{0,63}$` | Fail-closed |
| Description | ≤ **200** chars (not BRIEF_SECTION_MAX) | Host-block budget; long descriptions drop first |
| Model/backend strings | ≤ 200 | Clamp/reject oversize |

### Axes: `taskType` vs `brief.kind`

| Axis | Meaning |
|------|---------|
| `taskType` | **Routing / policy** — which backend+model (and optional role) to use |
| `brief.kind` | **Prompt preamble** only (`KIND_PREAMBLES`) |

Multiple types may share one `briefKind` (e.g. `implement-fast` / `implement-careful` both `implement`).

### MCP create/delegate (v1 public contract)

```ts
// CreateChildSpec (agent-facing)
{
  goal: string;           // required
  taskType: string;       // required
  backend?: string;       // override only if user named backend
  model?: string;         // override only if user named model
  role?: TaskRole;
  // existing rich fields unchanged:
  description?, brief?, dependencies?, executionPolicy?,
  inputBindings?, claimsGit?, writePaths?, readPaths?
}
```

**Schema required:** `opId`, `goal`, `taskType`.  
**Backend is NOT required** on the public schema.  
Do **not** enum live type ids in JSON Schema (registry changes independently of tool list).

**Parser:** reject public backend-only creates (no `taskType`).  
Optional **internal** legacy adapter only if a concrete external caller needs it — never advertised in `tools/list`.

### Resolution (create/delegate, before `makeBackend` + store commit)

```text
1. Load TaskTypeRegistryResult for caller.cwd (or workspace root fallback)
   → { status, registry, diagnostics }
2. If status === 'invalid' → error invalid_task_type_config (zero mutations)
3. If status === 'empty' / registry empty → error task_types_not_configured
4. Look up taskType → unknown → error unknown_task_type (even if backend override present)
5. backend = explicit.backend ?? preset.backend
6. model  = explicit.model
          ?? (backend === preset.backend ? preset.model : undefined)
   // changing backend without explicit model drops preset model (no Codex id on Grok)
7. role    = explicit.role ?? preset.role ?? 'worker'
8. brief.kind default for merge = explicit.brief?.kind ?? preset.briefKind ?? 'generic'
9. Validate backend id is a known factory id (see §Backend construction) → else backend_unsupported
10. makeBackend(resolved.backend) under try/catch → map throw to structured error (never leak exception to MCP)
11. canBindTaskToBackend → else backend_not_mcp
12. mergeBriefFromCreate(goal, description, brief overlay…)
13. Persist MusterTask: backend, model?, role, brief, taskType (provenance)
14. Return { taskId, taskType, resolved: { backend, model?, role, briefKind } }
```

**Release** uses already-persisted fields — **never** re-resolve registry (config edit must not retarget drafts).

### Backend construction (normative — ISSUE-3)

Today `makeBackend(name)` **throws** for unknown backend ids before MCP eligibility. Plan must not rely on throw-as-success-path:

| Step | Behavior |
|------|----------|
| Known ids | Use existing factory allowlist (claude/codex/grok/kiro/opencode/…) |
| Unknown id | Structured error `backend_unsupported` **before** store commit |
| Known but no MCP | Existing `backend_not_mcp` / “backend does not support MCP” |
| Throw safety | Wrap `makeBackend` in try/catch at create/delegate; map to `backend_unsupported` |

Tests: typo preset `backend: "codx"` → structured error, zero child rows.

### New tool: `list_task_types`

| Topic | Decision |
|-------|----------|
| Cap | `create_child` (coordinator only; same bucket as create) |
| Mutating | no |
| opId | **no** (read-only path like `get_host_context`) |
| Args | empty object |
| Response | `{ taskTypes: [...], diagnostics: [] }` — id, description, backend, model?, defaultRole, defaultBriefKind, availability (`available` \| `unavailable` \| `unknown`) |
| Not included | full model zoo / alternative catalogs |

### First-turn host context (coordinator) — budget-aware (ISSUE-4)

When valid types exist:

- Render compact **`## Task types`** (id, default role, briefKind; description optional).
- Rules (exact strings unit-tested; **must all survive** host rule cap):
  1. Prefer `taskType` from the list when creating children.
  2. Omit backend/model to use the type preset.
  3. Pass backend/model **only** when the current user explicitly named that override.
  4. Never invent types or silently fall back to parent backend.
- If no types configured: state that clearly; ask user to configure `muster.taskTypes` (do not invent backends).

**Budget priority inside host block (high → low protect):**

1. Workspace + self + **all 4 task-type rules** (never drop rules for types).
2. Task type **ids** + role + briefKind for every registered type (≤32).
3. Type descriptions (drop first under HOST_BLOCK_MAX).
4. Raw backends/models catalog (omit entirely when types present — diagnostic only via `get_host_context`).
5. Other optional coordinator catalog noise.

**Rule slots:** Host rules max is 12 today; base+coordinator playbook already near full. Implementation **must** either (a) replace 4 lower-priority coordinator playbook bullets with the 4 task-type rules when types configured, or (b) raise HOST_RULES_MAX for coordinator and unit-test exact survival of all 4 type rules. Prefer **(a)** to avoid bloating.

When types configured: **do not** lead with raw available-backends/models catalog as primary playbook.

### `get_host_context`

- Keep tool.
- Extend JSON with `taskTypes` summary (same builder as inject).
- Description: refresh host env **and** task-type registry.
- `list_task_types` always reads **live** registry; first-turn block remains freeze-time snapshot.

### Errors (structured, bounded message)

| Code | When |
|------|------|
| `task_types_not_configured` | empty/missing registry (`status === 'empty'`) |
| `invalid_task_type_config` | parse failed / malformed setting (`status === 'invalid'`) — **distinct** from empty |
| `unknown_task_type` | id not in a valid registry |
| `backend_unsupported` | resolved backend id not in factory allowlist / makeBackend would throw |
| `backend_not_mcp` | known backend but not MCP-capable |
| `backend_unavailable` | soft diagnostic on list only (PATH detect); create still uses factory + MCP checks |

Unknown type + explicit backend → still **fail** (no escape hatch).  
Empty vs invalid must not be collapsed (ISSUE-2).

### Legacy tasks

- `MusterTask.taskType?: string` optional; absent on old tasks.
- **No** migration that infers type from kind/backend/model.

### Root composer

Out of scope for this slice (optional later: map root role/kind to a type). MCP child path only.

---

## Architecture

```text
VS Code muster.taskTypes (resource)
        │
        ▼
  parseTaskTypeRegistry (pure) → TaskTypeRegistryResult
        { status: 'ok'|'empty'|'invalid', registry, diagnostics[] }
        │
        ▼
  resolveCreateChildSpec(spec, result) → ok Resolved | err code
        │
        ▼
  engine-graph create/delegate
        ├── validate backend id / safe makeBackend (structured errors)
        ├── mergeBriefFromCreate(…, defaultKind)
        └── createTask(CreateTaskInput)  // backend required here
```

```ts
// Hook shape (normative — ISSUE-2)
type TaskTypeRegistryResult = {
  status: 'ok' | 'empty' | 'invalid';
  registry: ReadonlyMap<string, TaskTypeDefinition>; // empty if empty|invalid
  diagnostics: readonly { code: string; message: string }[]; // bounded
};

// GraphEngineDeps / TaskEngineConfig
getTaskTypeRegistry?: (cwd?: string) => TaskTypeRegistryResult;
```

| Layer | Responsibility |
|-------|----------------|
| Pure `task-types.ts` | parse, validate, resolve, limits, error codes |
| Extension | read VS Code config → **full** `TaskTypeRegistryResult` (never drop invalid→empty silently) |
| coordinator-tools / bridge | schema + parse `taskType`; `list_task_types` returns diagnostics |
| engine-graph | resolve before mutate; safe backend construct; persist provenance |
| host-context / brief | budgeted task-type section + protected rules; merge defaultKind |
| transitions | unchanged (receive concrete backend) |

---

## Workstreams

### W1 — Pure registry + resolver

**Files:** `src/task/task-types.ts` (new), tests.

- Types, `parseTaskTypeRegistry` → `TaskTypeRegistryResult`, diagnostics, `resolveCreateChildSpec`, override matrix, limits.
- Unit tests: empty, invalid, unknown, backend change drops model, explicit model wins, role/kind defaults.

**AC**

- [ ] Pure only; no VS Code imports.
- [ ] `status: 'empty'` vs `'invalid'` distinct.
- [ ] Unknown type fails with code; no partial resolve.
- [ ] Backend change without model → `model` undefined.

### W2 — Host configuration wire

**Files:** `package.json` contributes.configuration, `src/host/task-types-config.ts`, `TaskEngineConfig` / `GraphEngineDeps` hook:

`getTaskTypeRegistry?: (cwd?: string) => TaskTypeRegistryResult`

- Resource-scoped `muster.taskTypes`.
- cwd-aware read; malformed → `status: 'invalid'` + diagnostics (**not** silently empty).

**AC**

- [ ] Workspace setting round-trip readable from tests with mock/config fixture.
- [ ] Malformed setting → invalid status, diagnostics non-empty.
- [ ] Multi-root: different cwd can see different effective maps (test if fixtureable).

### W3 — MCP contract

**Files:** capabilities (`list_task_types` under **create_child**), coordinator-tools, bridge schemas/descriptions, tests.

- create/delegate: require `taskType`; backend optional.
- `list_task_types` no opId, no ledger; returns types + diagnostics from live registry result.
- Workers: no list, no create.

**AC**

- [ ] tools/list coordinator with create_child shows `list_task_types` + create requires taskType in schema.
- [ ] Public dispatch without taskType fails.
- [ ] Worker cannot list/create.
- [ ] list_task_types surfaces invalid diagnostics when config malformed.

### W4 — Engine-graph integration

**Files:** `engine-graph.ts`, types `MusterTask.taskType?`, backend factory guard, tests.

- Resolve before backend construct + commit.
- **Safe backend construction** (allowlist and/or try/catch → `backend_unsupported`).
- Persist `taskType` + resolved fields.
- Op ledger stores resolved result; replay ignores later config change.
- Zero mutations on unknown / invalid / unsupported backend.

**AC**

- [ ] create_task taskType=plan → child.backend/model from registry.
- [ ] Config change after draft does not change draft on release.
- [ ] Unknown type: no child row.
- [ ] Malformed registry: `invalid_task_type_config`, no child row.
- [ ] Typo backend id: `backend_unsupported`, no child row.
- [ ] Explicit backend override + same model rules.

### W5 — First-turn host + get_host_context

**Files:** `host-context.ts`, `brief.ts` (`defaultKind` into merge), engine assemble inputs, tests.

- Coordinator host markdown: budgeted Task types section + **all 4** type rules protected.
- Suppress primary backends/models catalog when types present.
- get_host_context includes taskTypes (+ diagnostics if useful).

**AC**

- [ ] Coordinator first prompt contains `## Task types` when configured.
- [ ] Max 32-type registry still retains all type **ids** under HOST_BLOCK_MAX (descriptions may drop).
- [ ] All 4 exact task-type rules present when types configured.
- [ ] Sequence ≥ 2 no re-inject.
- [ ] Worker first prompt has no task-type create catalog.

### W6 — Docs + compatibility tests + smoke

**Files:** `docs/TASK-MANAGEMENT.md` §8, this plan status, optional SETTINGS note; integration tests; smoke if cheap.

**AC**

- [ ] Docs match required args and list tool; empty registry = not_configured.
- [ ] Existing smoke still green (update delegate fixtures to taskType if needed).
- [ ] No inferred migration of legacy tasks.

---

## Implementation order

```text
W1 pure registry/resolver
W2 host config hook
W3 MCP schema + list_task_types
W4 engine-graph resolve + persist
W5 first-turn + get_host_context
W6 docs + smoke
```

After each Wi: unit tests green → optional codex-impl-review → commit.

---

## Test matrix (summary)

| Case | Expect |
|------|--------|
| resolve preset only | backend/model/role/kind from type |
| explicit model | wins |
| explicit backend ≠ preset, no model | model cleared |
| unknown type + backend | fail, zero mutations |
| empty registry | task_types_not_configured |
| malformed registry | invalid_task_type_config, zero mutations |
| typo backend id | backend_unsupported, zero mutations |
| draft then config change then release | binding unchanged |
| list_task_types | coordinator only; no ledger; diagnostics when invalid |
| worker create | still denied |
| first-turn types section | coordinator when configured |
| max types + long descriptions | ids retained; all 4 type rules present |
| legacy task | no taskType field required |

```bash
npm test -- src/task/task-types.test.ts src/task/coordinator-tools.test.ts \
  src/task/engine-graph.test.ts src/task/host-context.test.ts src/bridge/server.test.ts
npm run smoke:child-model-opencode   # update fixtures for taskType if schema requires it
```

---

## Security & trust

- Registry is **user/workspace policy** (trusted host config), not agent-authored.
- Fail-closed unknown keys/types.
- Do not log secrets; model ids only.
- Workspace untrusted gates on release/delegate/start unchanged.

---

## Resolved decisions (locked)

1. Primary agent path = **task types**, not raw backend/model catalogs.
2. Config SoT = **`muster.taskTypes`** resource-scoped VS Code setting.
3. Resolve at **create/delegate**, persist concrete fields; no re-resolve on release.
4. MCP v1 **requires `taskType`**; backend/model optional overrides only.
5. Unknown type fails even with backend override.
6. Model drop when backend override changes without explicit model.
7. `taskType` ≠ `brief.kind` (routing vs preamble).
8. `list_task_types` under create_child, no opId.
9. Keep `get_host_context`; extend with types.
10. No legacy taskType inference.
11. **Empty registry → `task_types_not_configured` only** — **no** built-in product default types in v1 (user/workspace must configure).
12. Config hook returns **`TaskTypeRegistryResult`** (`ok` | `empty` | `invalid` + diagnostics); invalid ≠ empty.
13. Backend construction is **fail-closed structured** (`backend_unsupported` / try-catch around factory).
14. First-turn task-type **rules and type ids** are protected under host budget; raw catalogs demoted when types present.

## Open (non-blocking)

1. Temporary internal backend-only adapter — default **no** unless external callers proven.
2. How long raw catalogs remain in get_host_context — deprecate after types adoption.
3. Exact which coordinator playbook bullets are swapped for the 4 task-type rules (W5 implementation detail).

---

## References

- Think-about session: `codex-think-about-20260714-003` (CONSENSUS)
- Host context plan: `docs/plans/coordinator-host-context-and-seal.md`
- Settings pattern: `docs/SETTINGS.md`
- Domain: `docs/TASK-MANAGEMENT.md` §8
- Code: `src/task/{coordinator-tools,engine-graph,brief,host-context,types,capabilities}.ts`, `src/bridge/server.ts`, `src/extension.ts`
- VS Code configuration: contributes.configuration resource scope
- MCP tools: model-discoverable schemas; prefer domain list tool over dynamic enum
- ACP: session setup = cwd + mcpServers; policy via session/prompt first turn only
