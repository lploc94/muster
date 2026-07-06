# Muster Bridge — MCP Server (`muster_bridge`)

This document is the **authoritative design** for the extension-owned MCP server `muster_bridge`: human-in-the-loop tools and IDE bridge capabilities that headless CLIs cannot provide alone.

**Related docs:**
- `docs/DESIGN.md` — high-level architecture (§2.5, §5, §8)
- `docs/MCP-INJECTION.md` — how `muster_bridge` is merged into per-backend MCP config alongside `context_engine`
- `docs/ADAPTER-SPEC.md` — normalized events adapters emit while a turn is in progress
- `docs/CLI-COMMANDS.md` — per-CLI flags and streaming capabilities

---

## 1. Problem

In headless mode (`-p`, `exec`, …) there is no TTY. Builtin tools like Claude `AskUserQuestion` are unavailable or cannot block for a real user answer.

We still want the agent to **call a tool**, **wait for the human**, then **continue in the same turn** (same CLI process) — not force a new turn + resume for every clarification.

## 2. Decision summary

| Topic | Decision |
|-------|----------|
| Mechanism | **MCP only** — tools on server `muster_bridge` (see §4). No JSON-in-response fallback. |
| Who answers | **Webview → Extension host → AskBridge**. Webview never speaks MCP directly. |
| Answer transport | **In-memory Promise** in extension (`AskBridge`). No answer JSON files in production. |
| MCP server placement | **HTTP MCP URL** served by extension (preferred). stdio MCP + localhost callback as fallback. |
| Turn model | Still **one CLI process per user message**. Turn may **pause** until `ask_user` resolves; process stays alive. |
| Backend order | **Claude `stream-json` first** → Grok/Codex → **agy deferred** until better streaming/tool events. |

## 3. Architecture

```
┌──────────────┐  postMessage   ┌─────────────────────────────────────┐
│   Webview    │ ─────────────► │ Extension host                      │
│ question card│ ◄───────────── │  AskBridge (pending Map<id, …>)     │
└──────────────┘  showQuestion  │  MusterMcpHttpServer (local)   │
                                └──────────────────┬──────────────────┘
                                                   │ register / resolve
┌──────────────┐  MCP HTTP or socket              │
│ CLI process  │ ─────────────────────────────────┘
│ (claude, …)  │
└──────────────┘
```

### 3.1 Why webview does not call MCP

- MCP sessions belong to the **CLI child process** (or the extension-owned HTTP server the CLI connects to).
- Webview runs sandboxed — it only `postMessage`s to the extension.
- Flow: `submitAsk` message → `AskBridge.submit(id, answers)` → unblocks MCP tool → CLI continues.

### 3.2 AskBridge (extension host)

```ts
interface PendingAsk {
  questions: Question[];
  resolve: (answers: Answers) => void;
  reject: (err: Error) => void;
  createdAt: number;
}

class AskBridge {
  private pending = new Map<string, PendingAsk>();

  /** Called by MCP handler when ask_user tool is invoked */
  register(id: string, questions: Question[]): Promise<Answers>;

  /** Called when webview user submits */
  submit(id: string, answers: Answers): void;

  /** Called on turn cancel / extension deactivate */
  cancelAll(reason: string): void;
}
```

On `register`:
1. Store pending entry.
2. Emit UI event (webview question card).
3. Return Promise that resolves when `submit()` is called.

On `submit`:
1. Resolve Promise with answers.
2. Remove from map.
3. MCP tool returns JSON to agent.

### 3.3 MCP tool contract

**Server name:** `muster_bridge`

**Tool:** `ask_user`

**Input:**
```json
{
  "id": "ask-001",
  "questions": [
    {
      "prompt": "Which database?",
      "options": ["SQLite", "Postgres"],
      "allowFreeText": true
    }
  ]
}
```

`id` is optional — the handler generates one when the agent omits it (the spike uses `ask-${Date.now()}`). `options` and `allowFreeText` are optional per question; only `prompt` is required.

**Output:**
```json
{
  "id": "ask-001",
  "answers": {
    "0": { "selected": ["Postgres"], "freeText": null }
  }
}
```

`answers` is a map keyed by the **question index** (as a string). Each value is `{ "selected": string[], "freeText": string | null }` — the same shape the webview submits via `submitAsk` (§6). `selected` holds chosen `options`; `freeText` carries the optional free-text answer when `allowFreeText` is set.

**Timeout:** the handler waits on `AskBridge` with a bounded deadline (configurable — the spike uses `MUSTER_ASK_TIMEOUT_MS`, default 120 s). On expiry the tool returns `isError: true` rather than blocking the CLI process forever.

**Errors:** timeout, user cancelled turn, extension deactivated → MCP `isError: true`; adapter may emit `{ type: 'error' }` if turn aborts.

## 4. MCP tool catalog

> **Task-flow extension:** `TASK-MANAGEMENT.md` defines additional orchestration
> and self-disposition tools. They are exposed only through turn-scoped capability
> credentials and are not general-purpose bridge utilities. This section remains
> authoritative for non-task IDE/human-in-the-loop tools.

