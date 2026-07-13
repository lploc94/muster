# Plan: Task + Chat + Turn only — hide CLI from user UX

## Status
**APPROVED** — codex-plan-review 2026-07-13 (3 rounds). Ready for implementation.

## Target UX (user mental model)
User **only** knows:
- **Task** — work unit + lifecycle outcome (`open` / sealed).
- **Chat** — messages in the thread.
- **Turn** — is it executing, done, what was the result?

User **does not** know and **must not** be taught:
- CLI process status (running / idle / stopped / not started)
- Session id / process reconnect
- “Needs recovery because CLI failed”

When user sends a **valid** message **within configured capacity**: it must be **accepted** (durable queue). If execution fails transiently, **engine** retries where safe. User only cares: turn working → finished → result.

At hard capacity (`maxTurns` / resource limits): send is **rejected visibly**; composer **keeps the draft** — do not claim “every message always sticks” beyond capacity.

## Evidence (current state)
Engine already owns process/session/retry:
- Persist message + `TaskTurn(queued)` before spawn (`TaskEngine.send`)
- Lifecycle never sealed by CLI exit
- Shared ACP agent + per-turn `session/new|load` (capability-gated `loadSession`; **no** `session/resume` in Muster ACP client)
- Auto-retry under `maxAutomaticRetries` (default 2)
- Reload: interrupt orphan live turns; **no silent uncertain replay**

Still leaks process-shaped UX:
- Composer CLI strip (`webview/src/lib/cli-status.ts`) — “CLI running/stopped/idle”
- TaskList “CLI running” live-dot
- Recovery panel + free-form send **blocked** on `needs_recovery` (engine + `runtimeBlocksComposer`)
- Webview also blocks free-form on `waiting_dependencies` / `waiting_children` via `runtimeBlocksComposer` — conflicts with “send always queues”
- Webview derives process view from `hadProcess || committedSessionId`
- Between turns UI shows “CLI stopped” even when session is bound (misleading)

Key refs: `docs/TASK-MANAGEMENT.md` §3–§4, `src/task/engine.ts` (~needs_recovery guard), `webview/src/lib/task-status.ts` (`runtimeBlocksComposer`), `webview/src/components/Composer.svelte`, `TaskWorkspace.svelte`.

## Goals
1. Public product surface = **TaskLifecycle + TurnActivity** only (no CLI/process vocabulary).
2. Free-form send is **not** gated by process death, exhausted auto-retry, or wait orchestration (deps/children/external); only structured ask UI-default + hard capacity/invalid input.
3. Host is authority for turn activity projection; webview does not invent process state.
4. Keep invariants: lifecycle ≠ process exit; persist-before-spawn; **no silent uncertain replay**.
5. Phased delivery so A/B ship value without waiting for full reliability stack (C).
6. Session continuity after confirmed failure is defined so chat does not silently fork to a new conversation when a session id was already observed.

## Non-goals
- Seal task lifecycle from agent/CLI exit.
- Silent auto-replay of in-flight prompts after reload / connection loss mid-prompt.
- Exposing `committedSessionId` / process handles to webview.
- Redesigning shared-agent ownership solely for this UX.
- Phase B solving postMessage loss / webview recreation mid-send (that is Phase C).
- Changing interrupt&send keyboard model (Enter = queue, Ctrl+Enter = interrupt&send) — orthogonal plan: `docs/plans/interrupt-and-send-queue-refactor.md`.
- Inventing ACP `session/resume` (not in Muster client); use existing capability-gated `session/load` only.
- Grouping multiple persisted auto-retry turns into a new “logical turn” identity model.

---

## Product contract (normative)

### Two public axes
| Axis | Values | Answers |
|------|--------|---------|
| **TaskLifecycle** | `open \| succeeded \| failed \| cancelled \| skipped` | Is the *work* still open or sealed? |
| **TurnActivity** | see below, or `null` | What is the *current turn* doing? |

