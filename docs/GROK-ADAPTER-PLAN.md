# Grok Backend Adapter — Implementation Plan

Target: add a **Grok "Build" CLI** backend to Muster that implements the `Backend`
contract (`src/types.ts`, `docs/ADAPTER-SPEC.md`), mirroring `ClaudeBackend`, plus the
minimal wiring needed to actually select it from the chat UI.

> **Handoff note:** this plan is written to be implemented by Grok. Follow the
> `Backend` contract exactly and honor the ADAPTER-SPEC invariants (one terminal
> event per run, `sessionStarted` semantics, `raw` policy). Verify the two flagged
> items (`--session-id` acceptance, `stopReason` values) with a quick probe before
> finalizing the parser.

---

## 1. Scope

**In scope**
1. `src/backends/grok.ts` — the adapter (the core deliverable).
2. Backend selection wiring so the user can pick Grok:
   - a backend factory,
   - per-backend session-id keying,
   - enable the webview backend picker + carry `backend` on the `send` message.
3. `scripts/test-grok.ts` + `mvp:grok` npm script (console harness, no UI needed).

**Out of scope (defer, and say so in the review)**
- MCP injection for Grok (no per-invocation flag; matches current state — Claude MCP
  isn't wired into the chat provider either).
- Detailed tool events (**not available** in headless `streaming-json` — see §3).
- ACP mode (`grok agent stdio`) — violates the per-turn-spawn principle (DESIGN §2.1).
- Full ReasoningBlock UI (Grok *does* emit reasoning — see §8 for the decision).

---

## 2. Verified environment facts (grok 0.2.87, this machine, 2026-07-06)

- **Auth:** `~/.grok/auth.json` present → runs without `XAI_API_KEY`.
- **Headless:** `grok -p "<prompt>" --output-format streaming-json`.
- **Relevant flags** (from `grok --help`):
  - `-p, --single <PROMPT>` — single-turn, prints to stdout, exits.
  - `--output-format <plain|json|streaming-json>` (default `plain`).
  - `-r, --resume [<SESSION_ID>]`, `-c, --continue`, `--fork-session`.
  - `-s, --session-id <SESSION_ID>` (new conversations; pre-assign an id).
  - `--permission-mode <default|acceptEdits|auto|dontAsk|bypassPermissions|plan>`,
    `--allow/--deny/--always-approve`.
  - `--sandbox <PROFILE>` (env `GROK_SANDBOX`), `--cwd <CWD>`, `--model`,
    `--effort <low|medium|high|xhigh|max>`, `--reasoning-effort`, `--max-turns <N>`,
    `--disable-web-search`.
- **MCP:** no per-invocation config flag (file-based `.mcp.json` in cwd or `grok mcp add`).

---

## 3. Headless `streaming-json` event shapes — EMPIRICALLY CAPTURED

Two live probes were run (a pure-text turn and a tool-requesting turn). **Only three
event types were observed in both**, NDJSON, one JSON object per line:

```jsonl
{"type":"thought","data":"The"}                 // reasoning, token-by-token
{"type":"text","data":"hello"}                  // assistant answer, token-by-token
{"type":"end","stopReason":"EndTurn","sessionId":"019f3646-f4f1-7191-9014-889d87a40a66","requestId":"90a8d14b-..."}
```

Findings that drive the design:
- **`thought` = reasoning deltas**, **`text` = assistant deltas** (both are token
  chunks in `data`; concatenate to reconstruct full strings — verified: `text` chunks
  assembled to `"hello world"`).
- **`end` is the only terminal marker** and is the **only** place `sessionId` appears —
  i.e. the session id is revealed **at the end of the turn, after content** (unlike
  Claude, which reveals it in an init event first).
- **No structured tool events.** The tool-requesting probe (`--permission-mode
  bypassPermissions`, "list files then reply DONE") produced **54 `thought` + 1 `text`
  + 1 `end`** and *zero* tool/command/file-change events. Tool execution, if any, is
  internal to Grok in headless `streaming-json`. → `supportsDetailedToolEvents: false`.

---

## 4. Capabilities

```ts
readonly capabilities: BackendCapabilities = {
  supportsReasoning: true,          // Grok emits `thought` deltas (richer than Claude)
  supportsDetailedToolEvents: false,// no tool_call events in headless streaming-json
  supportsMCP: false,               // deferred (no per-invocation flag) — see §1
};
```

---

## 5. Event mapping (Grok → NormalizedEvent)

**Terminal events (`turnCompleted` / `error`) are NOT emitted from stream parsing.**
Parsing only yields non-terminal events and records state; the process-close logic in §9
is the **sole** emitter of the single terminal event (ISSUE-1). This mirrors
`ClaudeBackend`, where the loop yields content and the terminal is decided after close.

Per-line stream mapping:

| Grok `streaming-json` line                    | Action |
|-----------------------------------------------|--------|
| `{type:"thought", data:string}`               | yield `{ type:'reasoningDelta', content: data, messageId }` |
| `{type:"text", data:string}`                  | yield `{ type:'assistantDelta', content: data, messageId }` |
| `{type:"end", stopReason, sessionId}`         | record `endSeen=true, stopReason, endSessionId` — **do NOT emit a terminal event here** |
| valid JSON with unknown `type`, OR a known type whose `data` is missing/not a string | yield `{ type:'raw', line }` (ISSUE-7) |
| line that fails `JSON.parse`                  | yield `{ type:'raw', line }` |
| stderr (non-empty)                            | buffer; after stream close, yield each as `{ type:'raw', line:'[stderr] ' + l }` |

Rules:
- **`messageId`**: one `randomUUID()` per `run()`, shared by reasoning + text (mirrors Claude).
- **Every line is accounted for**: a recognized non-terminal event, the recorded `end`,
  or `raw`. No valid-JSON line is silently dropped (ADAPTER-SPEC `raw` policy — this is
  what preserves diagnostics when Grok's schema changes).
- **`stopReason` and all terminal decisions** are resolved once, after close, in §9.

---

## 6. Session-id strategy (the key design decision)

**Problem:** Grok reveals `sessionId` only in the `end` event (after content), but
ADAPTER-SPEC wants `sessionStarted` emitted *before* content.

**Recommended — pre-assign the id for new sessions** (ADAPTER-SPEC explicitly blesses
this: "if the CLI supports passing an explicit ID at creation time … pre-generate a
UUID and pass it in"):

- **New session** (`!resumeId`): `const sid = randomUUID();` pass `--session-id ${sid}`;
  emit `{ type:'sessionStarted', sessionId: sid }` **before** reading the stream.
- **Resume** (`resumeId`): pass `--resume ${resumeId}`; emit
  `{ type:'sessionStarted', sessionId: resumeId }` immediately.
- **Cross-check**: when the `end` event arrives, compare its `sessionId` with the id we
  used. If they differ, emit a diagnostic `raw` line — do **not** emit a second
  `sessionStarted` (spec: at most one per run).
- Also implement `extractSessionId(rawOutput)` as a post-turn fallback: match the last
  `"sessionId":"<uuid>"` in the raw output.
- **Persistence is success-only (ISSUE-2):** emitting `sessionStarted` early is a UI /
  identity signal, NOT a commit to the store. The coordinator must **stage** the id and
  write it to `.muster-sessions.json` + in-memory state **only after this run's
  `turnCompleted`** (see §7.4 and SESSION-MANAGEMENT.md: *"committed only after a
  successful turn"*). This stops a cancelled / failed / spawn-failed new turn from
  poisoning the stored session with an id Grok may never have created.

**⚠️ Verify before committing to this path:** does Grok honor a **v4** UUID via
`--session-id` for a new session? (Auto-generated ids are v7.) Quick probe:

```bash
sid=$(uuidgen | tr 'A-Z' 'a-z')
grok -p "hi" --output-format streaming-json --session-id "$sid" | tail -1
# PASS if the end event's sessionId === "$sid"
```

- **If honored** → use the recommended strategy (early `sessionStarted`, clean identity).
- **If NOT honored** (Grok ignores/rejects it) → **fallback**: don't pass `--session-id`;
  capture `sessionId` from the `end` event and emit `sessionStarted` there (the spec
  permits this when the id is only known at end), and rely on `extractSessionId`.
  Document which path was taken in a code comment.

The coordinator stores this id and passes it back as `resumeId` next turn (see §7.4).

---

## 7. Wiring (so Grok is actually selectable)

Small, mechanical changes. Keep the shared `Backend`/`RunOptions` contract unchanged
(Phase-1 principle).

### 7.1 Backend factory — `src/backends/index.ts` (new)
```ts
import { Backend } from '../types';
import { ClaudeBackend } from './claude';
import { GrokBackend } from './grok';

export const BACKEND_IDS = ['claude', 'grok'] as const;
export type BackendId = typeof BACKEND_IDS[number];

export function makeBackend(name: string): Backend {
  switch (name) {
    case 'grok': return new GrokBackend();
    case 'claude':
    default: return new ClaudeBackend();
  }
}
```

### 7.2 Protocol — carry the selected backend on `send`
- `webview/src/lib/protocol.ts`: `OutMessage` `send` gains `backend?: string`:
  `{ type: 'send'; text: string; backend?: string; continueLast?: boolean }`.
- Extension inbound handler reads `data.backend` (default `'claude'`).

### 7.3 `src/extension.ts`
- Replace `const backend = new ClaudeBackend();` in `_handleSend` with
  `const backend = makeBackend(backendName);` where `backendName` comes from the `send`
  message. Pass it through: `_handleSend(text, backendName, webview)`.
- **Pass the workspace cwd (ISSUE-3):** `_handleSend` currently builds `{ prompt, signal }`
  and never sets `cwd`, so the backend falls back to the extension-host `process.cwd()`
  (wrong directory). Set `options.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath`
  — the same root used for session persistence — and omit it when no workspace is open
  (adapter then falls back to `process.cwd()`). Required for Grok Build to operate on the
  user's repo; benefits Claude too.
- `turnStart` already carries `backend: backend.name` — no change needed there.
- The `muster.sendToClaude` quick command may stay Claude-only (leave as-is).

### 7.4 Per-backend session keying + success-only commit
`.muster-sessions.json` is already an object keyed by backend name, but the provider
hardcodes the `'claude'` key and keeps single module-level `lastSessionId` /
`suppressFileResume`. Change to per-backend **and** commit-on-success:
- `_loadSessionId(backend)` / `_saveSessionId(backend, id)` — key by `backend`.
- Replace `lastSessionId` / `suppressFileResume` with a per-backend record/Map:
  `Map<string, { lastSessionId?: string; suppressFileResume?: boolean }>`.
- **Success-only commit (ISSUE-2 / SESSION-MANAGEMENT.md):** do NOT persist on
  `sessionStarted`. In `_handleSend`, keep a local `stagedSessionId` for this run, updated
  from `sessionStarted.sessionId`. Commit it to the per-backend in-memory `lastSessionId`
  **and** the file **only when this run emits `turnCompleted`** and is still current
  (`this._currentRun?.runId === runId`). On `error` / cancellation / thrown failure,
  discard `stagedSessionId` and keep the previous stored value. This supersedes the
  impl-review ISSUE-1 "persist during the loop" approach while keeping its currency guard.
- **Backend-specific New Session (ISSUE-4):** add `backend` to the `newSession`
  `OutMessage`; `newSession` clears/suppresses **only that backend's** entry — never
  reset-all, which would wipe Claude's resumable session when the user only reset Grok
  (a Claude regression). The webview sends the selected backend (`thread.backend`).

### 7.5 Webview picker + send payload — Toolbar & Composer
- **Selection state:** reuse the existing `thread.backend` rune —
  `turn-state.svelte.ts` already declares `backend = $state('claude')`. No new store.
- **Toolbar** (`Toolbar.svelte`): remove `disabled`, add the Grok option, bind to
  `thread.backend`, and disable while a turn runs:
  ```html
  <vscode-single-select value={thread.backend} title="Backend"
    disabled={thread.running}
    onchange={(e) => (thread.backend = (e.target as HTMLSelectElement).value)}>
    <vscode-option value="claude">Claude</vscode-option>
    <vscode-option value="grok">Grok</vscode-option>
  </vscode-single-select>
  ```
  ⚠️ Verify the vscode-elements single-select change event (`onchange` + `e.target.value`
  vs a custom event / `.value` getter) and adjust the handler accordingly.
- **Composer** (`Composer.svelte`, ISSUE-8): it OWNS the `send` payload —
  currently `post({ type:'send', text: value })`. Add the selected backend:
  `post({ type:'send', text: value, backend: thread.backend })`. (Optional: make the
  hardcoded "Message Claude…" placeholder reflect `thread.backend`.)
- **New Session** (`Toolbar.svelte`): send the active backend —
  `post({ type:'newSession', backend: thread.backend })` (ISSUE-4).

---

## 8. Reasoning rendering (webview) — DECIDED: option B (defer the UI)

Grok emits `reasoningDelta` (Claude does not). **Decision: the adapter emits
`reasoningDelta` unconditionally; the webview keeps ignoring it for now.** This is already
safe — `turn-state.svelte.ts` `applyEvent` explicitly lists `reasoningDelta` in its
intentional no-op group (`case 'reasoningDelta': ... break;`). So **no webview change is
required** for this task: the handoff stays deterministic and the minimal-adapter target
adds zero webview regression surface. A ReasoningBlock UI remains a later WEBVIEW.md phase
(out of scope here). The adapter emitting the event now means that later UI work needs no
adapter rework.

---

## 9. Process lifecycle & cancellation — single terminal emitter

Mirrors `ClaudeBackend` but fixes terminal ownership (ISSUE-1) and failure gaps (ISSUE-5).

Setup:
- `spawn('grok', args, { cwd: options.cwd || process.cwd(), env: {...process.env,
  ...options.extraEnv}, stdio: ['ignore','pipe','pipe'] })`.
- **Immediately after `spawn` — before readline and abort setup — establish the
  completion promise** so a fast `close`/`error` can never fire before its listeners are
  attached (ISSUE-5). The `error` handler records the spawn failure AND resolves; `close`
  resolves with the exit code:
  ```ts
  let spawnError: Error | undefined;
  const closed = new Promise<number | null>((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', (e) => { spawnError = e; resolve(null); });
  });
  ```
- Abort handling, including a **pre-aborted** signal (ISSUE-5):
  ```ts
  let cancelled = false;
  const onAbort = () => { cancelled = true; child.kill('SIGTERM'); };
  options.signal?.addEventListener('abort', onAbort);
  if (options.signal?.aborted) onAbort();     // signal already aborted before we attached
  ```
  Remove the listener in `finally`.
- `readline` over stdout; parse per §5 (records `end`; yields deltas / `raw`). Break on `cancelled`.
- Buffer stderr; flush as `[stderr] …` `raw` lines after the loop.

Await the **pre-established** promise after stream processing — its `close`/`error`
listeners were attached at spawn time, so a fast exit or a cancellation-kill cannot settle
the child before we are listening (ISSUE-5):
```ts
const exitCode = await closed;
```

**Exactly one terminal event, decided after close, in this priority (ISSUE-1):**
1. `cancelled || options.signal?.aborted` → `{ type:'error', message:'Turn cancelled', isCancellation:true }`
2. `spawnError` → `{ type:'error', message:'Failed to start grok: ' + spawnError.message }`
3. `exitCode` non-null and `!== 0` → `{ type:'error', message:'Grok exited with code ' + exitCode }`
4. `!endSeen` → `{ type:'error', message:'Grok stream ended without an end event' }` (incomplete)
5. failure `stopReason` (see below) → `{ type:'error', message:'Grok stopped: ' + stopReason }`
6. otherwise → (if using the §6 *fallback* session strategy, emit `sessionStarted` from
   `endSessionId` here) → `{ type:'turnCompleted', meta:{ stopReason } }`

`end` parsing (§5) never emits a terminal event, and nothing is emitted after the terminal
one — this is what guarantees the ADAPTER-SPEC exactly-one-terminal invariant.

**`stopReason`:** only `EndTurn` observed. Treat `EndTurn` as success; **verify the value
space** (§13) and map any clear-failure reasons (e.g. `Error`/`Refusal`) to step 5. Until
verified, non-`EndTurn` reasons are carried in `meta.stopReason` and the raw `end` line is
also emitted as `raw` if the reason is unrecognized.

**Known limitation (document, same as Claude):** `child.kill('SIGTERM')` may orphan Grok's
tool subprocesses; kill-process-group (detached spawn + `kill(-pid)`, cf.
`codex-runner.js killTree`) is future hardening, not MVP.

### Args builder (reference)
```ts
const messageId = randomUUID();
const args = ['-p', options.prompt, '--output-format', 'streaming-json',
              '--permission-mode', GROK_PERMISSION_MODE];
if (options.resumeId) args.push('--resume', options.resumeId);
else args.push('--session-id', newSid);   // pending §6 + §10 verification
```

---

## 10. Permission strategy — verify, don't assume (ISSUE-6)

Headless has no interactive prompt; without a policy, tool turns stall or are denied. The
§3 tool probe used `bypassPermissions`, so a *less*-permissive mode completing
noninteractively is **unverified** — do not assume `acceptEdits` "avoids stalls".

**Required probe (implementer runs before fixing the constant).** In a disposable temp
workspace, stdin from `/dev/null`, run a turn that does BOTH a file edit and a shell
command, trying modes least→most permissive
(`default` → `acceptEdits` → `auto` → `dontAsk` → `bypassPermissions`):
```bash
d=$(mktemp -d); printf 'x\n' > "$d/f.txt"
grok -p "Edit f.txt to contain the word hello, then run 'ls' and report its output." \
  --output-format streaming-json --permission-mode <MODE> --max-turns 4 --cwd "$d" </dev/null
# PASS = reaches an `end` event with no stall AND the edit + command actually executed.
```
Adopt the **least-permissive mode that passes** as the module constant
`GROK_PERMISSION_MODE`. Do NOT hardcode `bypassPermissions` / `--always-approve` if a
narrower mode works. Leave a TODO to promote it to a setting
(`muster.grok.permissionMode`); keep `RunOptions` unchanged. (Current `ClaudeBackend`
passes no permission flag — pre-existing gap, out of scope here.)

---

## 11. Test harness — `scripts/test-grok.ts` + `mvp:grok`

Mirror `scripts/test-runner.ts`, printing `reasoningDelta` (dim), `assistantDelta`
(stdout), `sessionStarted`, and terminal events; prompt from argv, `RESUME_ID` from env.
**Add an abort trigger** so the cancellation path is actually exercised (ISSUE-8): if
`ABORT_MS` is set, create an `AbortController`, pass its `signal` in `RunOptions`, and
`setTimeout(() => controller.abort(), Number(ABORT_MS))`.
Add to `package.json`: `"mvp:grok": "tsx scripts/test-grok.ts"`.

**Console checks (before UI wiring):**
1. `npm run mvp:grok -- "say hello in 3 words"` → `reasoningDelta`* then `assistantDelta`*,
   a `sessionStarted`, one `turnCompleted`; process exits 0.
2. `RESUME_ID=<id> npm run mvp:grok -- "what did I just ask?"` → Grok resumes / recalls.
3. `--session-id` acceptance probe (§6) passes, or the fallback path is implemented.
4. Permission-mode probe (§10) selects a mode that completes noninteractively.
5. `ABORT_MS=1500 npm run mvp:grok -- "count slowly to 100"` → terminal
   `error{isCancellation:true}`, **exactly one** terminal event, and no orphaned process
   (`pgrep -f "grok -p"` is empty afterward).
6. `tsc -p . --noEmit` and `npm run compile` succeed.

**Post-wiring smoke check (Extension Development Host, ISSUE-8):** select Grok in the
Toolbar, send a turn, confirm it streams; switch to Claude, send a turn; confirm
`.muster-sessions.json` holds independent `grok` and `claude` ids, and that New Session on
one backend does not clear the other's stored id.

---

## 12. Files to add / change

| Action | File | Purpose |
|--------|------|---------|
| ADD | `src/backends/grok.ts` | The adapter (§5 / §6 / §9 / §10) |
| ADD | `src/backends/index.ts` | `makeBackend` factory + `BACKEND_IDS` |
| ADD | `scripts/test-grok.ts` | Console harness (with `ABORT_MS` trigger) |
| EDIT | `package.json` | `mvp:grok` script |
| EDIT | `src/extension.ts` | Factory; pass `backend` + workspace `cwd` from `send`; per-backend session keying; **success-only commit** on `turnCompleted`; backend-specific `newSession` |
| EDIT | `webview/src/lib/protocol.ts` | `send.backend?: string`; `newSession.backend?: string` |
| EDIT | `webview/src/components/Toolbar.svelte` | Enable picker + Grok option + bind to `thread.backend`; send backend on `newSession` |
| EDIT | `webview/src/components/Composer.svelte` | Include `thread.backend` in the `send` payload (ISSUE-8) |
| UPDATE | `docs/CLI-COMMANDS.md` | Mark headless `streaming-json` shapes verified (thought/text/end; no tool events; sessionId in `end`) |
| UPDATE | `README.md` | Grok row → ✅ (basic) |

**No webview reducer change** — `turn-state.svelte.ts` already no-ops `reasoningDelta`
(§8, option B). `thread.backend` already exists as the picker's state.

---

## 13. Risks & open questions (for the plan reviewer / implementer)

**Mandatory verification steps** (were assumptions; now explicit probes the implementer must run):
1. **`--session-id` v4 acceptance** (§6) — recommended strategy depends on it; documented fallback if not honored.
2. **Permission mode** (§10) — probe edit+shell noninteractively; adopt the least-permissive mode that passes.
3. **`stopReason` value space** (§9) — only `EndTurn` observed; map any clear-failure reasons to a terminal `error`.
4. **vscode-elements single-select change event** (§7.5) — confirm `onchange` + `e.target.value` vs a custom event / `.value`.

**Accepted design decisions (resolved in this revision):**
5. **Single terminal emitter** in the close logic (§9); `end` only records — fixes the exactly-one-terminal invariant (ISSUE-1).
6. **Success-only, per-backend session commit** + backend-specific New Session (§7.4) — aligns with SESSION-MANAGEMENT.md and preserves the impl-review ISSUE-1 currency guard (ISSUE-2/4).
7. **Pass workspace `cwd`** to the backend (§7.3) so Grok Build operates on the user's repo (ISSUE-3).
8. **Spawn-error / pre-abort / close-or-error** handling (§9) so a missing `grok` or invalid cwd yields one terminal `error` instead of a hang (ISSUE-5).
9. **Reasoning UI deferred** — option B (§8); adapter emits `reasoningDelta`, reducer already ignores it.

**Accepted MVP limitations (documented, not blockers):**
10. **No structured tool events** in headless `streaming-json` — Grok's tool activity is invisible in the UI (only the final `text` shows). ACP would fix it but breaks per-turn-spawn (out of scope).
11. **Cancellation orphans** — `SIGTERM` only, parity with Claude; kill-process-group is future hardening.
12. **MCP injection** deferred (no per-invocation flag) — consistent with the current Claude chat path.
