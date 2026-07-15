# Plan: Coordinator delegate / child-task UX improve

**Status:** APPROVED (codex-plan-review, 4 rounds)  
**Goal:** Coordinator spawns and finishes children in few tool steps; engine owns most child lifecycle; user only talks goals with the coordinator.

**Sessions:**
- think-about: `.codex-review/sessions/codex-think-about-20260715-001` (CONSENSUS)
- plan-review: `.codex-review/sessions/codex-plan-review-20260715-001`

---

## Problem

Current design is correct but **step-heavy for the coordinator agent**:

| Path | Today (min tool calls) | Pain |
|------|------------------------|------|
| One-shot worker | `delegate_task` + `wait_for_tasks` | 2 calls for the common case |
| Planned DAG | `create_task(s)` + `release_tasks` + `wait_for_tasks` | 3+ calls before children run |
| Child omits `complete_task` | parent `set_task_lifecycle` | Extra coordinator turn; easy to miss |
| Follow-up on child | reopen/send/wait choreography | No first-class “continue child” |
| Worker questions user | ACP/native/MCP elicitation | Breaks “user only talks to coordinator” |

Engine already does a lot well: auto-seal direct children under `parent_may_seal_direct`, wait barrier + parent continuation with `child_results`, cascade cancel, opId ledger, supervised root proposal.

**Diagnosis:** friction is **command composition**, not scheduling.

**Target pattern:** manager-style orchestration (OpenAI Agents SDK “agents as tools”): coordinator owns the user conversation, specialists run as bounded subtasks, results return for synthesis. Not conversation handoffs.

---

## Non-goals

- Infer wait set from all children / all descendants
- Seal lifecycle from CLI/process exit alone
- Root self-seal / `coordinator_delegate` / yolo (later power-user mode)
- Auto-interrupt when continuing a child
- Unbounded disposition-repair loops
- Direct worker↔user chat by default
- Delete draft + `release_tasks` for planned graphs
- Hide children entirely (must stay inspectable/auditable)
- Live-child FIFO `continue_child` queue mode (deferred; generation-aware barriers needed)
- Auto-reopen a supervised sealed root to deliver child questions

---

## Invariants to preserve

1. Host authority (trust, caps, ownership, limits)
2. Idempotency: `(turnId, opId)` fingerprint + deterministic ids
3. Explicit wait membership (compound fields only expand to an exact set)
4. CLI exit ≠ lifecycle seal
5. Root supervised: `complete_task` → proposal → user Accept
6. Fire-and-forget when wait fields omitted (backward compatible)

---

## Phased plan

### P0 — Compound wait + playbook rewrite

**API (extend existing tools; no new `delegate_and_wait`):**

| Tool | New field | Semantics |
|------|-----------|-----------|
| `delegate_task` | `waitForCompletion?: boolean` | If true, stage wait on the created child id in same txn |
| `delegate_tasks` | `waitForLocalIds?: string[]` | Wait only listed batch-local children (order preserved or canonicalized) |
| `release_tasks` | `waitForTaskIds?: string[]` | Wait only explicit subset of released (or already released) direct children |

**One store transaction must:**

1. Validate trust, capability, ownership, limits, types, deps, bindings, wait subset
2. Create/release + queue first-turn intents
3. Stage caller `wait_tasks` disposition (conflicts with prior disposition → reject)
4. Write one op-ledger entry (new fields in fingerprint)

**Playbook / docs (`host-context.ts`, bridge descriptions, TASK-MANAGEMENT §8):**

- Simple: `delegate_task({ ..., waitForCompletion: true })`
- Parallel: `delegate_tasks({ ..., waitForLocalIds: [...] })`
- Planned graph: `create_tasks` → `release_tasks({ ..., waitForTaskIds: [...] })`
- Standalone `wait_for_tasks` → advanced (re-arm barrier, wait on earlier fire-and-forget)
- Prefer task types from first-turn host context; `list_task_types` only refresh/diagnose