Internal `runtimeActivity` / `viewStatus` may remain host-side derivation feeding `TurnActivity`; they are **not** user-facing CLI language.

### TurnActivity (host-owned)
```ts
type TurnActivityWaitReason =
  | 'dependencies'
  | 'children'
  | 'external'
  | 'held_after_failure'
  | 'live_turn_ahead' // optional; usually position alone is enough
  | string;

type TurnActivity =
  | {
      state: 'queued';
      turnId: string;
      position?: number;
      /** Required when promote is blocked for a user-visible reason other than pure FIFO behind a live turn. */
      waitReason?: TurnActivityWaitReason;
    }
  | { state: 'executing'; turnId: string; phase?: 'starting' | 'streaming' | 'tool' | 'retrying' }
  | { state: 'waiting_you'; turnId: string; requestId?: string }
  | { state: 'failed_turn'; turnId: string; retryable: boolean }
  | { state: 'uncertain'; turnId: string; requiresConfirmation: true }
  | null; // ready / between turns — no strip
```

#### Host projection precedence (authoritative)
Host derives `currentTurnActivity` for a task as follows (first match wins):

1. **Live turn** (`running` or `waiting_user`):
   - `waiting_user` → `{ state: 'waiting_you', turnId, requestId? }`
   - else → `{ state: 'executing', turnId, phase? }`
2. Else **earliest queued turn** (by sequence / FIFO):
   - Attach `position` among open queued turns for this task.
   - Attach **required** `waitReason` when promotion is blocked by:
     - unsatisfied dependencies → `dependencies`
     - `task.wait.kind === 'children'` → `children`
     - `task.wait.kind === 'external'` (or equivalent blocked wait) → `external`
     - `holdAutoPromote` after failure → `held_after_failure`
   - Pure FIFO behind nothing blocking except “not yet scheduled” → `waitReason` omitted (label: “Queued”).
3. Else **latest settled turn needing attention** (no replacement live/queued), by interrupt/failure mapping:
   - **User-requested / confirmed Stop** (`interrupted` with confirmed user cancel confidence, no error) → **not** sticky activity; treat as cancelled **transcript** result → fall through toward `null` (composer ready).
   - Turn `status === 'failed'` → `{ state: 'failed_turn', turnId, retryable }`
   - Durable `uncertain` (Phase C) or orphan-live mapped to confirmation-needed → `{ state: 'uncertain', … }`
   - Ambiguous interrupted without confirmed user Stop (pre-C): prefer soft `failed_turn` with open composer **or** treat as needs confirmation — **never** block free-form send; do **not** label pure Stop as “Could not finish”.
4. Else → `null` (ready).

**Additional** queued turns beyond the activity’s `turnId` remain listed in existing `queuedTurns` projection (not collapsed into one activity).

- Prefer **`executing`** over `streaming` as primary state (turn may reason/tools/reconnect without text).
- Terminal success/cancel of a turn lives in **transcript**, not as a sticky task-level “done activity”.
- `uncertain` is **internal** enum; UI copy never says “uncertain”.
- Auto-retry while in flight may set `phase: 'retrying'` on the **same** executing turn presentation; do **not** invent a separate logical-turn grouping layer.

### User-facing labels
| Internal | Label |
|----------|--------|
| `executing` | Working |
| `queued` | Queued (+ wait reason when present, e.g. “Waiting on dependencies”) |
| `waiting_you` | Waiting for you |
| `failed_turn` | Could not finish |
| `uncertain` | Status unclear — continue or run again? |
| `null` | *(no strip; composer feels ready)* |

