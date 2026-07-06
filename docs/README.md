# Muster documentation

Read in this order when onboarding:

1. **[DESIGN.md](DESIGN.md)** — goals, architecture, component map
2. **[ADAPTER-SPEC.md](ADAPTER-SPEC.md)** — `NormalizedEvent`, `Backend` interface
3. **[CLI-COMMANDS.md](CLI-COMMANDS.md)** — exact CLI flags (verified empirically)
4. **[MVP-SCAFFOLD-PLAN.md](MVP-SCAFFOLD-PLAN.md)** — what to build next

## Topic guides

| Doc | Topic |
|-----|--------|
| [SESSION-MANAGEMENT.md](SESSION-MANAGEMENT.md) | Explicit session IDs, resume flow |
| [MCP-INJECTION.md](MCP-INJECTION.md) | `context_engine` + `coordinator` MCP per turn |
| [MUSTER-BRIDGE.md](MUSTER-BRIDGE.md) | MCP `ask_user`, AskBridge, tool catalog |

All docs are living — update when CLI versions or spikes change behavior.