# Changelog

All notable changes to the Muster VS Code extension are documented in this file.

## 0.1.0

First public preview of Muster — coordinate several AI coding CLIs from one
VS Code workspace, with streaming output and resumable sessions.

### Added

- **Run multiple AI CLIs side by side.** Talk to Grok (`grok agent stdio`), Kiro
  (`kiro-cli acp`), and OpenCode (`opencode acp`) using your own installed CLIs.
  Claude and Codex work out of the box through ACP agents bundled with the
  extension, so no extra install is needed for those two.
- **Task-centric workspace.** Work is organised as tasks rather than one throwaway
  chat: a task list and workspace view, read-only presentation tabs for reviewing
  output, and a persistent task store so state survives a window reload.
- **Resume where you left off.** Sessions reload after a restart, and interrupted
  turns offer Retry, Continue, and Resume instead of losing the thread.
- **Ask-the-user prompts from the agent.** Agents can ask clarifying questions
  mid-turn and get your answer inline, via ACP elicitation.
- **Muster Bridge.** A built-in MCP server exposes coordinator tools to connected
  agents, so one CLI can see and act on shared task context. Additional MCP
  servers can be attached through `mcpServers`.

### Packaging

- Installable VSIX with marketplace metadata (icon, `AI` and `Chat` categories)
  built by a single documented `npm run package`.
- Production install closure pruned to `@modelcontextprotocol/sdk`, cutting staged
  `node_modules` entries from 15,801 to 3,104; webview libraries ship pre-bundled.
- Packaging is gated in CI: the archive census, all three spawned entry points, a
  real Extension Host activation, and an install-and-activate run must pass.

### Known limitations

- Early MVP. Antigravity backend is not wired up yet.
- Task storage is reset-only across schema changes; it does not migrate existing
  data yet.
- See the README feature table for what is done versus planned.