### Send admission vs promotion
| Gate | Blocks **accept** (persist message+turn)? | Blocks **promote/execute**? |
|------|-------------------------------------------|-----------------------------|
| Invalid input / missing task / store commit fail | Yes | — |
| Hard capacity (`maxTurns` / resource limits) | Yes — **visible reject, keep draft** | — |
| `needs_recovery` / latest failed turn | **No** (Phase B) | No — send creates **continuation** turn |
| Live turn `running` | No — FIFO queue | Yes (one live at a time) |
| `waiting_you` (structured ask) | Engine: No if explicit queue; **UI default**: block free-form Enter | Yes until ask resolved |
| Dependencies / children / external wait | **No** (Phase B opens composer) | **Yes** (scheduler must gate deps + `task.wait`) |
| Held follow-ups after failure (`holdAutoPromote`) | No | Yes until explicit resume |

**Accepted** = durable persist of message + turn, not “agent already running”.

**Capacity promise (normative):** every **valid** send **within configured capacity** sticks. At capacity: NACK / command error + draft preserved. Not an open product question.

### Failure classification
| Class | Meaning | Policy |
|-------|---------|--------|
| `safe_to_retry` | Failed **before** agent could receive `session/prompt` (durable pre-dispatch only) | Silent auto-retry, bounded + backoff; only this uses `maxAutomaticRetries` |
| `confirmed_failed` / `terminal_received` | Terminal prompt error/result **explicitly marked** by adapter after receiving a terminal prompt outcome | Soft `failed_turn`; composer open; “Try again” = explicit |
| `uncertain` | Prompt may have started; connection loss, or **any orphaned live turn after reload** | **No** auto-replay; inline “Continue” vs “Run again” |
| Unclassified error (no terminal marker) | Transport/adapter failure without terminal evidence | Soft `failed_turn` + open composer; **do not** bind session from speculative candidates |

#### Phase B minimal terminal-evidence contract (required for session bind AC)
Full durable pre/post dispatch matrix is **Phase C**. Phase B still needs a **narrow** bind rule so chat does not fork after a known terminal failure:

1. Adapters / run path must tag settlement errors that come from a **received terminal prompt result** as `terminal_received` (or equivalent boolean on settle options).
2. **Only** `terminal_received` + valid observed session id may auto-bind `committedSessionId` on failure (including first turn).
3. Unclassified / transport errors → **no** auto-bind; free-form send still accepted (continuation may `session/new` if unbound).
4. Phase C extends this with durable dispatch markers + orphan→`uncertain`; Phase B does **not** invent full `safe_to_retry` classification yet (existing auto-retry policy may remain until C, but must not claim pre-dispatch safety without markers).

#### Safe auto-retry intent replay (Phase C normative; fix current gap)
Today’s auto-retry often invents instruction text like “Automatic retry after failure…”, which **does not** re-send the user’s original prompt — that fails transparent retry.

**Required for `safe_to_retry` / any silent auto-retry that claims same intent:**
1. Create a new turn with `retryOf` pointing at the failed turn.
2. **Reuse exact original input identities** (same user message id(s) / same projected backend prompt as the original turn) — **no** second user chat bubble, **no** substitute diagnostic-only instruction as the sole prompt.
3. Test: retried backend `prompt` **equals** original turn’s backend prompt (byte-stable projection).

If a retry cannot reconstruct the original prompt, it is **not** silent infrastructure retry — surface soft `failed_turn` instead.

#### Durable uncertainty (reload-safe) — Phase C normative
In-memory runner phase alone is **not** enough after extension host reload.

**Rule (Phase C):**
1. Prefer a **durable dispatch marker** on the turn (or adjacent store field), written **before** the side-effecting `session/prompt` call, cleared/updated on terminal settlement. If marker = not-yet-dispatched and process dies → `safe_to_retry`. If marker = dispatched and no terminal → `uncertain`.
2. **Conservative fallback (required if marker missing or ambiguous):** every **orphaned live** turn on reload → settle as **`uncertain`** (not free auto-retry). Today’s `interrupted` may remain as turn status, but **TurnActivity** and replay eligibility must treat it as requiring confirmation (map to `uncertain` / “Status unclear”) — **except** confirmed user Stop (see interrupt mapping).
3. Classification must feed: `currentTurnActivity`, explicit replay eligibility, `holdAutoPromote` on pre-existing queue, and reload tests.

