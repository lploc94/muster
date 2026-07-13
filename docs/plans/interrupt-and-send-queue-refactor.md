# Plan: Queue + Direct Message = Interrupt & Send

## Status
**APPROVED** — codex-plan-review 2026-07-13 (3 rounds). Ready for implementation.

## Target
Refactor Muster’s mid-turn user messaging so **direct messages are interrupt & send (cut & continue)** by default, not concurrent ACP `session/prompt` “live inject”.

**User-confirmed policy:**
- Direct path (Ctrl/Cmd+Enter while a turn is running) = **interrupt running turn → schedule a new turn with that message on the same session**.
- Context continuity = **whatever the CLI keeps after `session/cancel`** — do **not** require pixel-perfect cut at interrupt time; no mandatory partial-assistant snapshot.
- Enter (plain) remains **FIFO queue** (do not cut) while a turn is live.
- Concurrent mid-turn inject (`sendLiveInput` / `delivery: live_inject` / concurrent `session/prompt`) is **not** the product path for direct messages.

## Evidence (why this plan exists)
1. Live Grok smoke (`npm run mvp:grok-live-inject`): concurrent inject returned `code: delivered` mid-stream, agent continued primary count 1→100, **no** `MUSTER_INJECT_ACK` — `delivered ≠ processed`.
2. ACP v1: `session/prompt` is a full prompt turn; concurrent same-session prompts are not standardized mid-turn steering.
3. Runtime stale-dist: `package.main` → `dist/src/extension.js` still posts `liveInputResult` banner; source queue-first diverged — any refactor must **compile + reload** and fix host contract tests.
4. Contract smoke: `npm run test:live-inject-smoke` proves source/dist mismatch, empty-`{}` → delivered, sink teardown, Claude `turnQueue`.

## Goals
1. **Correctness:** Direct user message while live is **always** processed as a **new TaskTurn** after interrupt (or queued if interrupt fails per policy below).
2. **UX clarity:** No false “Live input delivered to the active session” for direct send.
3. **Two intents only:**
   - **Queue (Enter):** FIFO follow-up, no interrupt.
   - **Direct (Ctrl/Cmd+Enter while running):** interrupt & send.
4. **Same session:** Next turn uses `task.committedSessionId` / observed session resume as today.
5. **Remove product dependency** on concurrent live inject for composer direct path.

## Non-goals
- Perfect partial-stream fidelity at cancel boundary.
- ACP v2 prompt lifecycle / vendor liveInput capability matrix.
- Changing elicitation / Grok ask_user_question flows.
- Multi-task concurrent interrupt redesign.
- Keeping `delivery: 'live_inject'` as a user-facing feature (may delete or leave dead backend API unused by composer).

## Product model (normative)

### Keyboard / composer
| Context | Key | Intent | Host behavior |
|---------|-----|--------|----------------|
| Task, turn **running** | Enter | Queue | Create queued turn `delivery: turn` (or default); **do not** interrupt; show in `queuedTurns`; not in chat until turn starts |
| Task, turn **running** | Ctrl/Cmd+Enter | Direct | **Interrupt** live turn → enqueue/schedule **new turn** with message; show user message as opening user of next turn (after interrupt settles) |
| Task, **idle** | Enter or Ctrl/Cmd+Enter | Send | Existing `send` / continue path (immediate turn) |
| Draft / new task | Enter or Ctrl/Cmd+Enter | Create | Unchanged |

### Naming (UI + docs)
- Prefer: **“Interrupt & send”** / **“Cut & continue”** — not “live inject”.
- Composer hint e.g.: `Enter queues · Ctrl+Enter interrupts and sends`.
- Remove “injects live input” / “never queues” copy that describes concurrent inject.

