# Muster — Design Document

## 1. Goals & Scope

Build a VS Code extension that acts as a **coordinator** for multiple AI coding CLIs:

- Grok (xAI Grok Build CLI)
- Claude Code (Anthropic)
- Codex (OpenAI)
- Antigravity (Google, formerly Gemini CLI)

### Core Use Cases (Minimal but Useful)
- Send a prompt to any backend.
- Continue / resume an existing conversation (using the CLI's native session mechanism).
- Receive results with **nice streaming** of:
  - Thinking / reasoning deltas
  - Tool calls (start + result)
  - Final messages
- Allow the agent to use a custom **MCP "context engine"** tool during execution (semantic codebase search, etc.).
- Let the agent **ask the user** mid-turn via MCP `muster_bridge.ask_user` (see `docs/MUSTER-BRIDGE.md`).

### Explicitly Out of Scope (for now)
- Rich permission system / approval cards
- Native diff preview before apply
- Plan mode / client-side gates
- Full ACP client capabilities for Grok (`fs`/`terminal` proxy — we declare them off)
- Session pools or multi-turn brokers beyond what each CLI natively supports

## 2. Core Architectural Decisions

### 2.1 ACP-only integration (all backends)
- Muster talks to **every** backend through the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) — JSON-RPC 2.0 over stdio. **No headless** `-p` / `exec` / NDJSON stdout adapters.
- Every user message (or continue) = **one adapter `run()`** = **one ACP session** (`session/new` or `session/load`) on a shared agent connection for that backend.
- One **shared** `<cli> agent stdio` (or equivalent ACP entry) process per backend type for the extension lifetime; we do **not** reuse ACP sessions across unrelated turns — each turn gets its own session ID.
- Streaming arrives as ACP `session/update` notifications; MCP is injected per session via `mcpServers` on `session/new` / `session/load`.
- Cancel via ACP `session/cancel` (not SIGKILL of the shared agent, except on extension shutdown).

**Rationale**:
- One protocol for all backends → one `acp-client`, one event mapper, one MCP injection path.
- Per-session `mcpServers` (http/sse) is the clean way to inject `context_engine` + `muster_bridge` without temp config files or races.
- Structured tool/reasoning events and cancel are first-class in ACP.
- We declare `fs`/`terminal` client capabilities **off** (agents use built-in tools) — not the full Grok Build VS Code plugin model.

### 2.2 Explicit Session IDs for Resume
- Never rely solely on `--continue` / `--last` when the plugin can have multiple concurrent conversations in the same workspace.
- Capture and persist the **explicit session ID** returned or used by each CLI.
- When continuing, pass the ID via ACP `session/load { sessionId }`.

### 2.3 MCP Injection at Turn Start
- The "context engine" is provided to the agent as an **MCP server**.
- We inject the MCP configuration at every turn so the agent sees the tool during that turn.
- MCP handling is **uniform**: `mcpServers` on ACP `session/new` / `session/load` (http/sse entries; see `MCP-INJECTION.md`).

### 2.4 Streaming Output + Normalization
- All backends stream via ACP `session/update` notifications.
- Updates are mapped into a small set of **normalized events**.
- The UI only deals with the normalized model (makes it easy to add new backends later).

### 2.5 Human-in-the-Loop via Muster Bridge (MCP `ask_user`)
- Agents ask structured questions through MCP tool `ask_user` on server `muster_bridge` — **MCP only**, no text/JSON fallback.
- The **extension host** owns `AskBridge` (in-memory pending asks). The **webview** submits answers via `postMessage`; it does not call MCP directly.
- Preferred transport: **HTTP MCP URL** served locally by the extension. stdio MCP + localhost callback is a fallback.
- A turn remains **one ACP session per user message**, but the session may **pause** until the user answers (not a session pool).
- **Grok ACP first** (implemented); Claude/Codex/agy ACP adapters follow the same client (`acp-client.ts`).

→ Full design: **`docs/MUSTER-BRIDGE.md`**

## 3. Normalized Event Model

> **Note**: The sketch below is illustrative only. The authoritative definition lives in `docs/ADAPTER-SPEC.md` and `src/types.ts`.

```ts
type NormalizedEvent =
  | { type: 'sessionStarted'; sessionId?: string }
  | { type: 'assistantDelta'; content: string }
  | { type: 'reasoningDelta'; content: string }          // optional
  | { type: 'toolStarted'; toolCallId: string; name: string; input?: any }
  | { type: 'toolUpdated'; toolCallId: string; patch?: any }
  | { type: 'toolCompleted'; toolCallId: string; output?: any; error?: string }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number; ... } }
  | { type: 'turnCompleted' }
  | { type: 'error'; message: string; raw?: any };
```

