# MCP Injection

> **SUPERSEDED (M017-S07, 2026-07-18):** Earlier revisions of this document described
> ACP `muster_bridge` injection as **http/sse** transport entries on
> `session/new` / `session/load`. That approach is **removed**. As of M017-S07,
> `buildTurnMcp` always emits the **Muster-owned stdio proxy** for `muster_bridge`
> on all five ACP backends (Grok, Kiro, OpenCode, Claude, Codex). There is no
> `MUSTER_ACP_MCP_TRANSPORT` env switch and no built-in direct-HTTP ACP injection
> path. The extension still hosts an HTTP bridge on `127.0.0.1`; the stdio proxy
> is the only ACP-facing transport and connects upstream over that loopback URL
> with the per-turn bearer token carried in env (never argv).

## Goal

Each turn injects **two** MCP servers:

1. **`context_engine`** — user's semantic search / codebase tools.
2. **`muster_bridge`** — extension-owned, workflow-only orchestration tools. The legacy delegate-task and MCP question tools are removed; root human input uses ACP RFD elicitation, and workflow correction uses `workflow_prev`. Grok vendor ask stays on AskBridge. See **`docs/MUSTER-BRIDGE.md`**.

This doc covers **how** those servers are passed per CLI backend.

## General Approach (current)

Muster uses **ACP only** for the five product backends — no headless `-p`/`exec`
adapters in the ACP path. MCP injection for ACP is:

- Pass `mcpServers` on ACP `session/new` and `session/load`.
- **`muster_bridge` is always `type: "stdio"`** — the Muster-owned stdio MCP
  proxy (`src/bridge/mcp-stdio-proxy.ts`). Env carries `MUSTER_BRIDGE_URL` and
  `MUSTER_BRIDGE_TOKEN`; argv never carries the token.
- `context_engine` may still be http/sse when the user supplies a URL-shaped
  entry; stdio context engines are not re-wrapped by Muster.

Headless / non-ACP backends (if any future adapter reuses `buildTurnMcp` outside
the ACP five) still receive a private temp `--mcp-config` HTTP file for the
bridge; that path is **not** the ACP injection contract.

## Recommended ACP config (example)

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
    "type": "stdio",
    "name": "muster_bridge",
    "command": "node",
    "args": ["<absolute-path-to-mcp-stdio-proxy>"],
    "env": [
      { "name": "MUSTER_BRIDGE_URL", "value": "http://127.0.0.1:<bridge-port>/mcp" },
      { "name": "MUSTER_BRIDGE_TOKEN", "value": "<per-turn-bearer>" }
    ]
  }
]
```

Do **not** inject a direct-HTTP `muster_bridge` entry for ACP agents. The proxy
owns reconnect / readiness against the extension HTTP bridge.

## Per Backend (ACP)

All five ACP backends share the same injection shape — only the **ACP agent
spawn command** differs (see `CLI-COMMANDS.md`):

| Backend | ACP agent | `muster_bridge` transport |
|---------|-----------|---------------------------|
| Grok | `grok --no-auto-update agent stdio` | stdio proxy (M017-S07) |
| Kiro | `kiro-cli acp` | stdio proxy (M017-S07) |
| OpenCode | `opencode acp` | stdio proxy (M017-S07) |
| Claude | bundled `claude-agent-acp` | stdio proxy (M017-S07) |
| Codex | bundled `codex-acp` | stdio proxy (M017-S07) |
| Antigravity | TBD | 🔜 blocked until ACP entry exists |

Do **not** write temp `.mcp.json`, `--mcp-config`, or `mcp_config.json` files for
ACP Muster turns — ACP `mcpServers` replaces those. (Headless non-ACP remains
the only consumer of the private `--mcp-config` file.)

## Implementation Strategy

1. Extension merges `context_engine` + stdio `muster_bridge` into `mcpServers[]`
   per turn via `buildTurnMcp` (`src/bridge/mcp-config.ts`).
2. Every ACP backend adapter passes `options.mcpServers` on `session/new` /
   `session/load`.
3. Make context engine URL/port configurable later (VS Code setting).
4. Issue per-turn bearer token for `muster_bridge` (see `MUSTER-BRIDGE.md` §10);
   token is env-only on the stdio proxy.

## Security / Trust Note

Per-session injection means only the servers we pass are active for that turn —
no reliance on the user's global MCP config.

For the context engine itself, make sure it only exposes safe read-only or
well-scoped tools during MVP.

Secret hygiene (invariant 10): bearer token must not appear in argv, diagnostics
snapshots, or raw log lines. Debt-ledger / provider-contract suites scan for
leaks.

## Live Packaging / Multi-Session Gates (D036)

Live VSIX/Remote packaging smoke and OpenCode 8–12 concurrent-session rollout
metrics are **BLOCKED** on this host per **D036** (no controllable VS Code /
OpenCode multi-session environment). They are recorded under
`docs/uat/m017-s07-blocked-gates.md` and must **never** be mock-substituted as
live proof. Local contract proof remains vitest + FakeMcpBridge + source-boundary.

## Next Step for Code

When implementing or migrating a backend:

```ts
const mcpServers = options.mcpServers ?? [];
await client.newSession(cwd, mcpServers);
// or loadSession(resumeId, cwd, mcpServers)
```

Keep spawn-command differences in each backend file; keep MCP merge logic in the
extension host (`buildTurnMcp`).