#### P0 addendum — Unsatisfied DAG / sink waits (ISSUE-6)

Sink-only waits (`waitForTaskIds: [sinkIds]`) must not hang forever when an upstream dep fails.

**Rule (engine, on released graph):** for any released task whose dependency is unsatisfied under `requiredOutcome: 'succeeded'`:

- Prefer existing dep policy: `onUnsatisfied: 'fail' | 'skip'` seals the blocked node (or cascade skip) so the wait barrier can resolve.
- Default for **batch-expanded** `dependsOn` edges used by planned graphs in this UX phase: use `onUnsatisfied: 'fail'` (or `skip` if product prefers non-error sinks) — **not** permanent `block` without attention.
- If a node remains open solely because of unsatisfied deps and policy is still block: set durable **wakeable** attention (`dependency_unsatisfied`) so a parent wait with `wakeOn: needs_attention` continues; do not leave silent open forever.

Playbook: when waiting only on sinks, document that upstream failure either fails/skips the sink via dep policy or wakes the parent via attention — never silent hang.

**Acceptance**

- [ ] One-shot spawn+barrier = **1** coordinator tool call
- [ ] Planned graph after host types = **2** calls (`create*` + `release` with wait)
- [ ] Omitted wait fields = fire-and-forget (existing behavior)
- [ ] Same `opId`+payload → no duplicate children/waits/continuations
- [ ] Same `opId` with different wait subset → conflict
- [ ] Child settles before parent commits wait → exactly one continuation
- [ ] Unlisted children never enter barrier
- [ ] Upstream failure while waiting only on sinks → barrier resolves **or** parent attention wakes (no silent hang)

---

### P0.5 — Missing disposition repair (engine)

When a **direct child** turn succeeds **without** staged disposition:

1. **Exempt** turns that settled as `awaiting_parent_answer` (or other non-terminal orchestration settlements) — never treat those as missing disposition (ISSUE-9).
2. **Do not** publish wakeable `attention: missing_disposition` to parent waits yet (ISSUE-4).
3. Enter durable child state `disposition_repair_pending` (or equivalent attention kind **excluded** from wait `needs_attention` wake set).
4. Enqueue **at most one** deterministic `disposition_repair` turn on **same child/session**.
5. Turn id derived from settled turn; **persist before schedule** (reload-safe).
6. Prompt: only ask child to stage `complete_task` / `fail_task` from prior work — **never invent summary**, never treat process success as lifecycle success.
7. Default **ON** for workers under root `parent_may_seal_direct`; override off via `executionPolicy` / task type.
8. **Only after** repair turn settles without disposition (or repair fails / is cancelled): publish wakeable `missing_disposition` attention and wake waiting parent; `set_task_lifecycle` remains supervised fallback.
9. If repair stages disposition successfully → auto-seal as today → parent wait resolves normally (no premature parent turn).

**Acceptance**

- [ ] At most one repair turn per missing disposition
- [ ] Never seals from adapter exit
- [ ] **Parent does not continue on first omission** while repair is pending
- [ ] Repair failure / second omission wakes parent without synthesized outcome
- [ ] Reload does not duplicate repair

---

### P0.5 — Parent-routed elicitation (`ask_parent`)

#### Gate all elicitation ingresses (ISSUE-1)

Workers must not reach the user by default via **any** path. Gate applies at every ingress:

| Ingress | Today | This plan |
|---------|-------|-----------|
| MCP `ask_user` | Often disabled / redirect to ACP | Deny for non-root unless dual escape hatch |
| ACP elicitation | Primary path | Same role/policy/trust gate |
| Native-agent questions | Handled in engine | Same gate |
| Agent-extension asks | Handled in engine | Same gate |

**Escape hatch** (all required): task/role policy `allowDirectAskUser` **and** trusted workspace **and** root-or-explicit grant. Dual gate alone is insufficient if any ingress is ungated.

#### End-to-end answer protocol (ISSUE-2, ISSUE-7, ISSUE-8)