### Protocol (webview ↔ host)
**Preferred simplification (recommended):**
- Keep OutMessage `send` for queue/idle.
- Repurpose or replace `sendLiveInput`:
  - **Option A (recommended):** Keep type name `sendLiveInput` temporarily for less churn, but host implements **interrupt & send only** (no `backend.sendLiveInput`).
  - **Option B:** Rename to `interruptAndSend` / `directSend` in protocol + webview + host (cleaner, more file churn).

Plan default: **Option A** for first landing; rename in a follow-up if desired.

**Remove / stop using:**
- Host posting `liveInputResult` + webview banner `Live input delivered to the active session.` for this path.
- Engine path `delivery: 'live_inject'` + `tryDispatchQueuedLiveInject` for composer.
- Mid-stream `raw` marker `{ muster: 'live_inject' }` + `insertLiveInject` as product path (can remove or leave inert).

### Engine sequence — Direct (interrupt & send)

**Ordering (ISSUE-3):** **reserve continuation first, interrupt second.** Never abort the live turn before the new message+turn commit succeeds.

```
on sendLiveInput(taskId, instruction):  // semantic: interruptAndSend
  1. Validate taskId + non-empty instruction (existing bounds).
  2. Find running turn for task (if any) + local liveRuns ownership.
  3. If no running turn:
       → same as send/continueTaskWithMessage (plain turn) — schedule immediately.
  4. If running turn:
       a. **FIRST** durably commit message + queued follow-up turn for instruction
          (continueTaskWithMessage / equivalent). Live turn keeps scheduler from
          promoting it yet. DO NOT call backend.sendLiveInput.
       b. If allocation fails (terminal task, turn cap, missing task):
          **commandError**, **do not interrupt**, leave current turn running.
       c. **THEN** interruptTurn(runningTurnId) only if local live handle exists
          (abort → ACP session/cancel). Idempotent if already cancelling.
       d. postSnapshot (queue row visible; not chat until next turn starts).
  5. On settlement of the interrupted turn → Settlement + session-bind policy.
  6. When follow-up promotes: executeTurn with resumeId from session selection
     (see Session identity after interrupt) — never invent concurrent inject.
```

### Interruption confidence (ISSUE-2 — authoritative for bind + promote)

**Do not treat every local `interrupted` settlement as proof the CLI stopped.**

Today ACP cancel can **force-settle** after grace even if the agent ignores `session/cancel`; `interruptTurn` can “succeed” with no local live handle.

**Confidence states (authoritative everywhere):**
| State | When | Bind observed → `committedSessionId` | Clear hold + auto-promote FIFO onto same session |
|-------|------|--------------------------------------|--------------------------------------------------|
| **`armed`** (provisional) | Local live handle existed when interrupt was requested; cancel in flight | **No** | **No** |
| **`confirmed`** | Primary prompt path ended after cancel **without** force-timeout drop (cooperative / prompt completed as cancelled before grace force) — implement with strongest available signal; document exact code flag | **Yes** (if task.committed unset and observed/candidate set) | **Yes** if ≥1 queued follow-up |
| **`forced` / unconfirmed / non-owner** | Force-timeout, no live handle at request, not local owner | **No** — keep id only as turn `candidateSessionId` / non-committed | **No** — keep `holdAutoPromote`; message stays queued; recovery / user retry |

**Rules:**
- `armed` is **never** sufficient for session bind or promotion.
- Only **`confirmed`** settlement may bind session, clear holds, and promote (Ctrl+Enter direct **and** Enter-then-Stop).
- Forced path: do not start a same-session prompt that can race a still-active primary (A9).

**Tests:** (a) armed then force-timeout → neither commits session nor promotes; (b) no local handle → queue only, no confirmed path; (c) confirmed → bind + promote.

### Session identity after interrupt (ISSUE-1 — gated by confirmed)

**Bug today:** `settleInterrupted` only stores `candidateSessionId` / observed id on the interrupted **turn**; `task.committedSessionId` updates on **success** settlement. `executeTurn` resumes only via `task.committedSessionId`. First-turn interrupt therefore often has **no committed id** → next turn does `session/new` and **loses** the session Phase-0 “proved” by hand-passing `resumeId`.

