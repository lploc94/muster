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

## Presentation verification and live-host evidence

Presentation verification has three distinct proof classes. Run them in this order:

```bash
# Local authorization, lifecycle, security, production build, and browser gate
npm run test:presentation-integration

# Explicit mixed/live-runtime preconditions (the integration gate includes these,
# but run them visibly when collecting a new live attempt)
npm run compile
npm run test:webview -- e2e/muster-presentation.spec.ts
```

The focused Playwright command uses its configured localhost web server. A non-zero exit, timeout, missing browser, or unavailable server is a local-gate failure: fix it or report it; do not convert it into live evidence.

Next, press **F5** to launch the actual VS Code **Extension Development Host**. Use an authenticated coordinator with short synthetic content to attempt opening, same-ID updating, multi-ID isolation, Mermaid fallback, linked-chat reveal, existing-task revision, supported restore, disposal, and final cleanup.

Record the attempt in `docs/uat/m006-s05/presentation-live-host-evidence.md`:

- give every scenario exactly one `PASS`, `FAIL`, or `ENVIRONMENT BLOCKED` verdict and a UTC timestamp;
- use `PASS` only for bounded observation in the actual Extension Development Host;
- use `FAIL` for reproducible product behavior observed in that host;
- use `ENVIRONMENT BLOCKED` when host control, authentication, backend connectivity, or reload automation prevents the scenario, naming both the attempted step and concrete blocker;
- record final cleanup and no-resurrection state explicitly; and
- never include credentials, secrets, prompts, transcript content, raw task-store data, workspace identity, or absolute local paths.

Local integration and Playwright results are **supportive only**. They do not prove live-host behavior or upgrade a live verdict. Validate the ledger with `npm run test:presentation-live-evidence`; its errors identify the scenario or evidence rule that failed.

## File-drop verification and live-host evidence

Workspace file drops create textual mentions, not attachments. Before collecting live evidence, run the local contract gates:

```bash
npm test
npm run compile
npm run test:webview -- e2e/muster-webview-state.spec.ts
npm run test:file-drop-docs
npm run test:file-drop-live-evidence
```

The focused browser test uses synthetic host messages and is **supportive only**. Press **F5** and use the actual Extension Development Host for live proof. Attempt all eight ledger scenarios, including a drag from VS Code Explorer, a drag from the operating-system file manager, caret insertion, a path with spaces, outside-workspace rejection, disabled-composer no-op, malformed payload handling, and cleanup/reload.

Record each scenario in `docs/uat/m007-s02/file-drop-live-host-evidence.md` with one `PASS`, `FAIL`, or `ENVIRONMENT BLOCKED` verdict, a UTC timestamp, expected and observed results, bounded evidence, blocker detail, and cleanup. Use `ENVIRONMENT BLOCKED` only after naming the attempted step and concrete unavailable control. Never promote unit or Playwright results to live proof, and never record absolute paths, workspace identity, file contents, credentials, raw transcripts, or task-store data.

## Queue and live-inject verification

Multi-queued FIFO follow-ups and Ctrl+Enter live inject are documented in
[docs/TASK-MANAGEMENT.md](docs/TASK-MANAGEMENT.md) §9.1 and
[docs/WEBVIEW.md](docs/WEBVIEW.md) §14. Before claiming those surfaces, run:

```bash
npm run test:queue-live-inject-docs
npm run test:webview -- e2e/muster-webview-state.spec.ts
```

The doc verifier checks keyboard contract markers (`Enter` → `send` FIFO,
`Ctrl+Enter` → `sendLiveInput` with no queue fallback), `queuedTurns` edit/delete,
and visible `liveInputResult` / `commandError` feedback. Playwright covers the
browser-visible composer against the Vite webview with synthetic host messages
and is **supportive only** for live Extension Development Host keyboard proof.

Optional live check: press **F5**, open a running task, confirm Enter stacks
queue rows, Ctrl+Enter either delivers a notice or shows a refusal banner, and
stale queue mutations surface `commandError` without silent success.

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