**Principle:** `muster_bridge` is **thin**. Only tools that need the **VS Code extension host** or **blocking human input**. Everything else stays on the CLI (Read/Edit/Bash) or on **`context_engine`** (semantic search).

### 4.1 Do NOT put on `muster_bridge`

| Capability | Where it belongs |
|------------|------------------|
| Semantic search, grep codebase, graph traversal | `context_engine` MCP |
| Read / write / edit files, run shell | CLI builtin tools |
| Web fetch, LSP (if CLI exposes them) | CLI / other MCP plugins |
| Pick backend, resume session | Muster **UI** — not agent-callable |

Duplicating CLI tools on `muster_bridge` confuses the model and doubles maintenance.

### 4.2 MVP (ship with first bridge)

| Tool | Blocking? | Purpose |
|------|-----------|---------|
| **`ask_user`** | ✅ Yes | Structured questions (choices + optional free text). Core human-in-the-loop. |

### 4.3 Phase 2 (high value, still thin)

| Tool | Blocking? | Purpose |
|------|-----------|---------|
| **`notify_user`** | ❌ No | Toast / status line: info, warning, milestone. Agent updates UI without pausing. |
| **`get_ide_context`** | ❌ No | Snapshot for headless agent: active editor path, selection range, workspace folder, optional diagnostics summary (errors count). CLIs in `-p` often lack “what user is looking at”. |

`notify_user` input example:
```json
{ "level": "info", "title": "Tests", "message": "Running test suite…" }
```

`get_ide_context` output example:
```json
{
  "workspaceFolder": "/path/to/repo",
  "activeEditor": {
    "path": "src/foo.ts",
    "selection": {
      "start": { "line": 10, "character": 0 },
      "end": { "line": 12, "character": 8 }
    }
  },
  "diagnostics": { "errorCount": 2, "warningCount": 5 }
}
```

Positions are **0-based** (`line`, `character`) to match the VS Code `Position` API. `selection` is omitted when there is no active editor.

### 4.4 Phase 3 (when permission UI is in scope)

| Tool | Blocking? | Purpose |
|------|-----------|---------|
| **`request_approval`** | ✅ Yes | Approve/deny a **specific** risky action with context (command, paths, diff summary). Replaces blind `--dangerously-skip-permissions` for users who want gates. |

Input: `{ "kind": "command" \| "edit" \| "mcp", "title", "detail", "risk" }`  
Output: `{ "decision": "allow_once" \| "allow_always" \| "deny", "comment"? }`

Aligns with DESIGN.md “permission cards” — currently **out of scope**, but this is the right hook when added.

### 4.5 Optional / later (evaluate need)

| Tool | Notes |
|------|--------|
| **`open_in_editor`** | Open file at line in VS Code. Nice UX; CLI `Read` may suffice for MVP. |
| **`handoff`** | Non-blocking: “User must do X manually” + checklist. Lighter than `ask_user`. |
| **`report_progress`** | Structured sub-steps for coordinator UI (task list). Only if webview needs richer progress than narrative text. |
| **`get_session_info`** | Read-only: backend name, `sessionId`, turn metadata. Debugging / multi-tab; low priority. |

### 4.6 Explicitly avoid

- **`run_terminal` / `read_file`** — CLI already has these; coordinator should not proxy.
- **`search_codebase`** — belongs on `context_engine`.
- **`switch_backend` / `new_session`** — user-driven coordinator actions, not agent tools.
- **Large utility surface** — every tool is prompt noise; prefer ≤ 4 non-task
  utilities for MVP+Phase 2. Task-management tools are filtered by caller role and
  capability rather than exposed to every turn.

---

## 5. MCP server deployment

### 5.1 Preferred: HTTP MCP (extension-owned)

On extension `activate`:
1. Start `MusterMcpHttpServer` on `127.0.0.1:<port>` (port from config or ephemeral).
2. Expose MCP Streamable HTTP (or SSE) endpoint per MCP spec.
3. `ask_user` handler calls `AskBridge.register()` directly (same process — no file IPC).

**Startup ordering:** with an ephemeral port, the server must be **listening and its actual port resolved before** the per-turn MCP config is built — the URL (`http://127.0.0.1:<port>/mcp`) embeds that port. Start the server once on `activate`, cache `{ port, token }` (see §10), and reuse it for every turn. If the server is not yet ready when a turn spawns, await it rather than writing a placeholder port.

Per-turn MCP merge (`context_engine` + `muster_bridge`):
```json
{
  "mcpServers": {
    "context_engine": { "command": "node", "args": ["…"] },
    "muster_bridge": { "url": "http://127.0.0.1:<port>/mcp" }
  }
}
```

- **agy** supports `"url"` in `mcp_config.json` (≥ 1.0.5).
- **Claude** — verify `url` in `--mcp-config`; fall back to §5.2 if needed.

### 5.2 Fallback: stdio MCP + localhost callback

When a CLI only supports `command`/`args` MCP:

```json
{
  "muster_bridge": {
    "command": "node",
    "args": ["…/muster-ask-server.mjs"],
    "env": { "MUSTER_BRIDGE_URL": "http://127.0.0.1:<port>" }
  }
}
```

