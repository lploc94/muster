# CLI Invocation Reference

This document contains the exact commands, flags, and behaviors for headless usage + resume + MCP.

Use this as the source of truth when implementing each backend.

> **Verified against** (2026-07-06, from `--help` + empirical runs on this machine):
> Claude Code 2.1.201 · Grok 0.2.87 · codex-cli 0.142.1 · agy 1.0.16
>
> CLI flags change over time. When bumping a CLI version, re-check the flags used by its adapter and update this doc (the adapter should also log the CLI version at turn start — see ADAPTER-SPEC.md).

## General Principles (MVP)
- Always spawn a **fresh process per turn**.
- Use streaming / JSON output.
- Pass explicit session ID for resume (never rely only on "continue last").
- Inject MCP config so the agent can see the context engine tool.
- Capture the session ID after the turn if the CLI returns one.

## Permissions in headless mode (important)

There is no interactive prompt in headless mode. If the coordinator doesn't set an explicit permission policy, tool calls either get **silently denied** or the turn stalls. Every adapter must pass a permission strategy:

| CLI | Mechanism |
|-----|-----------|
| Claude | `--permission-mode <mode>`, `--allowedTools "Bash,Edit,..."`, or `--dangerously-skip-permissions` |
| Grok | `--permission-mode <default\|acceptEdits\|auto\|dontAsk\|bypassPermissions\|plan>`, `--allow`/`--deny` rules, or `--always-approve` |
| Codex | `-s/--sandbox <read-only\|workspace-write\|danger-full-access>`, or `--dangerously-bypass-approvals-and-sandbox` |
| Antigravity | `--dangerously-skip-permissions`, `--sandbox`, or pre-approved rules in `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`) |

**MVP decision needed**: expose this as a per-backend setting (e.g. default to an "accept edits / workspace-write" level, with an opt-in "bypass everything" toggle). Do not hardcode the bypass flags.

---

## Claude Code

### Basic headless
```bash
claude -p "your prompt here"
```

### Streaming (recommended)
```bash
claude -p "your prompt here" \
  --output-format stream-json \
  --include-partial-messages \
  --verbose
```

⚠️ **`--verbose` is required**: with `-p/--print`, `--output-format=stream-json` errors out without it (verified on 2.1.201: `Error: When using --print, --output-format=stream-json requires --verbose`).

### Resume
```bash
claude -p "continue this" --resume <session-id>
# or
claude -p "continue this" -c          # continue most recent (use with care)
```

`--fork-session` can be added when resuming to branch into a new session ID instead of appending to the original.

### New session with pre-generated ID
```bash
claude -p "..." --session-id <uuid>   # coordinator generates the UUID, so identity is known upfront
```

### MCP injection (context engine)
```bash
claude -p "..." \
  --mcp-config /path/to/context-engine.json \
  --strict-mcp-config
```

`--mcp-config` accepts **file paths or inline JSON strings** (space-separated, repeatable) — the inline form avoids temp files entirely.

Example `context-engine.json`:
```json
{
  "mcpServers": {
    "context_engine": {
      "command": "node",
      "args": ["/absolute/path/to/your/context-engine/dist/index.js"],
      "env": {}
    }
  }
}
```

### Session ID extraction
In `stream-json` mode the first event is a system/init event carrying `session_id` — emit `sessionStarted` from it. (Re-verify the exact shape per version; keep raw lines for debugging.)

### Notes for MVP
- `--include-partial-messages` gives token-by-token streaming deltas.
- `--strict-mcp-config` ensures only the servers we pass are used.
- `--max-turns` and `--max-budget-usd` exist as safety rails if we ever want them.
- Avoid `--no-session-persistence` — it makes the session non-resumable.

---

## Grok

### Basic headless
```bash
grok -p "your prompt here"      # -p is short for --single
```

### Streaming
```bash
grok -p "your prompt here" --output-format streaming-json
```

