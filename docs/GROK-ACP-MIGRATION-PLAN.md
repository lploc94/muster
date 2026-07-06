# Grok Backend — Headless → ACP Migration Plan

> **Status: COMPLETED (2026-07-06).** First backend on Muster's **ACP-only** path.
> Implemented in `src/backends/grok.ts` + `src/backends/acp-client.ts`.
> Claude/Codex/agy follow the same client — see `DESIGN.md` §2.1 + `CLI-COMMANDS.md`.

Convert the Grok backend adapter from **headless** (`grok -p` + `--output-format
streaming-json`, spawn-per-turn) to **ACP** (`grok agent stdio`, persistent JSON-RPC
agent). The `Backend`/`NormalizedEvent` contract and the webview stay unchanged; only
the Grok adapter's internals change. This unlocks clean, concurrency-safe per-session
MCP injection (for the future Muster Bridge) and richer streaming (reasoning + tool
events).

**Implementer:** Grok. **Reviewer path:** `codex-plan-review` → implement → `codex-impl-review` (done — APPROVE).

---

## 1. Scope

**In scope**
- Rewrite `src/backends/grok.ts` to drive Grok over ACP.
- Add `src/backends/acp-client.ts` — a small ACP JSON-RPC connection manager.
- Keep the `Backend` contract (`run(options): AsyncIterable<NormalizedEvent>`) and all
  ADAPTER-SPEC invariants intact, so the flat webview chat and `mvp:grok` keep working.
- Plumb an (http/sse) `mcpServers` injection point into `session/new` (empty for now;
  the Muster Bridge fills it in the separate task-model Phase C).

**Out of scope** (do NOT do here)
- The Muster Bridge / task model / coordinator tools (separate plan).
- Any Claude adapter change; any webview change; any `NormalizedEvent` change.
- Implementing client-side `fs`/`terminal` for Grok (see §4 — we declare them off).

---

## 2. What must NOT change (contract + invariants)

- `Backend { name:'grok'; capabilities?; run(options): AsyncIterable<NormalizedEvent>; extractSessionId? }`.
- `RunOptions { prompt, resumeId?, mcpConfigPath?, cwd?, extraEnv?, signal? }` — may be
  extended **additively** (see §4), never broken.
- ADAPTER-SPEC: **exactly one terminal event** (`turnCompleted` | `error`) per run;
  `sessionStarted` **at most once**; unknown/unparseable input → `raw`; SIGTERM-style
  hard kill replaced by ACP cancel (§3.4).
- Flat single-chat behavior (send / stream / cancel / new-session / resume) must be
  at parity after the migration.

---

## 3. Target design

### 3.1 ACP client (`src/backends/acp-client.ts`)

A lazily-initialized, shared connection manager (one `grok agent stdio` process for
the extension), because ACP is multi-session and this keeps parallel task sessions on
one agent later.

