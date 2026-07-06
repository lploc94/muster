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
- Long-lived bidirectional sessions (like full ACP)
- Keeping agent processes alive across turns

## 2. Core Architectural Decisions

### 2.1 Headless + Per-Turn Spawn
- Every user message (or continue) results in **one fresh CLI process**.
- No session pool, no long-running child processes.
- The CLI itself is responsible for loading conversation history when we pass the correct resume flags + explicit session ID.

**Rationale**:
- Matches the minimal requirements perfectly.
- Much simpler than the Grok Build VS Code plugin (which needed persistent processes + ACP because of plan mode, live permissions, fs/terminal proxy, etc.).
- Easier debugging, process cleanup, and resource usage.

### 2.2 Explicit Session IDs for Resume
- Never rely solely on `--continue` / `--last` when the plugin can have multiple concurrent conversations in the same workspace.
- Capture and persist the **explicit session ID** returned or used by each CLI.
- When continuing, pass the ID using the CLI's resume flag (`--resume`, `--conversation`, etc.).

### 2.3 MCP Injection at Spawn Time
- The "context engine" is provided to the agent as an **MCP server**.
- We inject the MCP configuration at every spawn so the agent sees the tool during that turn.
- MCP handling is **per-backend** (no single abstraction pretends all CLIs have identical flags).

### 2.4 Streaming Output + Normalization
- All backends are invoked with streaming/JSON output flags.
- Output is parsed into a small set of **normalized events**.
- The UI only deals with the normalized model (makes it easy to add new backends later).

### 2.5 Human-in-the-Loop via Muster Bridge (MCP `ask_user`)
- Agents ask structured questions through MCP tool `ask_user` on server `muster_bridge` — **MCP only**, no text/JSON fallback.
- The **extension host** owns `AskBridge` (in-memory pending asks). The **webview** submits answers via `postMessage`; it does not call MCP directly.
- Preferred transport: **HTTP MCP URL** served locally by the extension. stdio MCP + localhost callback is a fallback.
- A turn remains **one CLI process per user message**, but the process may **pause** until the user answers (not a session pool).
- **Claude `stream-json` first**; **agy deferred** until better streaming/tool events (spike proved MCP blocking works on agy 1.0.16).

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

## 4. Per-CLI Details (Headless + Resume + MCP + Streaming)

### 4.1 Claude Code
- Command: `claude -p "prompt" ...`
- Resume: `--resume <id>` or `-c` (prefer explicit ID)
- Streaming: `--output-format stream-json --include-partial-messages`
- MCP: `--mcp-config <file> --strict-mcp-config`
- Recommended flags for coordinator: `--bare` (optional, for speed) or avoid it if MCP discovery is wanted.

### 4.2 Grok
- Command: `grok -p "prompt" ...`
- Resume: `--resume <id>` or `--continue`
- Streaming: `--output-format streaming-json`
- MCP: Primarily discovered via `.mcp.json` / config (ephemeral injection may be limited → validate)

### 4.3 Codex
- Command: `codex exec "prompt" ...`
- Resume: `codex exec resume <id>` or `--last`
- Streaming: `--json`
- MCP: Via config overrides (`-c mcp_servers...`) or managed profile

### 4.4 Antigravity (agy)
- Command: `agy -p "prompt" ...`
- Resume: `--conversation <id>` or `--continue`
- Streaming: Currently weakest (may fall back to text parsing)
- MCP: Uses `mcp_config.json` (global/workspace)

**Status**: Mark Antigravity as **experimental** until stable JSON streaming + MCP behavior is confirmed.

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
├── SessionStore (legacy flat chat-session path during migration)
├── CommandBuilder / MCPConfig helpers
├── Muster Bridge
│   ├── AskBridge (pending asks, in-memory)
│   └── MusterMcpHttpServer (local HTTP MCP — `ask_user`)
├── Runner (spawn + line-by-line parse + emit events)
└── UI (Webview)
    └── Chat view + question cards (submitAsk → AskBridge)
```

## 6. Session Management

The current chat-only implementation owns a small store of
`{ workspace, backend, sessionId }`. This is a migration path, not the target task
model.

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

At spawn time we generate/pass a merged MCP config (or use per-CLI discovery). Goal: agents can search context **and** ask the user without leaving the turn.

## 8. Implementation Roadmap (Suggested)

1. **Design & Types** (this doc + `types.ts`)
2. **TaskStore + TaskEngine** (versioned task, turn, message, and session-binding state)
3. **Command builders** for all 4 CLIs (with MCP injection)
4. **Runner + basic parser** for Claude + Grok first (best streaming support)
5. **Minimal webview** that consumes normalized events
6. **Muster Bridge** — `AskBridge` + HTTP MCP `ask_user` (Claude first)
7. **Codex backend**
8. **Antigravity (agy) backend** — deferred for ask UI until streaming tool events improve
9. Polish: error handling, cancellation, version detection, raw event logging

## 9. Risks & Open Questions

- Grok `streaming-json` fidelity for reasoning + MCP tool events (needs contract test).
- Antigravity structured output / streaming quality (agy `ask_user` spike OK; adapter/UI deferred — see `MUSTER-BRIDGE.md` §7).
- Ephemeral MCP config support in Grok and Antigravity.
- How reliably CLIs return / expose new session IDs after a turn.
- Schema changes in CLI streaming formats over time.

## 10. References

- Grok Build VS Code plugin study (`study/grok-build-vscode-src/`)
- Official CLI docs (headless, resume, MCP, streaming flags)
- Model Context Protocol (MCP) specification
- `docs/MUSTER-BRIDGE.md` — MCP `ask_user` + AskBridge design

---

**Status**: Living document. Update as we learn from contract spikes and implementation.
