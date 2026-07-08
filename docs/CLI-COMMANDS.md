# CLI Invocation Reference

Muster integrates with coding CLIs **only through ACP** ([Agent Client Protocol](https://agentclientprotocol.com)) — JSON-RPC 2.0 over stdio. **Headless** modes (`-p`, `exec`, NDJSON stdout) are **not used** by Muster adapters.

Use this as the source of truth when implementing each backend.

> **Verified against** (from `--help` + empirical ACP runs on this machine):
> Claude Code 2.1.201 · Grok 0.2.87 · Kiro CLI (`kiro-cli acp`) · codex-cli 0.142.5 (via `codex-acp`) · OpenCode 1.15.12 · agy 1.0.16
>
> Re-check ACP entry commands and `session/update` shapes when bumping CLI versions.

## General Principles (MVP)

Each user message = one adapter `run()` = one **ACP session** (`session/new` or `session/load`).

| Backend | ACP agent command | Adapter status |
|---------|-------------------|----------------|
| Grok | `grok --no-auto-update agent stdio` | ✅ implemented |
| Kiro | `kiro-cli acp` | ✅ implemented |
| OpenCode | `opencode acp` | ✅ implemented |
| Claude | bundled `@agentclientprotocol/claude-agent-acp` (`CLAUDE_CODE_EXECUTABLE` → user's `claude`) | ✅ implemented |
| Codex | bundled `@agentclientprotocol/codex-acp` (`CODEX_PATH` → user's `codex`, wraps `codex app-server`) | ✅ implemented |
| Antigravity | TBD — verify ACP entry on implement | 🔜 experimental |

Shared rules (all backends):

- One **shared** ACP agent process per backend type for the extension lifetime.
- One **ACP session per turn** — not a session pool across unrelated conversations.
- Stream via `session/update` notifications → `NormalizedEvent`.
- Resume via `session/load { sessionId }` (never rely only on `--continue` / `--last`).
- Inject MCP via `mcpServers` on `session/new` / `session/load` (http/sse).
- Cancel via `session/cancel` notification.
- Emit `sessionStarted` from `session/new` (or at start of `session/load`).

## Shared ACP lifecycle

```text
spawn <backend-acp-agent>     # stdio JSON-RPC peer (long-lived)
  → initialize { protocolVersion, clientCapabilities }
  → authenticate { methodId, _meta: { headless: true } }   # when required
  → session/new { cwd, mcpServers } | session/load { sessionId, cwd, mcpServers }
  → session/prompt { sessionId, prompt: [{ type: "text", text }] }
  ← session/update notifications (streaming)
  ← session/prompt response { stopReason }                  # terminal signal
  → session/cancel                                            # on user abort
```

**Client capabilities (Muster default):** declare `fs` and `terminal` **off** unless we intentionally proxy IDE operations. Auto-allow `session/request_permission` in coordinator mode (no interactive TTY).

**MCP over ACP:** pass `mcpServers` as http/sse entries on `session/new`/`session/load`. stdio MCP is rejected by some agents — use http URLs (Muster Bridge pattern) or an sse/http proxy for `context_engine`.

---

## Claude Code (ACP)

**Muster adapter:** ACP via the **bundled** `@agentclientprotocol/claude-agent-acp` (stdio). The adapter is vendored as a single self-contained esbuild bundle at `resources/claude-acp/index.mjs` and spawned under Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1` in the extension host). `CLAUDE_CODE_EXECUTABLE` points it at the user's installed `claude`, so no extra install is needed and the heavy platform binary is never used.

```bash
# how Muster launches it (conceptually):
CLAUDE_CODE_EXECUTABLE=claude node resources/claude-acp/index.mjs   # JSON-RPC 2.0 over stdio
```

Lifecycle matches §Shared ACP lifecycle. Verified live (claude-agent-acp 0.56.0 + claude 2.1.201): `initialize` → `agentCapabilities.loadSession: true`, `mcpCapabilities.http: true`, `authMethods: []`. Observed `session/update` kinds: `agent_thought_chunk` → `reasoningDelta`, `agent_message_chunk` → `assistantDelta`, `tool_call`/`tool_call_update` → tool events, `usage_update` → `usage`; unknown/non-normalized → `raw`.

**MCP:** `mcpServers` on `session/new`/`session/load` — same http/sse schema as Grok. Do **not** use `--mcp-config`.

**Permissions:** `session/request_permission` auto-allowed by the shared ACP client (coordinator mode); `fs/*` and `terminal/*` declared off (the `claude` process does its own file access).

**Auth:** no ACP `authenticate` step — Claude uses its cached login or `ANTHROPIC_API_KEY` consumed by the CLI/SDK directly.

**Regenerate the bundle:** `npm run vendor:claude-acp` (pinned to a known version; also emits `LICENSE` + `THIRD-PARTY-LICENSES.txt`).

---

## Grok

**Muster adapter:** ACP (`grok --no-auto-update agent stdio`) — one shared agent process, one ACP session per turn. Reference: `study/grok-build-vscode-src`.

### ACP lifecycle (verified 0.2.87)

```bash
grok --no-auto-update agent stdio   # JSON-RPC 2.0, newline-delimited stdin/stdout
```

1. `initialize { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }`
2. `authenticate { methodId, _meta: { headless: true } }` — `xai.api_key` if `XAI_API_KEY` set, else `cached_token`
3. New turn: `session/new { cwd, mcpServers: [] }` → `sessionId` (emit `sessionStarted` immediately)
4. Resume: `session/load { sessionId, cwd, mcpServers: [] }` (replays a few history updates — adapter registers sink **after** load completes)
5. Turn: `session/prompt { sessionId, prompt: [{ type: "text", text }] }` → `{ stopReason, _meta }` (sole terminal signal)
6. Cancel: `session/cancel` **notification** (no `id`) — `stopReason: "cancelled"`

### `session/update` → NormalizedEvent (verified 0.2.87)

| `sessionUpdate` | Maps to |
|---|---|
| `agent_thought_chunk` | `reasoningDelta` |
| `agent_message_chunk` | `assistantDelta` |
| `tool_call` / `tool_call_update` | `toolStarted` / `toolUpdated` / `toolCompleted` |
| `user_message_chunk`, `available_commands_update` | ignored |
| other | `raw` |

`stopReason` observed: `end_turn` (success), `cancelled` (cancellation). Map `refusal` / `error` / `max_tokens` to adapter `error`.

### MCP injection (ACP)

Per-session `mcpServers` on `session/new` / `session/load`. **stdio MCP is rejected** over ACP; use http/sse entries:

```json
{ "type": "http", "name": "muster_bridge", "url": "http://127.0.0.1:<port>/mcp", "headers": [] }
```

File-based discovery (`~/.grok/config.toml`, `.mcp.json`) still loads inside sessions — injection is additive.

### Server→client requests (Muster posture)

- `session/request_permission` → auto-allow (coordinator has no interactive TTY)
- `fs/*`, `terminal/*` → unsupported (capabilities declared off; Grok uses built-in tools)
- `_x.ai/*` extension notifications (no `id`) → ignored

---

## Kiro (ACP)

**Muster adapter:** ACP (`kiro-cli acp`) — the user's installed Kiro CLI speaks ACP natively; no adapter/bundle needed.

```bash
kiro-cli acp   # JSON-RPC 2.0 over stdio
```

Lifecycle matches §Shared ACP lifecycle. **Auth:** Kiro authenticates transparently via cached login (`kiro-cli login`) or `KIRO_API_KEY`; it typically advertises no `authMethods`, so no `authenticate` step runs. `session/update` kinds map like Grok (`agent_thought_chunk`→reasoning, `agent_message_chunk`→assistant, `tool_call`/`tool_call_update`→tool events; `user_message_chunk`/`available_commands_update` ignored; unknown→`raw`). MCP via `mcpServers` (http). Tool call IDs are namespaced `kiro:`.

---

## OpenCode (ACP)

**Muster adapter:** ACP (`opencode acp`) — OpenCode is ACP-native; no adapter/bundle needed.

```bash
opencode acp   # JSON-RPC 2.0 over stdio
```

Lifecycle matches §Shared ACP lifecycle. Verified live (opencode 1.15.12): `initialize` → `agentCapabilities.loadSession: true`, `mcpCapabilities.http: true`, `authMethods: ["opencode-login"]`. **Auth:** even though `opencode-login` is advertised, it uses cached credentials (`opencode auth login` → auth.json) or `OPENCODE_API_KEY` transparently, so Muster does **not** call `authenticate` (that method is interactive). Observed `session/update` kinds: `agent_thought_chunk`→reasoning, `agent_message_chunk`→assistant, `usage_update`→usage, `available_commands_update` ignored; unknown→`raw`. Usage is also on the `session/prompt` result. Tool call IDs are namespaced `opencode:`.

---

## Codex (ACP)

**Muster adapter:** ACP via the **bundled** `@agentclientprotocol/codex-acp` (stdio). Codex's native `codex app-server` speaks a proprietary thread/turn JSON-RPC protocol (not ACP), so Muster uses the `codex-acp` adapter, which wraps `codex app-server` and exposes standard ACP. It is vendored as a single self-contained bundle at `resources/codex-acp/index.mjs` and spawned under Node; `CODEX_PATH` points it at the user's installed `codex`.

```bash
# how Muster launches it (conceptually):
CODEX_PATH=codex node resources/codex-acp/index.mjs   # JSON-RPC 2.0 over stdio
```

Lifecycle matches §Shared ACP lifecycle. Verified live (codex-acp 1.1.0 + codex-cli 0.142.5): `initialize` → `agentCapabilities.loadSession: true`, `mcpCapabilities.http: true`, `authMethods: [api-key, chat-gpt]`; works with cached ChatGPT login (no explicit `authenticate`). Usage is returned on the `session/prompt` result. `session/update` kinds map like Grok/Kiro; unknown → `raw`.

**MCP:** `mcpServers` on `session/new`/`session/load` (http). Do **not** use `codex exec -c mcp_servers.*`.

**Auth:** API key if `CODEX_API_KEY`/`OPENAI_API_KEY` is set and an api-key method is advertised, otherwise cached ChatGPT login (no `authenticate` step).

**Regenerate the bundle:** `npm run vendor:codex-acp`.

---

## Antigravity (agy) — ACP TBD

**Muster adapter:** ACP entry command **not verified** on agy 1.0.16. Implement only after confirming an ACP stdio mode (e.g. upstream `--acp` or dedicated agent subcommand). Until then, agy is **experimental / blocked** for Muster.

When available, lifecycle and MCP injection follow §Shared ACP lifecycle (`mcpServers` on `session/new`/`session/load`).

### agy notes for ACP implementers (from legacy spikes)

⚠️ **`--print-timeout` defaults to 5m** — long agentic turns will be killed unless we raise it (e.g. `--print-timeout 30m` or `2h`).

⚠️ **Redirect stdin from `/dev/null`** when spawning from the coordinator. If stdin is open, agy may block waiting for input.

### Structured JSON output (headless adapter mode — recommended)

There is **no** `--json` flag (verified 1.0.16: `flags provided but not defined: -json`).

The real flag is **`--output-format json`**, which is present in the binary but **omitted from `agy --help`** on 1.0.16. Use it for machine-readable turns:

```bash
agy -p "your prompt here" \
  --output-format json \
  --dangerously-skip-permissions \
  --print-timeout 30m
```

On success it prints **one JSON object** to stdout (not NDJSON):

```json
{
  "conversation_id": "cb57e064-1917-4bff-9649-cd3acf2eb7ed",
  "status": "SUCCESS",
  "response": "Hi! How can I help you today?\n",
  "duration_seconds": 2.585875,
  "num_turns": 1,
  "usage": {
    "input_tokens": 17932,
    "output_tokens": 96,
    "thinking_tokens": 91,
    "total_tokens": 18028
  }
}
```

On failure:

```json
{
  "conversation_id": "6b5d547a-76a5-4404-ab36-32484c3d2356",
  "status": "ERROR",
  "response": "",
  "error": "timeout waiting for response",
  "duration_seconds": 0.01739,
  "num_turns": 1,
  "usage": { "input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "total_tokens": 0 }
}
```

**Adapter mapping (MVP):**
| JSON field | NormalizedEvent |
|------------|-----------------|
| `conversation_id` | `sessionStarted` (emit once per turn; same ID on resume) |
| `response` | `assistantDelta` (single blob — no token streaming in JSON mode) |
| `usage` | `usage` |
| `status: "SUCCESS"` | `turnCompleted` |
| `status: "ERROR"` | `error` (`message` ← `error` field) |

`thinking_tokens` is reported in `usage` but reasoning text is **not** exposed as separate deltas in JSON mode. Agent/tool steps may appear only as narrative text inside `response`.

### Plain-text output (pseudo-streaming fallback)

Default / `--output-format plain` prints the assistant response as **plain text** to stdout. Useful if we want line-by-line `assistantDelta` events before JSON support is wired, but there is no structured session ID on stdout — extract from logs or switch to JSON mode for resume.

Community reference: `~/projects/.../agy-as-claude.sh` (ralphex) wraps plain agy output into Claude-style `stream-json` by reading stdout line-by-line. Good pattern for a "streaming shim", but it still lacks real tool/reasoning events.

### Output formats tested (1.0.16)

| `--output-format` value | Behavior (1.0.16) |
|-------------------------|-------------------|
| `json` | Single structured JSON object (see above) |
| `plain` (default) | Plain text response |
| `text` | Same as plain |
| `streaming-json`, `ndjson`, `stream-json`, `jsonl`, `events` | **Not implemented** — all fall back to plain text |

Do **not** assume Claude-style NDJSON streaming on agy yet. Re-check when upgrading agy.

### Resume
```bash
agy -p "continue this" --conversation <conversation-id> --output-format json
# or
agy -p "continue this" -c --output-format json    # most recent for this cwd (use with care)
```

Verified: `--conversation <id>` keeps the same `conversation_id` and increments `num_turns`. There is **no** `--session-id <uuid>` flag to pre-assign an ID (unlike Claude/Grok).

⚠️ **1.0.9 fix**: resuming with `-p` used to dump the entire historical transcript instead of only the new response — fixed in 1.0.9+. Stay on ≥ 1.0.9.

### Workspace / project binding

```bash
agy -p "..." \
  --add-dir /path/to/repo \        # repeatable; adds workspace roots
  --project <project-id> \         # bind to an existing Antigravity project
  --new-project                    # create a new project for this session
```

Project metadata lives in `~/.gemini/config/projects/<project-id>.json`. Workspace→project mappings are cached in `~/.gemini/antigravity-cli/cache/projects.json` (since 1.0.4 — no more `.antigravitycli/` dirs in repos).

For the coordinator: pass the user's repo via `--add-dir <cwd>` (repeatable) so file tools operate on the right tree.

### MCP injection (context engine)

No per-invocation MCP flag (unlike Claude's `--mcp-config`). MCP servers are discovered from config files:

| Location | Purpose |
|----------|---------|
| `~/.gemini/config/mcp_config.json` | **Primary** custom MCP config (migrated path; legacy root-level `mcp_config.json` was wrong in older builds — fixed 1.0.3/1.0.14) |
| `~/.gemini/antigravity-cli/settings.json` | CLI permissions (`permissions.allow` must include `mcp(<server>/*)` rules) |
| `~/.gemini/config/projects/<id>.json` | Project-level permission grants (override global) |
| `~/.gemini/settings.json` | Shared with Antigravity 2.0 GUI |

`mcp_config.json` schema (stdio or URL servers):

```json
{
  "mcpServers": {
    "context_engine": {
      "command": "node",
      "args": ["/absolute/path/to/context-engine/dist/index.js"],
      "env": {}
    }
  }
}
```

Since 1.0.5, servers can also be configured with a `"url"` field instead of `command`/`args`.

**MVP injection strategy for the coordinator:**
- **Option A (preferred)**: before spawn, write/merge a temp `mcp_config.json` into `~/.gemini/config/mcp_config.json` (or a project-specific override), then restore afterward if needed.
- **Option B**: pre-register servers globally once; coordinator only ensures permissions allow `mcp(context_engine/*)`.

Legacy `-p` mode has no programmatic `mcpServers` — another reason Muster does not use it.

### Session ID extraction

In `--output-format json` mode, `conversation_id` is authoritative — emit `sessionStarted` from it immediately after parsing stdout.

Fallback: UUID regex over raw output, or reuse the ID passed via `--conversation`.

### Useful flags

```bash
agy -p "..." --model "Gemini 3.5 Flash (Medium)"   # see `agy models`
agy -p "..." --sandbox                              # sandboxed terminal (1.0.6+: works in print mode)
agy -p "..." --dangerously-skip-permissions         # headless auto-approve (use via coordinator setting, not hardcoded)
agy -p "..." --log-file /tmp/agy-turn.log           # debug log (also shown in TUI /help)
```

`agy plugin install/list/...` manages skills/agents from marketplaces — out of scope for MVP adapter unless we need bundled skills.

### Blockers for ACP (agy 1.0.16)

| Capability | agy 1.0.16 | Notes |
|------------|------------|-------|
| ACP stdio entry | ❌ not found in `--help` | Must verify before adapter work |
| Legacy `-p` JSON blob | ✅ `--output-format json` | Spike only — not a Muster adapter path |
| Structured tool events | ❌ in legacy JSON | ACP path must be verified |

**Status:** blocked until agy exposes ACP. Legacy `-p` details are in §Legacy headless modes below (spikes only).

---

## Quick Comparison Table (ACP only)

| CLI | ACP agent command | Bundled? | Resume | MCP injection | Permissions |
|-----|-------------------|----------|--------|---------------|-------------|
| Grok | `grok --no-auto-update agent stdio` | no (native) | `session/load` | `mcpServers` http/sse | auto-allow |
| Kiro | `kiro-cli acp` | no (native) | `session/load` | `mcpServers` http | auto-allow |
| OpenCode | `opencode acp` | no (native) | `session/load` | `mcpServers` http | auto-allow |
| Claude | bundled `claude-agent-acp` (`CLAUDE_CODE_EXECUTABLE`) | yes (`resources/claude-acp/`) | `session/load` | `mcpServers` http | auto-allow |
| Codex | bundled `codex-acp` (`CODEX_PATH`) | yes (`resources/codex-acp/`) | `session/load` | `mcpServers` http | auto-allow |
| Antigravity | TBD | TBD | TBD | TBD | TBD |

---

## Status & next steps

1. **Grok / Kiro / OpenCode** — done, native ACP (`… agent stdio` / `acp`).
2. **Claude / Codex** — done via **bundled** ACP adapters (`claude-agent-acp` / `codex-acp`) pointed at the user's CLI; regenerate with `npm run vendor:claude-acp` / `npm run vendor:codex-acp`.
3. **Antigravity** — blocked until agy exposes an ACP stdio entry.

Each backend has a `scripts/test-<backend>.ts` console runner (`npm run mvp:<backend>`) that exercises ACP: prompt, resume, `mcpServers`, cancel, normalized events.

## Reference implementations (study before coding)

- **Grok:** `study/grok-build-vscode-src/` — ACP dispatch patterns.
- **Claude ACP adapter:** `@agentclientprotocol/claude-agent-acp` (formerly `@zed-industries/claude-code-acp`).
- **Codex ACP adapter:** `@agentclientprotocol/codex-acp` (wraps `codex app-server`).

## Open items to verify empirically

- [x] Grok ACP `session/update` + cancel + `mcpServers` — verified 0.2.87.
- [x] Kiro ACP (`kiro-cli acp`) — verified.
- [x] OpenCode ACP (`opencode acp`) — verified 1.15.12.
- [x] Claude ACP via `claude-agent-acp` — verified 0.56.0.
- [x] Codex ACP via `codex-acp` — verified 1.1.0.
- [ ] Antigravity ACP entry command + `session/update` tool events.

---

## Legacy headless modes (not used by Muster)

The sections below are **reference only** for spikes and CLI exploration. Muster adapters must **not** implement these paths.

### Claude `-p` + `stream-json` (legacy)

```bash
claude -p "prompt" --output-format stream-json --include-partial-messages --verbose
claude -p "continue" --resume <id>
claude -p "..." --mcp-config <file> --strict-mcp-config
```

### Grok `-p` + `streaming-json` (legacy)

```bash
grok -p "prompt" --output-format streaming-json
```

### Codex `exec --json` (legacy)

```bash
codex exec "prompt" --json
codex exec resume <thread_id> "prompt"
```

### agy `-p` (legacy spike — see §Antigravity above for JSON blob shapes)
