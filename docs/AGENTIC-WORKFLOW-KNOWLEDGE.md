# Agentic workflow knowledge (Muster-native)

Authoritative product knowledge for Muster's **host-enforced** workflow commands.
This is **not** a copy of CK skills, Codex-review prompts, or provider slash-command
semantics. Runtime types and validators live in `src/workflow/contracts.ts`.

**Related:** [`TASK-MANAGEMENT.md`](TASK-MANAGEMENT.md) (lifecycle/outcomes),
[`DESIGN.md`](DESIGN.md) (architecture), [`MUSTER-BRIDGE.md`](MUSTER-BRIDGE.md) (MCP tools).

---

## 1. Invariants

1. **Prompts guide; the host enforces.** Phase transitions, approval, DAG
   materialization, and risky bridge actions are validated in host code — never
   by parsing assistant markdown.
2. **Workflow phase ≠ task lifecycle.** Lifecycle (`open` / `succeeded` / …) is
   the work outcome. Workflow phase (`thinking` / `awaiting_plan_approval` / …)
   is the orchestration stage on a root-owned `WorkflowRun`.
3. **No implementation without a validated, user-approved plan** (default).
   Ordinary prompts and `/new <goal>` enter think/plan first.
4. **Approval is durable and idempotent.** Reload must not auto-start work or
   double-start children. The gate is persisted, not UI-only.
5. **Schema-valid ≠ semantically valid.** Plans need unique proposal IDs, an
   acyclic dependency graph, known backends, acceptance criteria, and a
   verification strategy.
6. **Bounded evidence, not raw reasoning.** Artifacts carry structured summaries
   and redacted evidence refs. Do not store or render raw chain-of-thought as
   policy authority.
7. **Sealing remains separately authorized.** Planner/executor completion does
   not seal lifecycle; user (and delegated coordinator when enabled) seals.
8. **One command core.** VS Code slash UI, Command Palette, and future CLI share
   typed handlers with no `vscode` import in the core.

---

## 2. Command taxonomy

### 2.1 Workflow commands

| Command | Effect | Role |
|---------|--------|------|
| `/think` | Produce `DecisionBrief` | Exploration + structured judgment |
| `/plan` | Produce/revise `PlanArtifact` | Structured DAG proposal |
| `/approve` | Accept pending plan once | User gate → schedule |
| `/replan` | New plan revision | Preserve evidence; re-gate |
| `/implement` | Run implementation children | Post-approval writes |
| `/test` | Independent test evidence | `TestReport` |
| `/review` | Independent review evidence | `ReviewReport` |
| `/debug` | Symptom / attempts / next step | `DebugReport` |
| `/verify` | Declared-check synthesis | `VerificationReport` |
| `/finish` | Stage outcome proposal | Not a lifecycle seal |

### 2.2 Task / session commands

`/new`, `/tasks` (`/list`), `/status`, `/focus`, `/fork`, `/cancel`, `/retry`,
`/backend`, `/model`, `/mcp`, `/help` (`/?`).

- `/new` without a goal → draft chat (phase `draft`).
- `/new <goal>` → root task + automatic thinking/planning.

### 2.3 Utility commands (phase 2 surface)

`/context`, `/compact`, `/export`, `/archive`.

There is **no** slash command for tool permissions; host settings remain the
permission surface (`muster.permissions.mode`).

---

## 3. Phase transition table

```text
draft → thinking | planning | abandoned
thinking → planning | awaiting_plan_approval | abandoned
planning → awaiting_plan_approval | thinking | abandoned
awaiting_plan_approval → approved | planning | thinking | abandoned
approved → implementing | planning | abandoned
implementing → testing | reviewing | debugging | verifying | planning | finishing | abandoned
testing → reviewing | debugging | implementing | verifying | planning | abandoned
reviewing → debugging | implementing | verifying | testing | planning | finishing | abandoned
debugging → implementing | planning | testing | reviewing | abandoned
verifying → finishing | debugging | implementing | planning | abandoned
finishing → completed | debugging | planning | abandoned
completed → ∅
abandoned → ∅
```

Host rejects any transition not listed (`TRANSITION_DENIED`).

---

## 4. Role / capability matrix

| Workflow role | Typical phase | Bridge notes |
|---------------|---------------|--------------|
| planner | thinking, planning | May `submit_*` artifacts, `ask_user`, propose tasks; **cannot** `start_task` / `complete_task` / `fail_task` |
| executor | implementing | Write-capable after approval; still subject to task capabilities |
| tester | testing | Evidence-producing; policy-classified commands |
| reviewer | reviewing | Read/review evidence; no lifecycle seal |
| debugger | debugging | Records attempts; may route replan |
| verifier | verifying | Requires recorded evidence for success |
| coordinator | root | Intersects task graph capabilities with phase gate |

