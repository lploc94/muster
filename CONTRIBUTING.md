# Contributing to Muster

Thanks for your interest! This project is in early MVP — docs are ahead of code in places; that's normal.

## Before you start

1. Read [docs/DESIGN.md](docs/DESIGN.md) and [docs/ADAPTER-SPEC.md](docs/ADAPTER-SPEC.md).
2. For backend work, check [docs/CLI-COMMANDS.md](docs/CLI-COMMANDS.md).
3. For MCP / `ask_user`, see [docs/MUSTER-BRIDGE.md](docs/MUSTER-BRIDGE.md).

## Setup

```bash
npm install
npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host.

Requires `claude` on `PATH` for Claude backend testing.

## What to work on

See [docs/MVP-SCAFFOLD-PLAN.md](docs/MVP-SCAFFOLD-PLAN.md) for phased goals. Good first tasks:

- Improve Claude `stream-json` parser (tools, reasoning, errors)
- Muster Bridge (`AskBridge` + HTTP MCP)
- Grok backend adapter
- Webview UX (tool cards, question UI)

## Pull requests

1. Fork and create a branch from `main`.
2. Keep changes focused — match existing style in `src/`.
3. Run `npm run compile` before opening a PR.
4. Describe which doc/phase your PR addresses.

## Questions

Open a GitHub issue with context and which backend/CLI you are using.