Minimal contract. **Do not** keep the child as a live `waiting_user` process that holds a concurrency slot while the parent must run to answer.

| Step | Behavior |
|------|----------|
| 1. Child asks | Child calls `ask_parent` (or engine maps denied user-elicitation → parent route when policy says so). Engine assigns durable `questionId` (id from turn + opId). |
| 2. Child state — **scheduler-safe** | Prefer **release live slot**: stage durable task state `awaiting_parent_answer` + explicit turn settlement kind **`awaiting_parent_answer`** (non-terminal orchestration settlement — **not** success, **not** hard fail, **not** missing disposition). Free global/root/backend concurrency. Persist pending question + turn provenance. **Do not** count as live scheduler occupant. |
| 2b. Cross-feature exemptions (ISSUE-9) | While `awaiting_parent_answer`: **suppress** disposition_repair; **suppress** ordinary interruption/recovery holds that would block answer continuation; lifecycle stays `open`. Only `answer_child_question` (→ fresh continuation) or cancel/cascade may advance the child. |
| 3. Deliver to parent | Durable record on **direct parent**: question payload + `questionId` + `fromChildId`. If parent has active wait → attention continuation input; else enqueue deterministic parent turn/input (**no** duplicate turns for same `questionId`). Parent scheduling must remain possible even if N children asked in parallel (slots freed in step 2). |
| 4. Parent answers + **preserve wait** (ISSUE-10) | Parent tool `answer_child_question({ questionId, answers })`. Ledgered by opId. Persist answer before side effects. **Atomically** with answer: if parent had an explicit wait suspended/consumed by this attention wake, **re-arm the same wait set with identical membership** (same taskIds; never infer new children). Parent may then end the attention turn without calling `wait_for_tasks` again. |
| 5. Return to child — **fresh continuation** | Engine correlates `questionId`. **Never inject into a dead process.** Create **one** deterministic fresh child continuation turn carrying structured Q+A (session resume when safe; otherwise session-new with allowed pins). Clear pending. Does **not** replay the interrupted prompt as silent re-dispatch of uncertain tool side effects. Does **not** run disposition_repair on the prior awaiting settlement. |
| 6. Child continues | Child finishes work → `complete_task` as usual → auto-seal → parent re-armed wait resolves → final `child_results` continuation. |
| 7. Cancel / parent seal | Cancel child or parent cascade → fail pending question with cancelled; no success seal invented. |
| 8. Reload | **Never revive the old process.** Persist question (and answer if submitted) + re-arm intent for parent wait if needed. On reload: if answer present and continuation not yet created → one deterministic continuation; if answer absent → keep `awaiting_parent_answer` + parent delivery; no repair/recovery spuriously; no duplicate parent prompts; no lifecycle seal from reload. |

#### Terminal parent (ISSUE-3)

Fire-and-forget child may ask after direct parent is **terminal**.

| Parent state | Behavior |
|--------------|----------|
| Open (waiting or idle) | Route as above |
| Soft/hard terminal **non-root** coordinator | Prefer nearest **open** ancestor coordinator (walk parents). If none open: durable orphan question → **root if open**, else surface as **user-visible host attention** on the graph (not auto-reopen sealed root). |
| **Sealed root** (user already Accepted) | **Never** auto-reopen root. Persist orphan question; show host/UI attention “child needs input after job closed”; user may reopen root via normal send, or cancel child. Child remains blocked until answer or cancel. |

Playbook: prefer `waitForCompletion` / explicit waits when the parent still needs to answer child questions; fire-and-forget accepts orphan risk with host attention fallback.

**Acceptance**