**Pre-approval phases** (`draft`, `thinking`, `planning`, `awaiting_plan_approval`):
`start_task`, `complete_task`, `fail_task`, `interrupt_task`, `cancel_task` are
denied at credential issue **and** dispatch.

**Provider built-in tools:** Muster Bridge restrictions are deterministic. ACP
adapters that cannot hard-block provider file/terminal tools must surface the
limitation; the host must not claim hard no-write enforcement for those backends.

---

## 5. Artifact catalog

Every artifact has: **producer** (task/turn), **consumer** (host/user/role),
**validator** (contracts.ts).

| Kind | Producer | Consumer | Validator |
|------|----------|----------|-----------|
| `decision_brief` | planner turn | user + plan | `validateDecisionBrief` |
| `plan` | planner turn | host approval + materializer | `validatePlanArtifact` |
| `task_handoff` | host / coordinator | child task | `validateTaskHandoff` |
| `test_report` | tester | verify / finish | `validateTestReport` |
| `review_report` | reviewer | verify / finish | `validateReviewReport` |
| `verification_report` | verifier | finish / user | `validateVerificationReport` |
| `debug_report` | debugger | replan / implement | `validateDebugReport` |
| `outcome_proposal` | finish flow | lifecycle sealer | `validateWorkflowOutcomeProposal` |

### 5.1 Plan semantic checks

- Unique stable `proposalId`s
- Acyclic `dependsOn` graph
- Every `backend` in the known backend set
- Non-empty acceptance criteria and verification per node and plan
- Rollback/open-question fields present (may be empty arrays)
- Confidence + unknowns explicit

### 5.2 Four product layers (do not collapse)

| Layer | Meaning |
|-------|---------|
| **Proposal** | Model-submitted brief/plan (untrusted) |
| **Approval** | User-accepted plan revision (host gate) |
| **Execution evidence** | Test/review/verify/debug artifacts |
| **Sealed outcome** | Lifecycle `succeeded`/`failed`/… via authorized sealer |

---

## 6. Failure routing

| Situation | Host behavior |
|-----------|---------------|
| Invalid plan shape/semantics | `PLAN_INVALID`; stay in planning; show structured error |
| Planner tries forbidden bridge action | `CAPABILITY_DENIED` / `PHASE_NOT_APPROVED` |
| Scope-changing user message mid-flight | New plan revision before new write work |
| Test/review failure | Propose debug or replan; preserve partial scope |
| Missing verification evidence | `EVIDENCE_MISSING`; cannot claim verified success |
| Duplicate `/approve` | `DUPLICATE_APPROVAL`; no second start |
| Reload during `awaiting_plan_approval` | Restore gate; **never** auto-start |

---

## 7. Provenance and compaction

- Evidence refs are bounded (id, kind, summary, optional redacted excerpt/path).
- Compaction **must retain** approved plan, decision brief, constraints,
  verification evidence refs, and approval history.
- Exports redact tokens, credentials, and raw permission/provider metadata.
- Archive **hides** tasks in filters; it does not change lifecycle or session ids.

---

## 8. Structured error codes

| Code | When |
|------|------|
| `PHASE_NOT_APPROVED` | Execution action before approval |
| `CAPABILITY_DENIED` | Role/phase forbids the bridge action |
| `PLAN_INVALID` | Shape or semantic plan failure |
| `EVIDENCE_MISSING` | Claimed success without evidence |
| `COMMAND_UNKNOWN` | Unknown slash command |
| `COMMAND_PHASE` | Command not legal in current phase |
| `COMMAND_ARGS` | Argument parse/schema failure |
| `ARTIFACT_INVALID` | Non-plan artifact shape failure |
| `TRANSITION_DENIED` | Illegal phase edge |
| `APPROVAL_REQUIRED` | Mutation needs explicit approve |
| `DUPLICATE_APPROVAL` | Plan already approved/started |
| `NOT_FOUND` | Missing task/run/artifact |

---

## 9. What we deliberately do not do

- Import CK workflow files or provider slash catalogs at runtime
- Infer executable graphs from assistant prose
- Auto-approve plans by default
- Claim every ACP backend can hard-block built-in writes during planning
- Treat CLI process exit as task lifecycle success
- Store raw model chain-of-thought as authority

---

## 10. Implementation map

| Concern | Location |
|---------|----------|
| Contracts / validators | `src/workflow/contracts.ts` |
| Persisted runs / artifacts | `src/workflow/store.ts` (schema v4) |
| Phase transitions | `src/workflow/transitions.ts` |
| Command registry / parser | `src/commands/*` |
| Phase-gated bridge | `src/workflow/capabilities.ts` + bridge credentials |
| Engine orchestration | `src/task/engine.ts` + workflow modules |
| VS Code adapter | `src/extension.ts`, webview |
| CLI adapter | `src/cli/*` (parity harness) |
