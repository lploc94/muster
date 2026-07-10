# Muster documentation

Read in this order when onboarding:

1. **[DESIGN.md](DESIGN.md)** — goals, architecture, component map
2. **[ADAPTER-SPEC.md](ADAPTER-SPEC.md)** — `NormalizedEvent`, `Backend` interface
3. **[CLI-COMMANDS.md](CLI-COMMANDS.md)** — exact CLI flags (verified empirically)

## Topic guides

| Doc | Topic |
|-----|--------|
| [SESSION-MANAGEMENT.md](SESSION-MANAGEMENT.md) | Explicit session IDs, resume flow |
| [TASK-MANAGEMENT.md](TASK-MANAGEMENT.md) | Task/turn domain model, coordinator protocol, TaskEngine lifecycle |
| [MCP-INJECTION.md](MCP-INJECTION.md) | `context_engine` + `coordinator` MCP per turn |
| [MUSTER-BRIDGE.md](MUSTER-BRIDGE.md) | MCP `ask_user`, AskBridge, tool catalog |
| [WEBVIEW.md](WEBVIEW.md) | Chat UI and read-only presentation review, linked-chat revision, lifecycle, and diagnostics |
| [SETTINGS.md](SETTINGS.md) | Host-backed Settings pattern for feature configuration |

All docs are living — update when CLI versions or spikes change behavior.