- [ ] Workers cannot reach user on MCP **or** ACP **or** native **or** extension without dual policy + trust
- [ ] Full ask→answer→resume round-trip with durable `questionId`
- [ ] Parent receives question even when not currently waiting
- [ ] Asking children that would exhaust concurrency **do not** prevent parent from running (slots released or excluded)
- [ ] Pending `awaiting_parent_answer` never triggers disposition_repair or recovery hold
- [ ] Parent answers during wait → original wait membership re-armed; after child seals → exactly one final `child_results` continuation
- [ ] Reload mid-pending (before answer): parent can still answer; no zombie live process
- [ ] Reload after answer before child continuation: exactly one deterministic continuation; no prompt replay of uncertain work; no lifecycle seal
- [ ] Terminal non-root parent: routes to open ancestor or host attention
- [ ] Sealed root: no auto-reopen; host attention + user-driven reopen/cancel only
- [ ] Root coordinator still uses direct user elicitation for its own questions

---

### P1 — `continue_child`

```ts
continue_child({
  opId: string;
  childId: string;
  instruction: string;
  waitForCompletion?: boolean;
  // mode omitted this phase — live children always rejected
})
```

**Semantics (ISSUE-5 — wait must observe the follow-up, not the old terminal):**

1. Validate direct-child ownership, caps, trust, limits.
2. **Live/running child → reject** (no silent interrupt; no live queue mode this phase).
3. **Open idle child:** queue new instructed turn on existing session.
4. **Terminal child:** in **one transaction**: reopen lifecycle to `open` → admit follow-up turn (persisted, scheduler-eligible intent) → if `waitForCompletion`, stage wait on this child for the **new** work epoch → op-ledger write.
5. Wait staging must not resolve against the **previous** terminal outcome. Barrier membership is the child id, but resolution requires a **new seal after the admitted follow-up turn** (track via turn sequence / seal generation / wait epoch — pick existing pattern closest to wait registration turn).
6. Never replay uncertain interrupted process; new turn only.
7. Future work (out of scope): `mode: 'queue'` for live + generation-aware barriers; `interrupt_and_continue`.

**Acceptance**

- [ ] Terminal + `waitForCompletion`: parent does **not** resolve until follow-up seals
- [ ] Live child rejected
- [ ] Same-txn reopen + admit + wait + ledger
- [ ] Session identity preserved; no uncertain replay

---

### P1 — `cancel_tasks` batch

```ts
cancel_tasks({ opId, childIds: string[], reason?: string })
```

- All-or-nothing validation of direct-child set
- Reuse durable remote cancel, subtree cascade, wait reconcile, `sealedBy` provenance
- Do **not** auto-cancel children on new user prose; coordinator decides supersede
- Cancels pending `ask_parent` questions on cancelled subtree

---

### P1 — Root authority (no change this phase)

- Root `complete_task` → `outcomeProposal`; user Accept seals
- Do **not** ship `coordinator_delegate` / yolo here
- Document as later optional mode

---

### P2 — Coordinator-centric UI

- One primary composer on coordinator
- Aggregate chrome: “N delegates running”, “1 disposition retry”, “M results ready”, “child needs input”
- Child streams + provenance in inspection view
- Hide routine child lifecycle buttons from primary path
- Structured child results / attention / orphan questions into coordinator (or host) surfaces with bounded, untrusted framing

---

## Target happy paths

### Simple

```text
User → root coordinator
Coord: delegate_task({ goal, taskType, brief, waitForCompletion: true })
  → end turn
Engine: run child → complete_task → auto-seal → resolve wait → parent continuation
Coord: synthesize → complete_task (root proposal)
User: Accept
```

### Planned graph

```text
Coord: create_tasks([... deps/bindings; onUnsatisfied fail|skip ...])
Coord: release_tasks({ taskIds, waitForTaskIds: [sinkIds] })
  → end turn
Engine: schedule by deps → seals or dep-policy terminals → barrier → continuation
  (upstream fail does not silent-hang sinks)
```

### Child forgot disposition

```text
Child turn OK without complete_task
Engine: disposition_repair_pending (not parent-wakeable)
       → one disposition_repair turn
  → complete_task → seal → parent continues
  OR repair fails → wakeable missing_disposition → parent + set_task_lifecycle
```