### Interrupt / Stop mapping (normative)
| Case | Turn status (store) | `currentTurnActivity` when latest + no live/queued | User sees |
|------|---------------------|-----------------------------------------------------|-----------|
| User Stop / confirmed cancel | `interrupted` (or cancelled) with user confidence | **`null`** (ready) | Cancelled result in **transcript** only — **not** “Could not finish” |
| Adapter/tool error failed | `failed` | `failed_turn` | “Could not finish” + open composer |
| Orphan live after reload / ambiguous mid-prompt loss | interrupted/uncertain per C | `uncertain` when classified; else open composer without recovery gate | “Status unclear…” only when classified uncertain |
| Confirmed interrupt with reserved follow-up (interrupt&send) | existing interrupt&send rules | Follow-up becomes activity when promoted | Unchanged cut&continue product |

Add projection test: pure Stop with no follow-up → activity `null`, no recovery chrome.

### Session binding by failure class (normative)
Internal only (never webview wire). Goal: chat continuity after failure when a session was already observed **with terminal evidence**.

| Class | Bind `committedSessionId` from observed session? | Next free-form send |
|-------|--------------------------------------------------|---------------------|
| Success / confirmed interrupt (existing rules) | Yes per current engine rules | `session/load` when committed |
| `terminal_received` / `confirmed_failed` with **valid observed session id** | **Yes bind** if not already committed (including **first turn**) | Continuation uses `session/load` — do **not** silently `session/new` and fork chat |
| Failed **without** terminal_received (unclassified) | **No** auto-bind | May `session/new` if unbound |
| `uncertain` | Do **not** auto-bind from speculative candidates; do **not** auto same-session prompt | User “Continue” / “Run again” may bind under explicit action rules; never silent replay |
| `safe_to_retry` pre-dispatch | Unchanged / no bind from failed attempt | Retry **same original prompt** via `retryOf` + shared input ids |

**Test required:** first-turn confirmed failure (session observed) → free-form send → must resume same conversation identity, not a blank new session.

### After failure — three user actions (distinct)
1. **Free-form send** → new **continuation** turn (not `retryOf`, does not copy prior prompt).
2. **Try again / Run again** → explicit retry/replay of prior intent.
3. **Check and continue** → recovery-style turn: inspect workspace then continue (not blind replay).

Pre-failure queued turns stay **held** (`holdAutoPromote`); UI: “Paused after previous turn” — never “CLI recovery”. Explicit resume only.

### `waiting_you` dual-mode (UI-primary)
- **Primary:** Answer via AskCard.
- Composer default: “Answer above to continue” — free-form Enter **disabled**.
- **Secondary explicit:** “Queue for after answer” enables follow-up composer; that send is a normal queued turn (engine accepts).
- Do **not** treat free-form as the structured answer path.

### Wire / privacy
- Project `currentTurnActivity` from host snapshot.
- **Stop** projecting `committedSessionId` to webview (keep on `MusterTask` only).
- Do **not** project process status / `cliLastExit` as product chrome (debug/dev optional later).
- **Protocol version:** any breaking snapshot shape (drop `committedSessionId`, add `currentTurnActivity`) **must bump mirrored `PROTOCOL_VERSION`** in host + webview and update guards/tests.

### Reconnect mechanism (no `session/resume`)
- Use existing **capability-gated `session/load`** solely for conversation context when `committedSessionId` is set.
- Do **not** plan on ACP `session/resume` (not present in Muster ACP client / init capabilities). Vendor-specific methods only if concrete backend evidence is added later as a separate change.

---

## Phases

### Phase A — Vocabulary cleanup (low effort, low blast)
**Goal:** Stop teaching process model. Preparatory; **not** full target alone.

