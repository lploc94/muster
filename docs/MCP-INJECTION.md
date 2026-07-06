# MCP Injection (MVP)

## Goal

Each turn injects **two** MCP servers:

1. **`context_engine`** — user's semantic search / codebase tools.
2. **`muster_bridge`** — extension-owned `ask_user` for human-in-the-loop.

`ask_user` design (AskBridge, HTTP MCP, webview flow): **`docs/MUSTER-BRIDGE.md`**

This doc covers **how** those servers are passed per CLI backend.

## General Approach (MVP)

Muster uses **ACP only** — no headless `-p`/`exec` adapters. MCP injection is **uniform**:

- Pass `mcpServers` on ACP `session/new` and `session/load`.
- Use **http** or **sse** transport entries (stdio MCP is rejected by some agents over ACP).
- The Muster Bridge (`muster_bridge`) is naturally http on `127.0.0.1`.
- `context_engine` may need an http/sse proxy if it is stdio-only today.

## Recommended merged config (example)

Built per turn by the extension host and passed as `RunOptions.mcpServers`:

```json
[
  {
    "type": "http",
    "name": "context_engine",
    "url": "http://127.0.0.1:<context-port>/mcp",
    "headers": []
  },
  {
    "type": "http",
    "name": "muster_bridge",
    "url": "http://127.0.0.1:<bridge-port>/mcp",
    "headers": [{ "name": "Authorization", "value": "Bearer <token>" }]
  }
]
```

If a backend's ACP agent accepts stdio MCP entries, prefer http anyway for consistency with the Bridge.

## Per Backend (ACP)

All backends follow the same injection point — only the **ACP agent spawn command** differs (see `CLI-COMMANDS.md`):

| Backend | ACP agent | `mcpServers` on `session/new`/`session/load` |
|---------|-----------|-----------------------------------------------|
| Grok | `grok agent stdio` | ✅ verified (http/sse) |
| Claude | `claude-code-acp` | 🔜 verify on migrate |
| Codex | `codex app-server --stdio` | 🔜 verify |
| Antigravity | TBD | 🔜 blocked |

Do **not** write temp `.mcp.json`, `--mcp-config`, or `mcp_config.json` files for Muster turns — ACP `mcpServers` replaces all of those.

## Implementation Strategy for MVP

1. Extension merges `context_engine` + `muster_bridge` into `mcpServers[]` per turn.
2. Every ACP backend adapter passes `options.mcpServers` on `session/new` / `session/load`.
3. Make context engine URL/port configurable later (VS Code setting).
4. Issue per-turn bearer token for `muster_bridge` (see `MUSTER-BRIDGE.md` §10).

## Security / Trust Note (MVP)

Per-session injection means only the servers we pass are active for that turn — no reliance on the user's global MCP config.

For the context engine itself, make sure it only exposes safe read-only or well-scoped tools during MVP.

## Next Step for Code

When implementing or migrating a backend:

```ts
const mcpServers = options.mcpServers ?? [];
await client.newSession(cwd, mcpServers);
// or loadSession(resumeId, cwd, mcpServers)
```

Keep spawn-command differences in each backend file; keep MCP merge logic in the extension host.