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

Requires `claude` and/or `grok` on `PATH` for backend testing.

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

See [docs/MVP-SCAFFOLD-PLAN.md](docs/MVP-SCAFFOLD-PLAN.md) for phased goals. Good first tasks:

- Migrate Claude backend to ACP (`claude-code-acp` on `acp-client.ts`)
- Muster Bridge (`AskBridge` + HTTP MCP)
- Claude / Codex / Antigravity ACP adapter migrations
- Webview UX (tool cards, reasoning, question UI)

## Pull requests

1. Fork and create a branch from `main`.
2. Keep changes focused — match existing style in `src/`.
3. Run `npm run compile` before opening a PR.
4. Describe which doc/phase your PR addresses.

## Questions

Open a GitHub issue with context and which backend/CLI you are using.