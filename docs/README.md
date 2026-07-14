# Muster documentation

Read in this order when onboarding:

1. **[DESIGN.md](DESIGN.md)** — goals, architecture, component map
2. **[ADAPTER-SPEC.md](ADAPTER-SPEC.md)** — `NormalizedEvent`, `Backend` interface
3. **[CLI-COMMANDS.md](CLI-COMMANDS.md)** — exact CLI flags (verified empirically)

## Topic guides

| Doc | Topic |
|-----|--------|
| [SESSION-MANAGEMENT.md](SESSION-MANAGEMENT.md) | Explicit session IDs, resume flow |
| [TASK-MANAGEMENT.md](TASK-MANAGEMENT.md) | Task/turn domain model, coordinator protocol, TaskEngine lifecycle, and task Markdown export contract |
| [plans/task-orchestration-auto-run.md](plans/task-orchestration-auto-run.md) | **APPROVED** plan: brief/result/release auto-run, dataflow, attention, readiness (Phase F) |
| [plans/coordinator-host-context-and-seal.md](plans/coordinator-host-context-and-seal.md) | **DRAFT** plan: host context inject, parent `set_task_lifecycle` MCP, wait-queue UX |
| [MCP-INJECTION.md](MCP-INJECTION.md) | `context_engine` + `coordinator` MCP per turn |
| [MUSTER-BRIDGE.md](MUSTER-BRIDGE.md) | MCP `ask_user`, AskBridge, tool catalog |
| [WEBVIEW.md](WEBVIEW.md) | Chat UI, workspace file-drop mention contract, read-only presentation review, queued follow-ups and interrupt & send, task Markdown export, lifecycle, and diagnostics |
| [SETTINGS.md](SETTINGS.md) | Host-backed Settings pattern for feature configuration |

Operational evidence:

- [File-drop live-host evidence](uat/m007-s02/file-drop-live-host-evidence.md) — scenario-local Extension Development Host verdicts and proof boundary.
- [Task-export live-host evidence](uat/m009-s03/task-export-live-host-evidence.md) — native Save As / cancel / overwrite / Unicode filename / write-failure ledger (PASS, FAIL, or ENVIRONMENT BLOCKED).

All docs are living — update when CLI versions or spikes change behavior.
