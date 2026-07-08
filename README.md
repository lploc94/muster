# Muster

Open-source VS Code extension that **coordinates** multiple AI coding CLIs from one chat UI:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Grok CLI](https://github.com/xai-org/grok-cli)
- [Kiro CLI](https://kiro.dev)
- [Codex CLI](https://github.com/openai/codex)
- [OpenCode](https://opencode.ai)
- [Antigravity / agy](https://antigravity.google/product/antigravity-cli) (planned)

**Status:** Early MVP — **ACP-only**, **task-model** architecture (`TaskEngine` is the sole host path). Five ACP backends are implemented: **Claude, Grok, Kiro, Codex, OpenCode**. Grok, Kiro, and OpenCode speak ACP natively; Claude and Codex use standard ACP adapters (`claude-agent-acp` / `codex-acp`) that are **bundled into the extension** so no extra install is needed beyond the CLI itself. Legacy flat chat and `.muster-sessions.json` were removed in Phase E (archived on first activation). See [docs/TASK-MANAGEMENT.md](docs/TASK-MANAGEMENT.md).

## Features (current & planned)

| Feature | Status |
|---------|--------|
| ACP client (`acp-client.ts`) | ✅ |
| Grok ACP backend (`grok --no-auto-update agent stdio`) | ✅ |
| Kiro ACP backend (`kiro-cli acp`) | ✅ |
| OpenCode ACP backend (`opencode acp`) | ✅ |
| Claude ACP backend (bundled `@agentclientprotocol/claude-agent-acp`) | ✅ |
| Codex ACP backend (bundled `@agentclientprotocol/codex-acp`) | ✅ |
| Antigravity ACP backend | 🔜 (entry TBD) |
| Session resume (`session/load`) | ✅ |
| Task model (`TaskStore` + `TaskEngine`) | ✅ |
| Webview task UI (list + workspace, protocol v2) | ✅ |
| Muster Bridge + coordinator tools | ✅ |
| MCP via `mcpServers` (context + Bridge) | ✅ |
| MCP `ask_user` (Muster Bridge) | ✅ — [design](docs/MUSTER-BRIDGE.md) |
| Reload recovery UI (Retry / Continue / Resume) | ✅ |

## Prerequisites

- **Node.js** 20+ (CI and the M002 quality gate target Node 24 LTS)
- **VS Code** 1.94+
- The CLI for whichever backend you use, on `PATH` and logged in:
  - **Claude Code** (`claude`) — Claude backend
  - **Grok CLI** (`grok`) — Grok backend
  - **Kiro CLI** (`kiro-cli`) — Kiro backend
  - **Codex CLI** (`codex`) — Codex backend
  - **OpenCode** (`opencode`) — OpenCode backend

The Claude and Codex ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) are **bundled into the extension** (`resources/*/index.mjs`) and pointed at your installed CLI via `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`, so no extra install is required. Grok, Kiro, and OpenCode speak ACP natively (`… agent stdio` / `acp`).

## Development

```bash
git clone https://github.com/lploc94/muster.git
cd muster
npm install
npm run watch   # compile on save
```

In VS Code: **Run and Debug → Run Extension** (or **F5**). This opens an Extension Development Host with Muster loaded.

### Console runner (no UI)

Each backend has an `mvp:<backend>` script that runs one ACP turn from the terminal:

```bash
npm run mvp:claude   -- "your prompt here"
npm run mvp:grok     -- "your prompt here"
npm run mvp:kiro     -- "your prompt here"
npm run mvp:codex    -- "your prompt here"
npm run mvp:opencode -- "your prompt here"

# resume a session
RESUME_ID=<session-id> npm run mvp:claude -- "continue"
```

`ABORT_MS=<ms>` schedules an abort to exercise cancellation.

### MCP ask spike (agy)

```bash
npm run test:agy-ask
```

Dev-only file IPC proof — production design uses [Muster Bridge](docs/MUSTER-BRIDGE.md).

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/DESIGN.md](docs/DESIGN.md) | Architecture overview |
| [docs/ADAPTER-SPEC.md](docs/ADAPTER-SPEC.md) | Backend adapter contract |
| [docs/CLI-COMMANDS.md](docs/CLI-COMMANDS.md) | Per-CLI flags & streaming |
| [docs/MUSTER-BRIDGE.md](docs/MUSTER-BRIDGE.md) | MCP `ask_user` + AskBridge |
| [docs/MCP-INJECTION.md](docs/MCP-INJECTION.md) | MCP config per backend |
| [docs/SESSION-MANAGEMENT.md](docs/SESSION-MANAGEMENT.md) | Session IDs & resume |
| [docs/TASK-MANAGEMENT.md](docs/TASK-MANAGEMENT.md) | Task/turn model & TaskEngine |

Full index: [docs/README.md](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)