### Child asks parent

```text
Child: ask_parent → blocked on questionId
Parent: attention / turn with question → answer_child_question
Child: resume with answers → complete_task
```

---

## Implementation touchpoints (expected)

| Area | Files (indicative) |
|------|--------------------|
| Tool types / parse | `src/task/coordinator-tools.ts` |
| Graph mutators | `src/task/engine-graph.ts` |
| Tool dispatch / settle / repair / elicitation | `src/task/engine.ts` |
| Pure transitions | `src/task/transitions.ts` |
| Caps / allowed actions | `src/task/capabilities.ts` |
| Host playbook | `src/task/host-context.ts` |
| MCP schemas | `src/bridge/server.ts` |
| ACP / native ask paths | `src/task/engine.ts`, ask bridge |
| Dep unsatisfied policy | `src/task/engine-graph.ts`, batch expand, readiness |
| Normative docs | `docs/TASK-MANAGEMENT.md` §8 |
| Tests | adversarial suite below |

---

## Release gate — adversarial tests

- [ ] Same compound `opId`+payload: no duplicate children, waits, continuations
- [ ] Same `opId`, different wait membership: conflict
- [ ] Child settles before parent commits compound wait
- [ ] Crash/reload between persist and spawn
- [ ] Explicit wait excludes unlisted children
- [ ] Upstream fail + wait only on sinks: barrier resolves or parent attention (no hang)
- [ ] Missing disposition → exactly one repair; parent **not** woken on first omission
- [ ] Repair failure wakes parent without invented outcome; never seal from CLI exit
- [ ] Elicitation deny: MCP, ACP, native, extension each tested for workers
- [ ] `ask_parent` full round-trip; N asking children at concurrency limit still allow parent turn
- [ ] No disposition_repair / recovery hold while `awaiting_parent_answer`
- [ ] Attention wake for ask → answer re-arms identical wait → child seals → one final parent continuation
- [ ] Reload before answer and after answer (one continuation; no process revive; no uncertain replay)
- [ ] Child asks after direct parent sealed: open ancestor or host attention; root not auto-reopened
- [ ] `continue_child` terminal + wait: resolves only after follow-up seal
- [ ] `continue_child` live: reject
- [ ] Remote cancel deferred + cascade once; pending parent questions cancelled
- [ ] Root stays open with proposal until user Accept

---

## Suggested ship order

1. **P0** compound wait fields + playbook + DAG unsatisfied rule (highest ROI)
2. **P0.5** disposition repair with non-wakeable pending state
3. **P0.5** multi-ingress gate + `ask_parent` answer protocol (+ terminal-parent rules)
4. **P1** `continue_child` (reject-if-live only) + `cancel_tasks`
5. **P2** UI aggregation
6. Later (out of scope): root `coordinator_delegate` / yolo; live queue continue; generation-aware multi-epoch waits

---

## Industry references (consensus)

| Source | Takeaway for Muster |
|--------|---------------------|
| [OpenAI Agents SDK — orchestration](https://openai.github.io/openai-agents-python/multi_agent/) | Manager + agents-as-tools; keep user conversation on manager |
| [LangGraph workflows/agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) | Dynamic workers + collect results for orchestrator |
| [LangGraph functional API](https://docs.langchain.com/oss/python/langgraph/functional-api) | Checkpointed resume + idempotent side effects |
| [Anthropic multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system) | Lead agent + parallel subagents; costly; weaker for heavy deps → keep draft graphs |
| [AutoGen teams](https://microsoft.github.io/autogen/stable/reference/python/autogen_agentchat.teams.html) | Prefer graceful cancel; avoid inconsistent abrupt stop |
| [OpenAI Swarm](https://github.com/openai/swarm) | Educational only; superseded — do not copy |

---

## Confidence

**High** on P0 compound wait; **medium-high** overall after plan-review fixes for elicitation, repair wake sequencing, continue_child wait epoch, and DAG unsatisfied paths.