**Normative fix (must implement):**
1. **Only on `confirmed` interrupt settlement:** if interrupted turn has `observedSessionId` or `candidateSessionId` and task has **no** `committedSessionId`, bind that session onto the task (same field all resume paths use).
2. On `forced` / unconfirmed: leave as turn-level candidate only; do **not** write `task.committedSessionId`.
3. Resume selection for executeTurn remains `task.committedSessionId` after bind; do not special-case “latest interrupted observed” for unconfirmed.
4. **Engine test:** confirmed interrupt with committed=null, observed=set → next `backend.run` gets `resumeId === observed`. Separate test: forced timeout → committed stays null, follow-up not auto-promoted.
5. Phase 0 must use **TaskEngine** / same selection helper after **confirmed** settle — not only hand-wired `runTurn({ resumeId })`.

### Settlement / holdAutoPromote policy (ISSUE-4 — single exact rule)

**Today:** `allowSameTaskFollowUps` only on `succeeded`; `settleInterrupted` calls `holdQueuedFollowUpsOnFailure` → all queued follow-ups get `holdAutoPromote`.

**Exact rule (confidence-gated):**

> When a turn settles `interrupted` with confidence **`confirmed`** **and** ≥1 same-task `queued` follow-up:
> 1. **Clear or do not apply** `holdAutoPromote` on those follow-ups for this path only.
> 2. Allow FIFO promote after settle (same ordering as success drain).
> 3. Session bind per Session identity (confirmed only).
>
> **`forced` / unconfirmed interrupt:** keep generic failure hold; **no** promote; **no** commit bind.
>
> **Pure Stop** (confirmed or not) with **zero** queued follow-ups → promote nothing (existing recovery OK).
>
> **Enter-then-Stop:** same confidence gate — promote only if interrupt settlement is **`confirmed`** (user expressed next work, but still must not race a live primary).
>
> **Failed** (not interrupted) settlement: keep existing freeze (do not broaden).

Document as intentional TASK-MANAGEMENT change.

**Tests:** (1) confirmed direct → promote+run; (2) confirmed Enter-then-Stop → promote; (3) Stop empty queue → no turn; (4) failed settlement still holds; (5) forced interrupt with queue → held, no bind.

### Queue (Enter) — unchanged intent
- `send` → `continueTaskWithMessage` / handleSend → distinct queued turn.
- Visible in `queuedTurns` panel; omitted from chat until turn starts (existing).
- No interrupt.

### Failure modes
| Case | Behavior |
|------|----------|
| Allocation fails before interrupt | commandError; **live turn keeps running**; no message loss from cut |
| Local live handle missing | Queue message only; do not claim interrupt; do not same-session auto-promote as cut&continue |
| Hung / forced cancel timeout | Message stays queued; no concurrent same-session prompt; recovery UX |
| No committed session but observed on interrupted turn | Bind per Session identity section — next turn must resume that id |
| No session id at all yet | Queue after interrupt; next turn may session/new only if nothing observed |
| Task terminal | Refuse with commandError (before interrupt) |
| Empty instruction | Match existing send validation |
| Multiple rapid Ctrl+Enter | Reserve N queued turns; single idempotent interrupt; FIFO after settle |

## Implementation steps

### Phase 0 — Prove cancel → same session → new prompt (Grok)
- Add `scripts/test-grok-interrupt-and-send.ts`:
  1. Prefer **TaskEngine** path (or shared resume selection helper used by executeTurn), not only hand-wired `runTurn({ resumeId })`.
  2. Start long primary turn until session observed.
  3. Reserve continuation message, then interrupt (same order as production).
  4. After settle, assert next backend invocation `resumeId` equals observed session (even if `committedSessionId` was null before bind).
  5. Assert marker appears in **post-interrupt** turn stream (processing).
