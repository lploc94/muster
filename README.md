# Muster

Open-source VS Code extension that **coordinates** multiple AI coding CLIs from one chat UI:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Grok CLI](https://github.com/xai-org/grok-cli)
- [Codex CLI](https://github.com/openai/codex) (planned)
- [Antigravity / agy](https://antigravity.google/product/antigravity-cli) (planned)

**Status:** Early MVP — Claude backend + basic webview chat. See [docs/MVP-SCAFFOLD-PLAN.md](docs/MVP-SCAFFOLD-PLAN.md).

## Features (current & planned)

| Feature | Status |
|---------|--------|
| Headless per-turn CLI spawn | ✅ |
| Claude `stream-json` adapter | ✅ (basic) |
| Session resume (explicit ID) | ✅ |
| Webview chat | ✅ (minimal) |
| MCP context engine injection | 🔜 |
| MCP `ask_user` (Muster Bridge) | 🔜 — [design](docs/MUSTER-BRIDGE.md) |
| Grok `streaming-json` adapter | ✅ (basic) |
| Codex / agy backends | 🔜 |

## Prerequisites

- **Node.js** 20+
- **VS Code** 1.94+
- **Claude Code** CLI (`claude`) on `PATH` for the Claude backend
- **Grok CLI** (`grok`) on `PATH` for the Grok backend
- Other CLIs as backends are added

## Development

```bash
git clone https://github.com/lploc94/muster.git
cd muster
npm install
npm run watch   # compile on save
```

In VS Code: **Run and Debug → Run Extension** (or **F5**). This opens an Extension Development Host with Muster loaded.

### Console runner (no UI)

```bash
npm run mvp:claude -- "your prompt here"
RESUME_ID=<session-id> npm run mvp:claude -- "continue"

npm run mvp:grok -- "your prompt here"
RESUME_ID=<session-id> npm run mvp:grok -- "continue"
```

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
| [docs/MVP-SCAFFOLD-PLAN.md](docs/MVP-SCAFFOLD-PLAN.md) | Implementation phases |

Full index: [docs/README.md](docs/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)