# Contributing to Muster

Thanks for your interest! This project is in early MVP — docs are ahead of code in places; that's normal.

## Before you start

1. Read [docs/DESIGN.md](docs/DESIGN.md) and [docs/ADAPTER-SPEC.md](docs/ADAPTER-SPEC.md).
2. For backend work, check [docs/CLI-COMMANDS.md](docs/CLI-COMMANDS.md).
3. For MCP / `ask_user`, see [docs/MUSTER-BRIDGE.md](docs/MUSTER-BRIDGE.md).

## Setup

```bash
npm install
npm run compile   # builds BOTH targets: extension host (tsc) + webview (Vite)
```

Press **F5** in VS Code to launch the Extension Development Host. The default
`watch-all` build task runs `tsc -watch` and the Vite webview watcher in parallel.

Requires the CLI for whichever backend you test on `PATH` (logged in): `claude`,
`grok`, `kiro-cli`, `codex`, and/or `opencode`. The Claude and Codex ACP adapters
are bundled into the extension, so no extra adapter install is needed.

## Webview UI (Svelte + Vite)

The chat sidebar is a **separate build target** under `webview/` (Svelte 5 +
Vite + Tailwind v4 + vscode-elements). Full spec: [docs/WEBVIEW.md](docs/WEBVIEW.md).

- **Two build graphs:** extension host (`tsc` → `dist/src`, CommonJS) and webview
  (`vite` → `dist/webview`, ESM). They do not import each other; the shared
  `NormalizedEvent` contract is duplicated in `webview/src/lib/types.ts`.
- **Build the webview:** `npm run build:webview` (or `npm run compile` for both).
- **Live rebuild:** `npm run watch:webview` next to `npm run watch`, or just F5.
- **Iterate on UI outside VS Code (optional):** the
  [vscode-elements Webview Playground](https://github.com/vscode-elements/webview-playground)
  emulates the `--vscode-*` theme variables.
- The provider loads `dist/webview/assets/index.{js,css}` via `asWebviewUri`
  under a strict CSP — **do not** add inline scripts to the provider HTML.

## What to work on

All five ACP backends (Claude, Grok, Kiro, Codex, OpenCode) are implemented. Good tasks now:

- Antigravity (`agy`) ACP backend once it exposes an ACP stdio entry
- Webview UX (tool cards, reasoning, question UI)
- Hardening the Muster Bridge (`AskBridge` + HTTP MCP) and coordinator tools

## Pull requests

1. Fork and create a branch from `main`.
2. Keep changes focused — match existing style in `src/`.
3. Run `npm run compile` before opening a PR.
4. Describe which doc/phase your PR addresses.

## Questions

Open a GitHub issue with context and which backend/CLI you are using.