`--output-format` values: `plain` (default) | `json` | `streaming-json`.

### Resume
```bash
grok -p "continue" --resume <session-id>
# or
grok -p "continue" --continue    # most recent session for this cwd (use with care)
```

`--fork-session` is available when resuming (optionally combined with `--session-id` to name the fork).

### New session with pre-generated ID
```bash
grok -p "..." --session-id <uuid>   # new conversations only; must be a fresh UUID
```

### MCP
No per-invocation MCP config flag (verified 0.2.82 — nothing like Claude's `--mcp-config`). Grok discovers MCP servers from:
- `.mcp.json` in the working directory
- Global config, managed via `grok mcp add/list/remove/doctor`

For MVP:
- **Option A (preferred)**: write a temp `.mcp.json` into the spawn `cwd` (or a dedicated cwd) before the turn.
- **Option B**: one-time `grok mcp add context_engine ...` global registration.

`grok mcp doctor` is useful when debugging discovery/connectivity.

### `streaming-json` event shapes (verified 0.2.87)

NDJSON — one JSON object per line. Only three event types observed in headless mode:

```jsonl
{"type":"thought","data":"The"}                 // reasoning, token-by-token
{"type":"text","data":"hello"}                  // assistant answer, token-by-token
{"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
```

- `thought` = reasoning deltas; `text` = assistant deltas (concatenate `data` chunks).
- `end` is the **only** terminal marker; `sessionId` appears **only** in `end` (after content).
- **No structured tool events** in headless `streaming-json` — tool activity is internal to Grok.
- `--session-id <uuid>` is honored for new sessions (v4 UUID verified).
- `stopReason` observed: `EndTurn` (success). Map `Error`/`Refusal` to adapter errors if seen.
- Permission mode `default` completes noninteractively for edit + shell turns (least-permissive verified).

### Notes
- `--max-turns <N>` exists as a safety rail.

### Alternative: ACP mode (`grok agent stdio`) — proven, but long-lived

`~/projects/grok-implement/skill-packs/grok-implement/scripts/grok-runner.js` is a working reference that drives Grok via **ACP** (JSON-RPC 2.0 over stdio, newline-delimited) instead of headless `-p`:

- Handshake: `initialize` (protocolVersion 1, client capabilities fs/terminal) → `authenticate` (`xai.api_key` if `XAI_API_KEY` set, else `cached_token`) → `session/new { cwd, mcpServers: [...] }` → returns `sessionId`.
- **MCP servers are passed programmatically in `session/new`** — no `.mcp.json` temp file needed at all.
- Send a turn: `session/prompt { sessionId, prompt: [{type:"text", text}] }` → resolves with `{ stopReason }`.
- Streaming: `session/update` notifications, discriminated by `update.sessionUpdate`: `agent_message_chunk`, `agent_thought_chunk` (token-by-token — buffer before rendering), `tool_call`, `tool_call_update` (carries `toolCallId`, `title`, `kind`, `status`, `rawInput`, `rawOutput`, `locations`) — maps almost 1:1 onto our NormalizedEvent model.
- Cancel: `session/cancel` notification (cooperative, with kill-tree fallback after a grace period).
- ⚠️ The client **must answer server-initiated requests**: `session/request_permission` (headless → auto-approve policy), `fs/read_text_file`, `fs/write_text_file`, `terminal/*`.

**Trade-off**: ACP requires keeping the `grok agent stdio` process alive across turns, which conflicts with our per-turn-spawn principle (DESIGN.md §2.1). For MVP stick with headless `-p --output-format streaming-json`; treat ACP as the fallback if headless streaming-json turns out to lack tool/reasoning fidelity, and as the authoritative reference for what Grok events look like.

---

## Codex

### Non-interactive
```bash
codex exec "your prompt here"
```

### Streaming
```bash
codex exec "your prompt here" --json     # JSONL events on stdout
```

### Resume
```bash
codex exec resume <session-id> "your next prompt"
# or
codex exec resume --last "your next prompt"     # most recent recorded session
```

⚠️ Note the syntax: `resume` is a **subcommand** of `exec`, the session ID and follow-up prompt are positional arguments, and `--last` belongs to `resume` (there is no `codex exec "..." --last`).

### Useful flags
- `-C, --cd <dir>` — working root for the agent (instead of relying on process cwd).
- `--skip-git-repo-check` — needed when running outside a git repo.
- `-o, --output-last-message <file>` — writes the final message to a file (handy fallback).
- ⚠️ Avoid `--ephemeral` — it skips session persistence, which **breaks resume**.

### MCP
Use repeatable `-c` config overrides (TOML values) or pre-register:
```bash
codex exec "..." \
  -c 'mcp_servers.context_engine.command="node"' \
  -c 'mcp_servers.context_engine.args=["/absolute/path/to/context-engine/dist/index.js"]'
```

Or one-time via `codex mcp add`.

### JSONL event shapes (from the proven runner)

Verified in production by `~/projects/codex_skill/skill-packs/codex-review/scripts/codex-runner.js` (reference implementation — study it before writing the Codex adapter):

| Event | Meaning / payload |
|-------|-------------------|
| `{"type":"thread.started","thread_id":"..."}` | **Session/thread ID** → emit `sessionStarted` from this |
| `{"type":"turn.started"}` | Turn began |
| `{"type":"item.completed","item":{"type":"reasoning","text":"..."}}` | Reasoning (arrives as completed items, not deltas) |
| `{"type":"item.started"/"item.completed","item":{"type":"command_execution","command":"..."}}` | Tool (shell) start/end |
| `{"type":"item.completed","item":{"type":"file_change","changes":[{"path","kind"}]}}` | File edits |
| `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}` | **Final assistant message** |
| `{"type":"turn.completed"}` / `{"type":"turn.failed","error":{"message"}}` | Terminal success / failure |

Other proven practices from that runner:
- **Pass the prompt via stdin**, not argv (avoids quoting/length issues): `codex exec ... ` with prompt piped in; on resume use the `-` positional (`codex exec ... resume <thread_id> -`).
- Reasoning effort via `--config model_reasoning_effort=<low|medium|high>`.
- Exact arg order used: `codex exec --skip-git-repo-check --json --sandbox <mode> --config model_reasoning_effort=<effort> -C <working-dir>` (new session), `codex exec --skip-git-repo-check --json --config model_reasoning_effort=<effort> resume <thread_id> -` (resume).

---

## Antigravity (agy)

### Basic headless
```bash
agy -p "your prompt here"       # -p is short for --print / --prompt
```

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

Do **not** assume Claude/Grok-style NDJSON streaming on agy yet. Re-check when upgrading agy.

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

There is no equivalent of Grok ACP's programmatic `mcpServers` in `session/new` for headless `-p` mode.

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

### Adapter implications (vs Claude/Grok/Codex)

| Capability | agy 1.0.16 | Notes |
|------------|------------|-------|
| Headless per-turn spawn | ✅ `-p` | Matches our model |
| Structured stdout | ✅ `--output-format json` | Hidden flag; single blob, not NDJSON |
| Token streaming to UI | ❌ in JSON mode; ⚠️ line chunks in plain mode | Weaker than Claude `stream-json` |
| Tool/reasoning events | ❌ structured | Only narrative in `response` text |
| Explicit resume ID | ✅ `--conversation` | Field name is `conversation_id`, not `session_id` |
| Pre-assign session ID | ❌ | CLI assigns UUID |
| Per-turn MCP inject | ⚠️ file-based only | No CLI flag |
| Cancellation | ⚠️ kill process | No documented `AbortSignal` flag; SIGTERM the child |

**Status in MVP**: implement **after** Claude + Grok + Codex. Use `--output-format json` as the primary parser target; keep plain-text line reading as an optional streaming shim. Mark as **experimental** until agy ships real NDJSON/streaming tool events.

---

## Quick Comparison Table (MVP)

| CLI | Headless | Streaming | Resume | New session w/ own ID | MCP injection | Permission policy | Streaming quality |
|-----|----------|-----------|--------|----------------------|---------------|-------------------|-------------------|
| Claude | `-p` | `--output-format stream-json --include-partial-messages --verbose` | `--resume <id>` | `--session-id <uuid>` | `--mcp-config <file\|json> --strict-mcp-config` | `--permission-mode` / `--allowedTools` | Excellent |
| Grok | `-p` (`--single`) | `--output-format streaming-json` | `--resume <id>` | `--session-id <uuid>` | `.mcp.json` in cwd or `grok mcp add` | `--permission-mode` / `--allow` | Good |
| Codex | `exec` | `--json` | `exec resume <id> "prompt"` | — | `-c mcp_servers.*` overrides | `--sandbox <mode>` | Good |
| Antigravity | `-p` | `--output-format json` (single blob; no NDJSON yet) | `--conversation <id>` | — (CLI assigns `conversation_id`) | `~/.gemini/config/mcp_config.json` (file-based) | `--dangerously-skip-permissions` / `--sandbox` / `settings.json` rules | Weak / experimental |

---

## Recommendations for MVP

1. Implement **Claude** first — best combination of streaming + explicit MCP support.
2. Implement **Grok** second — same headless/resume/session-id shape as Claude, only MCP injection differs.
3. Add **Codex**.
4. Add **Antigravity** last (treat as bonus/experimental).

For each backend, create a small test script first that:
- Runs a prompt
- Continues with a known session ID
- Passes MCP config
- Exercises the permission policy (a turn that edits a file must succeed headlessly)
- Prints normalized events to console

This gives fast feedback before wiring into VS Code.

## Reference implementations (study before coding)

Two battle-tested runners in sibling projects already solve process management (detached spawn, kill-tree, watchdog/stall detection, atomic state files) and output parsing:

- **Codex**: `~/projects/codex_skill/skill-packs/codex-review/scripts/codex-runner.js` — headless `codex exec --json` per turn, prompt via stdin, `thread.started`/`turn.completed` lifecycle. Closest to our adapter model.
- **Grok**: `~/projects/grok-implement/skill-packs/grok-implement/scripts/grok-runner.js` — ACP `grok agent stdio` broker. Different lifecycle than ours, but the authoritative source for Grok event shapes, MCP injection via `session/new`, cancel, and permission handling.
- **Antigravity (plain-text shim)**: `agy-as-claude.sh` in ralphex — wraps agy plain output into Claude-style deltas. Useful if we need incremental text before agy ships real streaming.

## Open items to verify empirically

- [x] ~~Exact event shape carrying the session/thread ID in `codex exec --json`~~ → `{"type":"thread.started","thread_id":...}` (confirmed by codex-runner.js).
- [ ] Event shapes for reasoning + MCP tool calls in Grok **headless** `streaming-json` (ACP shapes are known — see above — but the `-p` path needs its own check).
- [x] ~~Antigravity headless JSON output + session ID~~ → `--output-format json` (hidden flag); `conversation_id` in single stdout JSON blob; `status`/`error`/`usage` confirmed on 1.0.16. **No** `--json` alias. `streaming-json`/`ndjson`/etc. not implemented yet.
- [x] ~~Location of Antigravity MCP config~~ → primary path `~/.gemini/config/mcp_config.json`; permissions in `~/.gemini/antigravity-cli/settings.json`; project overrides in `~/.gemini/config/projects/<id>.json`.
- [ ] Whether agy will add NDJSON/streaming tool events in a future release (re-check `--help` + `--output-format` values on upgrade).
- [ ] Whether Grok picks up a freshly written `.mcp.json` in `cwd` at spawn time (Option A) — moot if we adopt ACP later.