**Work:**
1. Remove Composer CLI strip + `data-cli-status` product surface.
2. Remove TaskList “CLI running” flags / process live-dot; map to turn activity icons if already available, else lifecycle-only.
3. Rewrite all user-facing copy: no “CLI/process/session id” in workspace, recovery, expand-details.
4. Stop → “Stop this turn”; keep interrupt&send wording.
5. Migrate E2E selectors toward `data-turn-activity` (or temporary neutral activity attrs).
6. Leave engine admission / recovery panel semantics **unchanged** in A if needed for smaller PR — but prefer not to reintroduce CLI words in recovery copy.

**Primary files:**
- `webview/src/lib/cli-status.ts` (deprecate or repurpose → turn activity presentation)
- `webview/src/lib/task-status.ts`
- `webview/src/components/{Composer,TaskList,TaskWorkspace}.svelte`
- `e2e/muster-webview-state.spec.ts`, docs (`WEBVIEW.md`, `TASK-MANAGEMENT.md` UI sections)

**AC:**
- [x] No user-facing string: “CLI running/stopped/idle/not started”, “process”, session id in expanded details.
- [x] Between turns: no “CLI stopped” chrome; ready state = no strip or neutral ready.
- [x] Existing send/recovery **behavior** may still match pre-B (document if so).
  - Phase A keeps engine `needs_recovery` admission block + recovery panel actions; only vocabulary/chrome changed.

---

### Phase B — Minimum shippable target UX (medium effort)
**Goal:** User mental model = task + chat + turn; send after failure works; no recovery-as-CLI ritual; wait states still accept send.

**Work:**
1. **Host projection:** implement `currentTurnActivity` in `src/host/snapshot.ts` using **projection precedence** above; webview consumes only this for chrome (no `hadProcess` / `committedSessionId`).
2. **Protocol:** add `currentTurnActivity` on task summary; drop `committedSessionId` from wire; **bump mirrored `PROTOCOL_VERSION`** (host + webview); update protocol guards/tests. Short dual-read window only if unavoidable during rollout.
3. **Engine admission:** delete `viewStatus === 'needs_recovery'` refuse in `TaskEngine.send` (`engine.ts` ~1061). Free-form send after failed/interrupted + no live/queued → normal FIFO **continuation** turn (same spirit as `continueTask`, not `retryOf`).
4. **Composer admission (critical):** change `runtimeBlocksComposer` so it **does not** block:
   - `needs_recovery`
   - `waiting_dependencies`
   - `waiting_children`
   - external / blocked wait (if represented as runtime activity)
   - Keep **UI-default** free-form block only for structured `waiting_you` (AskCard primary; secondary “Queue for after answer”).
   - Remove `composerReadOnly` for recovery.
5. **UI:** replace workspace `showRecovery` panel with **inline** turn result card (`failed_turn` / later `uncertain`).
6. **`waiting_you`:** AskCard primary + explicit “Queue for after answer”; default free-form blocked in UI only.
7. **Scheduler:** gate promotion on unsatisfied dependencies **and** `task.wait` (children/external) so open composer cannot execute early.
8. **Held queues:** do not auto-thaw pre-failure FIFO; explicit resume actions only; project `waitReason: 'held_after_failure'`.
9. **Session bind (Phase B minimum — terminal evidence only):** when settling a failure tagged `terminal_received` with a valid observed session id, **bind** `committedSessionId` if unbound so continuation send uses `session/load`. Unclassified errors do **not** bind. Uncertain/orphan path still no silent same-session auto-prompt.
10. **Stop projection:** pure user Stop → transcript cancel + `currentTurnActivity: null` (not `failed_turn`).
11. **Docs:** update TASK-MANAGEMENT / WEBVIEW axes: lifecycle + turn activity; deprecate product CLI view section as user-facing.
12. **Build hygiene:** `npm run compile` so `dist/` matches source; Extension Development Host **reload** before UAT (avoid stale CLI chrome from old bundle).