- Gate claiming A3/A4 on this smoke when Grok auth available; else ENVIRONMENT BLOCKED — do not ship host UX that claims processing without engine session-bind tests.

### Phase 1 — Engine + host semantics
1. **Interrupt confidence flag** on settlement (engine/ACP path): `armed` | `confirmed` | `forced` — only `confirmed` enables bind+promote (ISSUE-2).
2. **Session bind helper** (engine): on **`confirmed`** interrupt settlement only, propagate observed/candidate → `task.committedSessionId` when unset (ISSUE-1). Tests: confirmed bind; forced no-bind.
3. **Host `sendLiveInput` case** (`src/extension.ts`):
   - Stop `routeSendLiveInput` / concurrent inject / `liveInputResult` ack.
   - **Order:** `continueTaskWithMessage` (reserve) → on success `interruptTurn` if local live handle → `postSnapshot`. On reserve failure: error, no interrupt.
   - Message visibility: queue panel until next turn starts (same as Enter).
4. **Settlement promotion + hold override** (`src/task/engine.ts`):
   - Clear/skip `holdAutoPromote` + allow FIFO promote **only** on `confirmed` interrupt with queued follow-ups.
   - Do **not** only flip `allowSameTaskFollowUps` without addressing `holdQueuedFollowUpsOnFailure`.
5. **Remove composer use of `delivery: 'live_inject'`** from host.
6. **Deprecate/delete engine live_inject path** (`tryDispatchQueuedLiveInject`, flush, delivery flag) to avoid two models.
7. **Keep** `backend.sendLiveInput` only if tests need it; composer must not call it.

### Phase 2 — Webview UX
1. `composer-submit.ts`: keep Ctrl+Enter → `sendLiveInput` type **or** rename; comments say interrupt & send.
2. `Composer.svelte` copy: queue vs interrupt-and-send.
3. Remove reliance on `formatLiveInputDeliveredMessage` for success path (dead code path or delete banner handler usage).
4. `thread.svelte.ts`: no requirement for `insertLiveInject` mid-stream split for product path.
5. Queue panel: direct-after-interrupt turns behave like normal queued turns until start.

### Phase 3 — Tests
1. Fix `src/host/webview-security.test.ts` for reserve-then-interrupt contract (not routeSendLiveInput).
2. Engine: session bind after interrupt with committed=null (ISSUE-1).
3. Engine: reserve failure does not abort live turn (ISSUE-3).
4. Engine: interrupt + queued follow-up promotes; hold cleared only on interrupt path; failed settlement still holds (ISSUE-4).
5. Engine: forced cancel / no local handle does not same-session auto-promote as confirmed cut (ISSUE-2).
6. Composer-submit intent mapping; remove delivered-banner expectations.
7. Rapid double direct-send → two reserved messages, one interrupt, FIFO.
8. Update `test:live-inject-smoke` → interrupt-and-send contracts.

### Phase 4 — Docs
Update (mechanical markers for `test:queue-live-inject-docs` will need rewrite):
- `docs/WEBVIEW.md` §14 — Enter queue / Ctrl+Enter interrupt & send.
- `docs/TASK-MANAGEMENT.md` §9.1 — remove concurrent inject as product path; document promote-after-interrupted.
- `CONTRIBUTING.md` verification commands.
- Deprecate claims: “silent delivery via send”, “liveInputResult delivered”, “always try concurrent inject”.

### Phase 5 — Build / reload hygiene
1. `npm run compile` so `dist` matches source (`package.main`).
2. Reload Extension Development Host before manual UAT.
3. Manual UAT (Grok): running turn → Ctrl+Enter → turn stops → new turn processes message with session continuity.