Stdio subprocess forwards `register` / `wait` to extension HTTP API. Still **no answer files** — bridge holds the Promise; stdio server only proxies.

> `mcp/muster-ask-server.mjs` in this repo is a **spike** using file IPC for agy testing. Replace with HTTP callback before production.

## 6. UI / webview

### Messages (extension ↔ webview)

| Direction | Type | Payload |
|-----------|------|---------|
| ext → webview | `askPending` | `{ id, questions }` |
| webview → ext | `submitAsk` | `{ id, answers }` |
| webview → ext | `cancelAsk` | `{ id }` (optional; cancels turn) |

### Normalized events (adapter → UI)

When Claude emits `toolStarted` for `mcp__muster_bridge__ask_user`, adapter forwards as-is. UI may also react to `askPending` from bridge for backends without structured tool events.

Render: question card with options + optional free-text; block sending new prompts while `AskBridge` has unresolved entries for the active turn (or allow cancel).

## 7. Turn lifecycle

```
User sends message
  → extension creates runId, starts adapter.run()
  → CLI spawns (fresh process)
  → agent works…
  → ask_user → AskBridge.register → webview card
  → [USER ANSWERS] → AskBridge.submit
  → MCP returns → agent continues
  → turnCompleted → process exits
```

**Clarification vs DESIGN.md §2.1:** We still spawn **one process per user-initiated message**. That process may remain alive longer while waiting for `ask_user`. This is not a session pool and not ACP-style long-lived brokers.

**Cancellation:** `AbortSignal` on `RunOptions` must reject pending asks in `AskBridge` and kill the CLI process tree.

## 8. Backend support matrix

| Backend | MCP `ask_user` mid-turn | Detect ask for UI | Priority |
|---------|-------------------------|-------------------|----------|
| Claude `stream-json` | ✅ Expected | `toolStarted` + AskBridge | **P0** |
| Grok `streaming-json` | ⚠️ Verify tool events | stream + AskBridge | P1 |
| Codex `--json` | ⚠️ Verify `item.*` | stream + AskBridge | P1 |
| agy plain `-p` | ✅ Proven (spike 1.0.16) | AskBridge only (no structured tool events) | **Deferred** |
| agy `--output-format json` | ✅ MCP works; stdout is one blob | AskBridge only | **Deferred** |

### agy deferral rationale

Empirical spike (`npm run test:agy-ask`) confirmed blocking MCP works, but:
- No NDJSON / structured `toolStarted` on stdout.
- MCP config only via `~/.gemini/config/mcp_config.json` (no `--mcp-config`).
- Muster cannot rely on adapter stream alone for ask UI.

Revisit when agy ships streaming tool events or documented HTTP MCP ergonomics improve.

## 9. MCP config merge

Every turn merges two servers (see `MCP-INJECTION.md`):

1. `context_engine` — semantic search / codebase tools (user-provided path).
2. `muster_bridge` — IDE bridge tools (§4; MVP = `ask_user` only).

Use `--strict-mcp-config` on Claude where supported.

## 10. Security notes

- HTTP MCP binds **127.0.0.1 only**.
- **Auth is required even on loopback.** Binding to `127.0.0.1` is not sufficient isolation — any local process (or a browser page via DNS-rebinding) can reach the port. Generate a random per-session **bearer token** on `activate`, embed it in the injected MCP config (e.g. an `Authorization` header or `?token=` on the URL), and reject requests that don't present it. The token lives only in memory and in the per-turn config we hand the CLI.
- **Validate `Host`/`Origin` headers** on the HTTP server to blunt DNS-rebinding (reject anything but `127.0.0.1[:port]` / `localhost`). This is the MCP Streamable-HTTP spec recommendation.
- `ask_user` exposes no filesystem or shell — questions/answers only. `get_ide_context` (Phase 2) does expose paths/selection — keep it read-only and behind the same token.
- Do not log raw answers in production telemetry without user consent.

## 11. Implementation checklist

- [ ] `AskBridge` service in extension host
- [ ] `MusterMcpHttpServer` on activate/deactivate (resolve ephemeral port before first turn)
- [ ] Per-session bearer token + `Host`/`Origin` validation on the HTTP server (§10)
- [ ] `mcp-config.ts` merge `context_engine` + `muster_bridge` (inject token into the `muster_bridge` entry)
- [ ] Webview question card + `submitAsk` / `cancelAsk`
- [ ] Claude adapter: parse `mcp__muster_bridge__ask_user` in stream-json
- [ ] Wire `AbortSignal` → `AskBridge.cancelAll`
- [ ] Replace file-IPC spike in `mcp/muster-ask-server.mjs` with HTTP callback
- [ ] agy backend: pending until streaming tool events land

## 12. Spike reference

| Artifact | Purpose |
|----------|---------|
| `mcp/muster-ask-server.mjs` | File-IPC proof for agy (dev only) |
| `scripts/test-agy-ask-mcp.mjs` | End-to-end agy headless test (`npm run test:agy-ask`) |

---

**Status:** Approved design. Implementation follows Claude-first order; agy pending newer CLI capabilities.