**Primary files:**
- `src/task/{types,derived-status,engine,scheduler,transitions}.ts`
- `src/host/snapshot.ts`, `src/extension.ts` (protocol version)
- `webview/src/lib/{protocol,task-status,thread}.ts` + components
- tests: engine send-after-failure, send-while-deps/children, scheduler wait gate, snapshot projection + waitReason, webview gating, first-turn failure session bind, e2e

**AC:**
- [x] Send after exhausted auto-retry is **accepted**; creates new turn; lifecycle stays `open`.
- [x] Composer open for `needs_recovery`, dependency wait, children wait, external wait; only structured ask default-blocks free-form Enter.
- [x] Send while deps/children/external wait → **accepted**, queued, `waitReason` set, **not** executed early (webview + engine tests).
- [x] No recovery panel / process vocabulary required to continue chatting.
- [x] Free-form during structured ask is not mistaken for answer (AskCard primary).
- [x] Reload-interrupted / orphan live turn does **not** auto-replay.
- [x] First-turn failure with **`terminal_received`** + observed session → next send loads same session (no silent fork).
- [x] Failure **without** terminal marker → no auto-bind; send still accepted.
- [x] Pure user Stop → activity `null`; no “Could not finish” / recovery chrome.
- [x] Webview does not read `committedSessionId` / `hadProcess` for product chrome.
- [x] Host projects `currentTurnActivity` per precedence; composer strip uses it only.
- [x] Protocol version bumped; `npm run compile` + reload verified for UAT path.

---

### Phase C — Resilient delivery + safe reconnect (high effort)
**Goal:** Transient infrastructure failures invisible; recovery UI only for true uncertainty / explicit replay.

**Work:**
1. **Ack + idempotency contract (normative):**
   - Client sends `clientRequestId` on **new-task** and **existing-task** sends.
   - Host persists **receipt + message + turn** (and task create if new-task) in **one atomic store commit**.
   - **Same** `clientRequestId` + **same request fingerprint** (taskId or new-task intent fields, content/agentContent, relevant options) → return original accepted `{ messageId, turnId, taskId }` **without** another commit; **re-send original ACK** if client retries.
   - **Same** `clientRequestId` + **different fingerprint** → **reject** (conflict); do not associate with wrong request.
   - Host responds `sendAccepted` / `sendRejected` after commit decision.
   - Retain receipts for the resend window (webview rehydrate / outbox lifetime).
2. **Webview outbox:** unacked resend with same id after rehydrate (`setState`); clear only on `sendAccepted` or definitive reject.
3. **ACP boundary + durable classification:**
   - Live phases: `pre_dispatch | prompt_outstanding | terminal_received`.
   - Persist dispatch marker **before** `session/prompt` (see durable uncertainty rules).
   - On reload: use marker; if missing/ambiguous → orphan live → `uncertain`.
4. Silent retry **only** durable `safe_to_retry` / pre-dispatch with bounded exponential backoff + jitter; `maxAutomaticRetries` applies **only** here (not all `settleFailed`). **Must** reuse original prompt via `retryOf` + original input ids (see safe-retry intent replay).
5. `prompt_outstanding` loss → persist `uncertain`; never auto-replay.
6. Reconnect context via capability-gated **`session/load` only** (no `session/resume` in this plan).
7. Present in-flight auto-retry as `executing.phase: 'retrying'` if useful — **no** multi-turn logical grouping model.
8. Recovery UI residual: only `uncertain` + explicit “Run again”.

**Primary files:**
- `src/backends/acp-client.ts`, `acp-run.ts`, engine settlement
- store receipts + protocol + webview outbox
- transitions `applyFailedTurn` classification branch