## Files likely touched
| Area | Files |
|------|--------|
| Host | `src/extension.ts`, possibly drop use of `src/host/live-input.ts` from composer path |
| Engine | `src/task/engine.ts`, `src/task/types.ts` |
| Webview | `webview/src/lib/composer-submit.ts`, `Composer.svelte`, `protocol.ts`, `App.svelte`, `thread.svelte.ts` |
| Tests | `webview-security.test.ts`, engine tests, composer-submit tests, smoke scripts |
| Docs | `WEBVIEW.md`, `TASK-MANAGEMENT.md`, `CONTRIBUTING.md`, queue-live-inject docs verifier |

## Acceptance criteria
1. **A1.** While a task turn is running, **Enter** creates a FIFO queued turn, does **not** interrupt, message visible in queue panel (not chat until start).
2. **A2.** While running, **Ctrl/Cmd+Enter** reserves a follow-up then interrupts the live turn when a local handle exists; does **not** call concurrent `backend.sendLiveInput` for that action.
3. **A3.** After a **`confirmed`** interrupt settles, the direct message runs as a **new turn** resuming the **same observed session** even if `committedSessionId` was null before bind (engine-selected resumeId).
4. **A4.** Agent **processes** the direct message content on that turn — not transport-only `delivered`.
5. **A5.** No user-visible **“Live input delivered to the active session.”** banner on direct send.
6. **A6.** Idle Ctrl+Enter behaves like send (no spurious interrupt).
7. **A7.** Reserve-before-interrupt: allocation failure leaves the live turn running.
8. **A8.** On **`confirmed`** interrupt with queued follow-ups, holds clear and FIFO promotes; pure Stop empty queue promotes nothing; **failed** settlements keep freeze; **`forced`/`armed`-only** never bind or promote.
9. **A9.** Forced/unconfirmed cancel does not commit session or auto-start a same-session prompt that races a still-active primary.
10. **A10.** `npm run compile` + updated unit/security tests green; docs describe interrupt & send not concurrent inject.
11. **A11.** Grok engine-path smoke (when auth available) shows marker on post-interrupt turn with correct resumeId.

## Risks & mitigations
| Risk | Mitigation |
|------|------------|
| Lost session on first-turn interrupt | ISSUE-1 bind observed → committed / resume selection |
| Fake interrupt → concurrent prompt | ISSUE-2 confidence gate; no promote on forced/no-handle |
| Cut without reserved message | ISSUE-3 reserve-first ordering |
| Stranded queue via holdAutoPromote | ISSUE-4 explicit hold override on interrupt+queued only |
| Stop-only UX change | Empty queue → no promote |
| Stale dist | Phase 5 compile + reload |
| Dual live_inject model | Delete/disable in same PR |

## Out of scope follow-ups
- True mid-turn inject if a backend later advertises a real steer API.
- Partial assistant snapshot into next user message.
- Rename `sendLiveInput` → `interruptAndSend` protocol (optional cleanup).

## Verification commands (post-impl)
```bash
npm run test:live-inject-smoke   # update expectations
npx vitest run src/host/webview-security.test.ts src/task/engine.test.ts webview/src/lib/composer-submit.test.ts
npm run compile
# live:
npm run mvp:grok-live-inject     # replace/extend with interrupt-and-send script
# Extension Development Host: running turn → Enter (queue) vs Ctrl+Enter (cut & continue)
```

## Decision log
- 2026-07-13: User chose interrupt & send as **default** for direct messages; context = CLI post-cancel semantics; no exact cut-point fidelity required.
- Concurrent inject proven ineffective on Grok for product “process my message” goal.
- 2026-07-13 codex-plan-review round 1 (REVISE): adopted ISSUE-1 session bind, ISSUE-2 interrupt confidence, ISSUE-3 reserve-before-interrupt, ISSUE-4 exact holdAutoPromote override rule.
- 2026-07-13 codex-plan-review round 2 (REVISE ISSUE-2): confidence is authoritative — only `confirmed` may bind session and promote; `armed` provisional only; forced keeps non-committed candidate + hold.