- **Spawn:** `spawn('grok', ['--no-auto-update', 'agent', 'stdio'], { stdio:['pipe','pipe','pipe'], env:{...process.env, ...extraEnv} })`. (`--no-auto-update` per Grok's headless/scripting guidance.)
- **Framing:** newline-delimited JSON-RPC 2.0 over stdin/stdout (`readline` on stdout).
- **Correlation:** outgoing requests keyed by integer `id`; resolve/reject the matching
  pending promise on the response.
- **Notifications & agent→client requests:** route `session/update` to the owning
  session (see 3.3); respond to agent→client **requests** (those with an `id`):
  - `session/request_permission` → respond **allow** (non-interactive posture; matches
    today's headless behavior — flag as a security note; a real permission policy is a
    later concern).
  - Any `fs/*` or `terminal/*` request → respond with a JSON-RPC error (unsupported);
    we declare these capabilities **off** so Grok uses its own built-in tools (§4).
  - `_x.ai/*` extension notifications (no `id`: `mcp/init_progress`, `server_status`,
    `sessions/changed`, `announcements/update`, `queue/changed`, `models/update`,
    `session_notification`, `prompt_complete`, …) → **ignore**.
- **Handshake (once per connection):**
  1. `initialize { protocolVersion:1, clientCapabilities:{ fs:{readTextFile:false,writeTextFile:false}, terminal:false } }`
     → read `authMethods`, `agentCapabilities`.
  2. `authenticate { methodId, _meta:{ headless:true } }` where `methodId` =
     `xai.api_key` if `process.env.XAI_API_KEY` and offered, else `cached_token`
     (offered when `~/.grok/auth.json` exists; it is the server default).
- **Lifecycle:** expose `dispose()` (end stdin / kill) for extension deactivate; if the
  process exits or errors, reject all pending requests and fail in-flight runs with a
  terminal `error`. Handle spawn error → terminal `error`.

### 3.2 `GrokBackend.run()` over ACP (`src/backends/grok.ts`)

Per `run(options)`:
1. Ensure the shared client is connected + authenticated (await handshake once).
2. **Open the session:**
   - new: `session/new { cwd: options.cwd ?? process.cwd(), mcpServers: <see §4> }` → `sessionId`.
   - resume: `session/load { sessionId: options.resumeId, cwd, mcpServers }` (guarded by
     `agentCapabilities.loadSession`; see verify-item V2 for history-replay handling).
   - Emit `sessionStarted { sessionId }` **once** (server-assigned id).
3. **Prompt:** `session/prompt { sessionId, prompt:[{ type:'text', text: options.prompt }] }`.
   Keep the returned promise; it resolves at turn end (the single terminal signal).
4. **Stream:** as `session/update` notifications for THIS `sessionId` arrive, map →
   `NormalizedEvent` (table in §5) and `yield` them.
5. **Terminal (exactly one):** when the `session/prompt` promise resolves with
   `{ stopReason, _meta }`:
   - emit an optional `usage` event from `_meta` tokens (inputTokens/outputTokens/…);
   - `stopReason === 'end_turn'` → `turnCompleted { meta:{ stopReason } }`;
   - a failure/refusal stopReason → `error { message }` (values: verify-item V4);
   - if cancelled (3.4) → `error { message:'Turn cancelled', isCancellation:true }`.
   Never emit a terminal from a `session/update`; only from the prompt response / a
   connection error.

### 3.3 Concurrency (per-session routing)

Multiple `run()` calls share one connection. Maintain a `Map<sessionId, sink>` so each
`session/update` is delivered to the correct run's async stream, and each
`session/prompt` is correlated by request `id`. Each task/turn = its own ACP session →
independent, in-band — **no shared config file, no per-turn file rewrite** (this is the
whole point of choosing ACP). Verify concurrent prompts across sessions on one
connection (V6); if Grok serializes, fall back to one connection per active session.

### 3.4 Cancellation

On `options.signal` abort: send ACP `session/cancel { sessionId }` (verify exact method
+ params, V3). The `session/prompt` promise then resolves (likely a cancelled
stopReason) → emit `error { isCancellation:true }`. Pre-aborted signal handled before
prompting. No SIGTERM of the shared agent (that would kill other sessions).

---

## 4. MCP injection point + capabilities

- `session/new`/`session/load` accept `mcpServers`, but ACP `mcpCapabilities` is
  **`{ http:true, sse:true }`** — **stdio is rejected** over ACP (empirically:
  `data did not match any variant of untagged enum McpServer`). So the future Muster
  Bridge must be injected as an **http** MCP server entry. Exact http `McpServer`
  schema = verify-item **V1**.
- For THIS migration, pass `mcpServers: []` with a single clearly-marked injection
  point. Extend `RunOptions` **additively** with an optional `mcpServers?: McpServerConfig[]`
  (preferred) OR derive from `mcpConfigPath`; the task-model Phase C supplies the Bridge.
- Config-file MCP servers (`~/.grok/config.toml`, `~/.claude.json`, `.mcp.json`) still
  load inside ACP sessions too, so injection is additive to discovery.
- **Capabilities:** set `supportsMCP: true` (ACP can inject http/sse MCP servers per
  session — mechanism verified). Set `supportsReasoning: true` (agent_thought_chunk).
  Set `supportsDetailedToolEvents` to **true only if** V5 confirms `tool_call`
  update shapes; otherwise keep `false`.
- Drop `extractSessionId` (obsolete — the id comes from `session/new`); the contract
  field is optional.

---

## 5. Event mapping (ACP `session/update` → `NormalizedEvent`)

Empirically captured (spike, grok 0.2.87):

| ACP update `sessionUpdate` | NormalizedEvent |
|---|---|
| `agent_thought_chunk` `{content:{text}}` | `reasoningDelta { content, messageId }` |
| `agent_message_chunk` `{content:{text}}` | `assistantDelta { content, messageId }` |
| `user_message_chunk` (prompt echo) | *ignore* |
| `available_commands_update` | *ignore* |
| `tool_call` / `tool_call_update` (shape V5) | `toolStarted` / `toolUpdated` / `toolCompleted` (if V5 confirms) |
| any other / unrecognized | `raw { line }` |
| `session/prompt` **response** `{stopReason,_meta}` | `usage` (from `_meta`) + terminal `turnCompleted`/`error` |

Use one stable `messageId` per run for assistant+reasoning deltas (a fresh `randomUUID()`).
`stopReason` seen: `end_turn` (success). Others → V4.

---

## 6. Files

| Action | File | Notes |
|---|---|---|
| ADD | `src/backends/acp-client.ts` | ACP JSON-RPC connection manager (§3.1, §3.3) |
| REWRITE | `src/backends/grok.ts` | `GrokBackend.run()` over ACP (§3.2); capabilities (§4); drop `extractSessionId` |
| EDIT (additive) | `src/types.ts` | optional `RunOptions.mcpServers?` + an `McpServerConfig` type |
| VERIFY | `scripts/test-grok.ts` | unchanged interface; confirm `mvp:grok` + `ABORT_MS` still pass |
| UPDATE | `docs/CLI-COMMANDS.md`, `README.md` | note Grok now runs via ACP (`grok agent stdio`) |

No webview, Claude, or `NormalizedEvent` changes.

---

## 7. Verify-items (probe live before/while implementing)

Grok must confirm these against the real CLI and adjust the implementation:

- **V1 — http `McpServer` schema** accepted by `session/new.mcpServers` (name + transport
  + url + headers?). The stdio shape is rejected; capture the exact accepted http/sse shape.
- **V2 — `session/load`** exact params, and whether it **replays history** as
  `session/update` (if so, suppress re-emitting old content: only stream updates after
  the load completes / for the new prompt).
- **V3 — cancel:** exact method (`session/cancel`?) + params, and the resulting
  `stopReason` for a cancelled turn.
- **V4 — `stopReason` value space:** beyond `end_turn` — refusal/error/max-tokens/
  cancelled — and which map to `error` vs `turnCompleted`.
- **V5 — tool events:** `tool_call` / `tool_call_update` update shapes (fields:
  toolCallId, name, status, kind, input, output/error) → decide `supportsDetailedToolEvents`.
- **V6 — concurrency:** whether concurrent `session/prompt` on different sessions over
  ONE connection is supported; if not, use one connection per active session.
- **V7 — non-interactive posture:** confirm auto-allowing `session/request_permission`
  (or an equivalent session option / `always-approve`) yields fully non-interactive
  runs, and that declaring `fs`/`terminal` client caps **off** makes Grok use its own
  built-in tools (so we need not implement client fs/terminal).
- **V8 — resume identity:** a `session/new` id can later be reloaded via `session/load`
  (this is what the extension's persisted resume id relies on).

---

## 8. Acceptance criteria

- `npm run compile` green; `Backend`/`NormalizedEvent` contract unchanged (aside from the
  additive `RunOptions.mcpServers?`).
- `npm run mvp:grok -- "say hi"` streams assistant text and ends with exactly one
  `turnCompleted`; reasoning arrives as `reasoningDelta`; no stray terminal events.
- Resume: `RESUME_ID=<id> npm run mvp:grok -- "continue"` loads the prior session.
- Cancel: `ABORT_MS=1500 npm run mvp:grok -- "count slowly to 100"` yields a single
  `error { isCancellation:true }` (via ACP cancel, not process kill) and does not crash
  the shared connection.
- Flat webview chat still works (send/stream/cancel/new-session/resume) unchanged.
- ADAPTER-SPEC invariants hold: one terminal per run; `sessionStarted` once; unknown
  updates → `raw`.
- `mcpServers` injection point present and typed (empty by default; http/sse-ready per V1).

---

## 9. Notes / risks

- **Security:** auto-allowing `session/request_permission` = non-interactive tool
  execution (parity with today's headless). Fine for local single-user dev; a real
  permission policy belongs to the task-model/Bridge work, not here.
- **Shared connection blast radius:** a crashed agent process fails all in-flight runs;
  reject pending + surface terminal `error`, and lazily respawn on next `run()`.
- **stdio MCP not injectable over ACP** — the Bridge is therefore http (already the
  natural design for an in-extension server).
- The current headless `grok -p` adapter is fully replaced; keep it in git history only.