**AC:**
- [x] Same id + same fingerprint → single message/turn; duplicate delivery re-ACKs original ids.
- [x] Same id + different payload → reject/conflict.
- [x] New-task and existing-task sends both covered by receipts.
- [x] Agent die before durable dispatch → auto reconnect/retry without user recovery; **backend prompt equals original**.
- [x] Agent die after possible dispatch / orphan reload → `uncertain`, no silent replay.
- [x] Store failure → NACK; composer keeps draft. *(via sendRejected / commandError; draft remains until user clears)*
- [x] Capacity reject → NACK; draft kept.
- [x] User-facing recovery only for uncertainty / explicit replay choice. *(uncertain activity projection; soft failed_turn for other classes)*

---

## Implementation order (recommended)
1. Characterization tests: lifecycle independence, persist-before-spawn, reload no-replay, FIFO queue, current needs_recovery + wait-state composer blocks (document baseline).
2. **Phase A** vocabulary cleanup.
3. Host `TurnActivity` projection (precedence + waitReason) + webview consume; **protocol version bump**.
4. Remove recovery + **all wait-state admission blocks** (except waiting_you UI default) + continuation send (core B).
5. Scheduler deps + `task.wait` gates + held-queue UX + session bind on confirmed_failed.
6. Inline turn-result card; delete recovery panel.
7. `npm run compile` + Extension Development Host reload smoke.
8. **Phase C** durable classification + ack/dedupe + load-only reconnect.
9. Full regression + e2e on turn-activity selectors.

## Cross-plan coordination
- **Interrupt & send** plan can land in parallel; Stop / Ctrl+Enter remain turn-level, not process-level.
- Do not reintroduce concurrent live-inject product path.
- Both plans: after wire/host changes, **compile + reload** before UAT (stale `dist` is a known failure mode).

## Test matrix (must pass before calling target done)
| Scenario | Expect |
|----------|--------|
| Send while turn executing | Accept → queued; activity shows Working + queue |
| Send after failed turn (retries exhausted) | Accept → new turn; no recovery gate |
| Send while waiting_dependencies | Accept → queued, `waitReason: dependencies`, not promoted |
| Send while waiting_children / external | Accept → queued, matching waitReason, not promoted |
| Agent crash before durable dispatch | Phase C: silent retry; B: soft failed_turn + open composer |
| Agent crash mid-prompt / reload live | `uncertain` (or interrupted mapped to confirmation); no silent replay |
| Structured ask pending + Enter | Blocked unless “Queue for after answer” |
| First-turn `terminal_received` failure + observed session + send | Continuation uses same session (`session/load`), not new blank session |
| Unclassified failure + observed candidate session | No auto-bind |
| Pure user Stop, no follow-up | Activity null; cancelled in transcript only |
| Safe auto-retry (C) | Same original backend prompt; no extra user bubble |
| Duplicate clientRequestId same fingerprint (C) | One turn; re-ACK |
| Duplicate clientRequestId different payload (C) | Reject |
| Hard maxTurns | Reject visible; draft kept |
| Lifecycle after process death | Still `open` unless user/coordinator seals |
| UI grep | No product “CLI/process/session id” chrome |
| Protocol / dist | Version bump; compiled host matches webview |

## Open product nits (non-blocking)
- Exact copy/placement of “Queue for after answer”.
- Whether continuation prompt includes prior-turn reference text in B vs session context alone.
- Resume held queue: one-by-one vs “Resume remaining queue” (both explicit).

## Success definition (end state)
> User chats on a task. Valid messages within capacity stick. Turns show Working / Waiting for you / Could not finish / clear result in chat. No CLI status strip, no session ids, no “recover the CLI”. Engine owns process, session (`session/load`), and safe pre-dispatch retries. Uncertain / orphaned work never silently re-runs. Capacity and conflicts fail visibly with draft preserved.

## Confidence
**High** on architecture and phase split (peer debate + plan-review fixes). Residual risk: ACP backends differ on proving pre- vs post-dispatch without durable markers — mitigated by conservative orphan→uncertain rule.
