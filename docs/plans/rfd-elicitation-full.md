# Plan: Full ACP RFD Elicitation Support

## Goal

Implement the full [ACP RFD Elicitation](https://agentclientprotocol.com/rfds/elicitation.md) surface in Muster so agents can request structured user input via `elicitation/create`, with correct capability negotiation, form + URL modes, three-action responses, URL completion, and `-32042` URL-required error handling. Vendor-specific ask paths (Grok `x.ai/ask_user_question`) remain adapters into the same UI layer.

**Out of scope for this plan:** re-enabling MCP `muster_bridge.ask_user` (stays disabled); inventing non-RFD ACP methods; gold-plating accessibility/keyboard beyond existing webview patterns.

## Current state (baseline)

| Piece | Status |
|-------|--------|
| Cap `elicitation.form` | Advertised in `DEFAULT_CLIENT_CAPABILITIES` |
| Cap `elicitation.url` | Not advertised |
| `elicitation/create` form | Partial: maps schema → `Question[]` → AskCard only |
| `elicitation/create` url | Hard-declines |
| Response actions | `accept` + `cancel` only (no explicit `decline`) |
| `elicitation/complete` | Ignored |
| `-32042` URLElicitationRequiredError | Not handled |
| request-scoped (`requestId`) | Not handled |
| Full restricted JSON Schema UI | Missing (number/bool/multi-field/validation) |
| Grok `x.ai/ask_user_question` | Wired (keep as vendor adapter) |
| MCP `ask_user` | Disabled (keep disabled) |
| Webview pending replay | Event-only; drop if no view; single permission/ask overlay patterns |

## Architecture

```
Agent → elicitation/create
          ├─ mode: url  → UrlElicitationCard (consent) → accept|decline|cancel
          │                 accept = consent only; move to OOB map by wire elicitationId
          │              → later: elicitation/complete (agent→client) clears OOB entry
          └─ mode: form → parse restricted JSON Schema (or -32602 if invalid)
                           ├─ ask-like → AskCard (3 actions + multiSelect)
                           └─ generic  → ElicitationFormCard
                        → accept(content)|decline|cancel

Agent JSON-RPC error -32042 (URLElicitationRequiredError)
  → data.elicitations[] → same URL consent + OOB completion lifecycle
  → after complete: minimal retry of original request (or surface manual retry)

Vendor: x.ai/ask_user_question → normalize → AskCard → encode Grok outcome
```

**IDs:**
- **`promptId`**: client-generated UUID assigned **only by the bridge** when registering a pending prompt (not by the pure wire parser).
- **JSON-RPC request/response `id`**: kept only inside ACP response closure (never as webview key). Type for RFD `requestId` scope field: `string | number`.
- **Wire `elicitationId`**: URL mode / `-32042` only.
- **OOB completion key**: `(clientKey, elicitationId)` where `clientKey` is the stable ACP client/backend connection id (e.g. agent config `key` / shared client instance id). Never key OOB by bare `elicitationId` alone.

**Principle:** Protocol layer handles *all* RFD modes/actions. UI layer splits by shape (URL / ask-like form / generic form).

## Goals / acceptance criteria

1. **Capabilities:** Advertise `elicitation: { form: {}, url: {} }` on `initialize`.
2. **Form mode:** Full restricted schema support — string (+ formats `email|uri|date|date-time`, minLength/maxLength/pattern), number/integer (min/max), boolean, single-select enum (`enum` or `oneOf`), multi-select array (`minItems`/`maxItems`), multi-field, defaults, required. Malformed/unsupported schema → JSON-RPC `-32602`.
3. **Ask-like subset:** Detect ask-like forms; render AskCard with **Accept / Decline / Dismiss**, multi-select checkboxes when `multiSelect`/array schema.
4. **URL mode:** Consent UI with full URL; open only after explicit accept; `accept`/`decline`/`cancel`; never auto-open or pre-fetch.
5. **Three actions:** Wire `accept` / `decline` / `cancel` for form, ask-like, and URL.
6. **`elicitation/complete`:** After URL accept, track OOB by wire `elicitationId`; on complete, clear waiting UI; ignore unknown ids.
7. **`-32042`:** Detect URLElicitationRequiredError on client→agent responses; run same URL lifecycle; after complete, retry original request once (or show manual retry if retry unsafe).
8. **Scopes:** Exactly one of session scope (`sessionId` ± `toolCallId`) or request scope (`requestId`); reject ambiguous params with `-32602`.
9. **Pending durability:** Host holds `Map<promptId, pending>` (multi); replay all pending on webview init/snapshot; concurrent prompts supported.
10. **Lifecycle:** Soft prompt outcomes (accept/decline/dismiss/timeout) clear that prompt and resume `waiting_user` only when the per-turn wait-token set is empty and the turn is still `waiting_user`. Hard paths (turn cancel/backend exit/deactivate) clear tokens and pending prompts **without** reviving a terminal turn.
11. **Grok adapter:** Unchanged wire; maps into AskCard with 3-action UI; Grok encoder maps decline/cancel → `cancelled`.
12. **MCP ask_user:** Remains disabled.
13. **Tests/verification:** Unit + bridge + engine lifecycle; `check:svelte`, `build:webview`, vitest, Playwright form-submit smoke mandatory.

## Implementation plan

### Phase 1 — Protocol model (host pure types + parsers)

**Files:** `src/backends/elicitation.ts` (new pure module), re-export from `acp-client.ts` as needed.

1. **Two type layers (ISSUE-3 sequencing):**
   - **Wire-parsed (no promptId):**
     - `ParsedFormElicitation`: sessionId? | requestId? (`string | number`), toolCallId?, message, fields, required[]
     - `ParsedUrlElicitation`: sessionId? | requestId?, elicitationId, url, message
     - `ParsedUrlRequiredEntry`: mode url, elicitationId, url, message (**no** session/request scope — parent failed request owns scope)
   - **Bridge pending (promptId assigned at register):**
     - `PendingFormPrompt` / `PendingUrlConsent` = parsed + `{ promptId, clientKey }`
   - Shared: `ElicitationAction`, `ElicitationField` (+ full constraints), `ElicitationResolve`

2. Pure functions:
   - `parseElicitationCreate(params)` → ParsedForm | ParsedUrl | error(-32602)
     - Require **exactly one** create-scope: sessionId XOR requestId; toolCallId only with sessionId
     - URL requires non-empty elicitationId + valid URL string
   - `parseUrlElicitationRequiredEntries(errorData)` → ParsedUrlRequiredEntry[] | invalid
     - Does **not** apply create-scope invariant; parent request supplies association
   - `isAskLikeForm`, `formToAgentQuestions`, `encodeFormContent`, `validateFormValues`
   - Keep Grok normalize/encode helpers

3. Unit tests: RFD form/url create examples; -32042 entry parse; dual-scope rejection; missing elicitationId; constraint classes.

### Phase 2 — ACP client routing

**Files:** `src/backends/acp-client.ts`

1. Cap: `elicitation: { form: {}, url: {} }`.
2. `handleElicitationCreate`:
   - Parse → error `-32602` if invalid
   - URL → controller.promptUrl (returns action only for consent)
   - Form → controller.promptForm (ask-like or generic)
   - Map to wire `{ action, content? }`
3. Notification `elicitation/complete` (no id): `controller.onUrlComplete(clientKey, elicitationId)` — connection-scoped.
4. **`-32042` URLElicitationRequiredError (ISSUE-4):**
   - On client→agent **response** error with code `-32042` and valid `data.elicitations`:
     - Parse via `parseUrlElicitationRequiredEntries` (no create-scope fields required)
     - Associate entries with the **originating pending client request** (method, params, resolve/reject)
     - Run same URL consent + OOB completion lifecycle under that parent
   - Terminal behavior for the parent request:
     - **All** required URL elicitations **complete** → single retry of original request
     - **Any** decline / cancel / timeout → reject parent with original error (or clear message); clear remaining sibling prompts for that parent
   - Invalid `-32042` payload → treat as ordinary error (no consent UI)
5. Grok path separate; AskCard 3-action → Grok `accepted`/`cancelled`.

### Phase 3 — Host controller + bridge

**Files:** `src/bridge/elicitation-bridge.ts`, `src/extension.ts`

1. **Two URL maps (ISSUE-1) + clientKey (ISSUE-9):**
   - `pendingPrompts: Map<promptId, Pending>` — unresolved form or URL **consent**
   - `oobUrls: Map<\`${clientKey}:${elicitationId}\`, OobEntry>` — after URL **accept**, until complete/cancel/shutdown
   - Every `OobEntry` **retains the original `promptId`** from consent (webview always keys by promptId)
   - Consent accept: resolve ACP create (or mark -32042 sibling accepted), clear consent card, **move** to `oobUrls`, post `elicitationUrlWaiting { promptId, elicitationId, message? }`
   - `complete(clientKey, elicitationId)`: look up OOB, post `elicitationCleared { promptId }` (required promptId), remove OOB

2. **Form / ask-like — single owner (ISSUE-2):**
   - **RFD form (incl. ask-like):** only `ElicitationBridge` registers pending + emits `elicitationFormPending` (askLike flag). **Do not** call `AskBridge.register` / `registerAgentAsk` for RFD.
   - Engine API for ask-like + live session: `markTurnWaitingUser(sessionId|turnId)` / `resumeTurnFromElicitation(turnId, action)` — status only, **no** AskBridge entry.
   - **Grok vendor path only:** may keep AskBridge + `askPending` (separate from RFD).

3. **Lifecycle:**
   - Timeout → action `cancel` + soft end wait token
   - `cancelAll` on deactivate: hard-clear wait tokens + resolve pending prompts cancel (no turn revive)
   - Turn cancel / backend exit: hard-clear wait tokens + cancel pending prompts for that turn/session
   - Soft end only resumes when still `waiting_user` and no tokens remain

4. **Webview delivery (ISSUE-5):**
   - Host `Map` of active pending overlays by promptId
   - On webview resolve / snapshot / visibility: **replay all** pending form/url (+ OOB waiting) messages
   - Multi-prompt UI (array), not single overwrite

5. Handlers: `submitElicitation` { promptId, action, content? }; validate content server-side before accept; openExternal only after URL accept.

### Phase 4 — Webview protocol + UI

**Files:** `webview/src/lib/protocol.ts`, `App.svelte`, components, pure validators.

1. ExtMessages (webview keys **only by promptId** — never bare elicitationId):
   - `elicitationFormPending` { promptId, sessionId?, toolCallId?, message, fields, required, askLike? }
   - `elicitationUrlPending` { promptId, elicitationId, sessionId?, url, message }
   - `elicitationUrlWaiting` { **promptId**, elicitationId, message? } // post-consent OOB; promptId required
   - `elicitationCleared` { **promptId** } // promptId required
2. OutMessages: `submitElicitation` { promptId, action, content? }
3. Components:
   - **AskCard** extended: Accept / Decline / Dismiss; multi-select checkboxes when multiSelect
   - **ElicitationFormCard**: full field types + client validation
   - **ElicitationUrlCard**: full URL, consent buttons
4. State: `Map`/`array` of pending elicitations; snapshot hydration; global overlay for request-scoped
5. Pure `webview/src/lib/elicitation-form.ts` validators (mirror host constraints)

### Phase 5 — Engine integration

**Files:** `src/task/engine.ts`

1. New thin APIs (no AskBridge) with **per-turn wait tokens**:
   - `beginElicitationWait(sessionId|turnId, promptId)` → if live turn, ensure status `waiting_user`, add `promptId` to per-turn active set
   - **Soft release** `endElicitationWait(turnId, promptId)` (accept/decline/dismiss/timeout of that prompt):
     - remove token; **if set empty AND turn still `waiting_user`**, resume to `running`
     - if turn already terminal/cancelled/failed/interrupted → no-op (do not revive)
   - **Hard clear** `dropElicitationWaits(turnId)` (turn cancel, backend exit, deactivate):
     - clear entire token set **without** resuming; turn transition already owned by cancel/fail path
2. RFD ask-like: begin on register; soft end on prompt terminal actions; hard clear on turn/backend/deactivate.
3. Generic form / URL: bridge-only by default; optional begin/end with same soft/hard rules.
4. Tests: two concurrent soft ends (either order → one resume); hard clear leaves cancelled turn terminal; soft end no-op if already cancelled.
5. Grok continues using existing `registerAgentAsk` / `submitAskAnswer` / `cancelAskTurn`.

### Phase 6 — Tests & verification (mandatory)

1. Unit: parsers, encoders, ask-like, constraints, formats, minItems/maxItems, dual-scope, -32602, parseUrlElicitationRequiredEntries.
2. Bridge: multi pending, timeout, OOB complete after accept (promptId-stable clear), cancelAll, replay list.
3. Engine: wait-token refcount; concurrent two prompts; cancel clears both.
4. **ACP client -32042 orchestration (ISSUE-4):**
   - complete-all → exactly one retry
   - decline/cancel/timeout → reject parent + clear siblings
   - invalid payload → ordinary error
   - second -32042 after retry → no infinite retry loop (fail closed)
5. Grok regression.
6. **Always run:** `npm run check:svelte`, webview build, targeted vitest, Playwright form-submit smoke.
7. Host `tsc --noEmit`.

## File touch list (expected)

| Area | Files |
|------|--------|
| Pure protocol | `src/backends/elicitation.ts`, `elicitation.test.ts` |
| ACP client | `src/backends/acp-client.ts`, `acp-client.test.ts` |
| Bridge | `src/bridge/elicitation-bridge.ts`, `elicitation-bridge.test.ts` |
| Host | `src/extension.ts` |
| Engine | `src/task/engine.ts` |
| Webview | `protocol.ts`, `App.svelte`, `TaskWorkspace.svelte`, `AskCard.svelte`, `ElicitationFormCard.svelte`, `ElicitationUrlCard.svelte`, `elicitation-form.ts` (+ tests) |
| e2e | extend `e2e/muster-webview-state.spec.ts` form submit smoke |

## Non-goals / explicit declines

- Do not auto-allow URL mode without user consent.
- Do not put secrets into form mode (RFD security note).
- Do not reintroduce MCP ask_user in this plan.
- Do not implement nested/complex JSON Schema (RFD forbids).
- Do not merge permission gate into elicitation.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Claude schema shapes drift | Fixtures from vendored claude-agent-acp; tolerant ask-like detector |
| Request-scoped before view open | Host map + replay on webview init |
| URL open security | Full URL display; openExternal only after accept |
| Double UI | RFD → only elicitationFormPending; Grok → only askPending |
| -32042 retry safety | Retry only after all completes; decline/cancel aborts parent |
| Timeout vs waiting_user | Soft endElicitationWait on prompt outcomes; hard dropElicitationWaits on turn cancel/exit/deactivate |
| Cross-agent elicitationId clash | OOB key includes clientKey |

## Implementation order

1. Phase 1 pure module + tests  
2. Phase 2 acp-client routing + caps + -32042 hook  
3. Phase 3 bridge + extension wire + replay  
4. Phase 4 webview UI (AskCard 3-action first)  
5. Phase 5 engine lifecycle glue  
6. Phase 6 full verification  

## Done when

- Acceptance criteria 1–13 pass.
- Grok ask still works.
- Claude AskUserQuestion works with form cap (incl. multiSelect).
- URL mode consent + complete; -32042 path works or is explicitly tested with fixtures.
- MCP ask_user still disabled.
- Mandatory svelte/webview/playwright checks green.
