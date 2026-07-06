# MCP Injection (MVP)

## Goal

Each turn injects **two** MCP servers:

1. **`context_engine`** — user's semantic search / codebase tools.
2. **`muster_bridge`** — extension-owned `ask_user` for human-in-the-loop.

`ask_user` design (AskBridge, HTTP MCP, webview flow): **`docs/MUSTER-BRIDGE.md`**

This doc covers **how** those servers are passed per CLI backend.

## General Approach (MVP)

We do **not** try to have one universal way.

For each backend we do what that CLI supports best:

- Claude: Best support → use `--mcp-config <file> --strict-mcp-config`
- Codex: Use `-c` overrides or a temporary config profile
- Grok: Currently relies on `.mcp.json` discovery or global config (ephemeral support is limited)
- Antigravity: Uses `mcp_config.json`

For fast MVP we will:

1. Prepare a small MCP config file that points to your context engine.
2. Pass it using the mechanism supported by the CLI we are calling.
3. Keep the config file simple and version-controlled or generated on the fly.

## Recommended merged config (example)

Generated per turn (or cached in extension storage):

```json
{
  "mcpServers": {
    "context_engine": {
      "command": "node",
      "args": ["/absolute/path/to/context-engine/dist/index.js"],
      "env": {}
    },
    "muster_bridge": {
      "url": "http://127.0.0.1:<extension-port>/mcp"
    }
  }
}
```

If HTTP URL is not supported for a backend, use stdio proxy — see `MUSTER-BRIDGE.md` §4.2.

**Tip**: Use an absolute path during development. Later you can make it configurable via VS Code settings.

## Per Backend (MVP)

### Claude Code (recommended to implement first)

```bash
claude -p "..." \
  --mcp-config /path/to/context-engine.mcp.json \
  --strict-mcp-config
```

- `--strict-mcp-config` is important so only the servers we pass are active.
- Works well with headless.

### Grok

Grok currently prefers discovering MCP servers from:

- `.mcp.json` in the current working directory, or
- Global/user config

For MVP we have two practical options:

**Option A (simplest)**: Temporarily write a `.mcp.json` in the `cwd` we pass to the spawn, then delete or ignore it after.

**Option B**: Ask user to configure the context engine once globally for Grok (less ideal for coordinator).

Start with Option A for development.

Example temp `.mcp.json` we can write:

```json
{
  "mcpServers": {
    "context_engine": { ... }
  }
}
```

### Codex

Codex supports configuration via:

- `config.toml`, or
- Repeatable `-c key=value` on the command line.

For MCP in exec mode, the recommended way is to pre-register or use overrides.

For MVP we can:

- Use `-c 'mcp_servers.context_engine.command=node' -c 'mcp_servers.context_engine.args=["/path/..."]' ...`

Or generate a small temporary config file and point Codex at it if it supports a config path override.

**Action for MVP**: Test which method works cleanly with `codex exec --json`.

### Antigravity

Uses `mcp_config.json` (similar to Gemini CLI).

For MVP we can write a workspace-level `mcp_config.json` or rely on global one.

Mark as lower priority for **context_engine**. **`muster_bridge` / `ask_user` on agy is deferred** until streaming tool events improve (MCP blocking works — see `MUSTER-BRIDGE.md` §7).

## Implementation Strategy for MVP

1. Extension merges `context_engine` + `muster_bridge` into one config per turn.
2. In the backend adapter:
   - Claude → pass `--mcp-config` + `--strict-mcp-config`
   - Grok → write temp `.mcp.json` in cwd if needed
   - Codex → use `-c` overrides or temp config
3. Make the path to the context engine configurable later (VS Code setting).
4. For now, hardcode a dev path or read from an environment variable / setting.

## Security / Trust Note (MVP)

When using `--strict-mcp-config` or equivalent, we reduce the risk of pulling in other MCP servers the user has configured.

For the context engine itself, make sure it only exposes safe read-only or well-scoped tools during MVP.

## Next Step for Code

When implementing a backend, the MCP part should be:

```ts
if (options.mcpConfigPath) {
  // add the right flags or write temp file
}
```

Keep the logic inside each backend file (per-CLI) rather than forcing a common abstraction too early.