**Design notes**:
- Keep the set small and stable.
- Make reasoning and some tool details optional capabilities per backend.
- Always preserve raw/unknown events for debugging.

## 4. Per-CLI ACP Entry Points

Shared lifecycle for every backend: `initialize` → `authenticate` → `session/new|load` → `session/prompt` → `session/update`* → terminal `stopReason`. Details: `CLI-COMMANDS.md`.

| Backend | ACP agent command | Adapter status |
|---------|-------------------|----------------|
| Grok | `grok --no-auto-update agent stdio` | ✅ implemented |
| Claude | `claude-code-acp` (ACP adapter; verify package name on bump) | 🔜 migrate from legacy headless code |
| Codex | `codex app-server --stdio` (experimental) | 🔜 planned |
| Antigravity | TBD — verify ACP entry when implementing | 🔜 experimental |

All backends: `mcpServers` on `session/new`/`session/load`; `session/request_permission` → auto-allow in non-interactive coordinator mode; cancel → `session/cancel`.

## 5. High-Level Components

```
Extension
├── Backend Layer
│   ├── types.ts (NormalizedEvent + Backend interface)
│   ├── claude.ts
│   ├── grok.ts
│   ├── codex.ts
│   └── antigravity.ts
├── TaskStore + TaskEngine (task graph, turns, orchestration — see `docs/TASK-MANAGEMENT.md`)
├── Session migration (archive-only `.muster-sessions.json` → `.migrated` on activation)
├── CommandBuilder / MCPConfig helpers
├── Muster Bridge
│   ├── AskBridge (pending asks, in-memory)
│   └── MusterMcpHttpServer (local HTTP MCP — `ask_user`)
├── acp-client.ts (shared ACP JSON-RPC client per backend agent process)
├── Runner (ACP session lifecycle + session/update → NormalizedEvent)
└── UI (Webview)
    └── Chat view + question cards (submitAsk → AskBridge)
```

## 6. Session Management

The extension is **engine-only**: there is no flat per-backend session file or
second persistence path. On activation, a present `.muster-sessions.json` is
archived (never silently dropped); new work always starts as tasks.

In the task-based flow:

- each task owns one backend session and never shares its session ID;
- each CLI invocation is a persisted turn;
- session identity is committed to the task only after a successful turn;
- task lifecycle and turn/process status are separate concepts;
- "New task" replaces "New Session" as the primary user action.

See `TASK-MANAGEMENT.md` for the authoritative domain model and
`SESSION-MANAGEMENT.md` for backend-specific identity/resume behavior.

## 7. MCP Integration (two servers per turn)

Each turn merges **two** MCP servers (details in `MCP-INJECTION.md`):

1. **`context_engine`** — user-provided semantic search / codebase tools (stdio).
2. **`muster_bridge`** — extension-owned `ask_user` for human-in-the-loop (`MUSTER-BRIDGE.md`).

At turn start we generate/pass a merged MCP config (or use per-CLI discovery). Goal: agents can search context **and** ask the user without leaving the turn.

## 8. Implementation Roadmap (Suggested)

1. **Design & Types** (this doc + `types.ts`)
2. **TaskStore + TaskEngine** (versioned task, turn, message, and session-binding state)
3. **Command builders** for all 4 CLIs (with MCP injection)
4. **ACP client + event mapper** — Grok first (done), then Claude/Codex/agy on the same path
5. **Minimal webview** that consumes normalized events
6. **Muster Bridge** — `AskBridge` + HTTP MCP `ask_user` (Claude first)
7. **Codex backend**
8. **Antigravity (agy) backend** — deferred for ask UI until streaming tool events improve
9. Polish: error handling, cancellation, version detection, raw event logging

## 9. Risks & Open Questions

- Shared ACP agent blast radius (one crashed agent process affects all in-flight sessions on that backend).
- Antigravity ACP entry point unverified (agy `ask_user` spike OK on legacy path — see `MUSTER-BRIDGE.md` §7).
- stdio MCP servers (`context_engine`) need http/sse proxy for ACP injection — Muster Bridge is already http.
- ACP `session/update` schema drift across CLI versions.

## 10. References

- Grok Build VS Code plugin study (`study/grok-build-vscode-src/`)
- [Agent Client Protocol](https://agentclientprotocol.com) spec + per-CLI ACP entry commands (`CLI-COMMANDS.md`)
- Model Context Protocol (MCP) specification
- `docs/MUSTER-BRIDGE.md` — MCP `ask_user` + AskBridge design

---

**Status**: Living document. Update as we learn from contract spikes and implementation.
