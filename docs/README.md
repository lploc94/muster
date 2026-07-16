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
| [plans/task-orchestration-auto-run.md](plans/task-orchestration-auto-run.md) | **PARTIAL**: brief/result/release auto-run (cleanup gate pending) |
| [plans/coordinator-host-context-and-seal.md](plans/coordinator-host-context-and-seal.md) | **IMPLEMENTED**: host context inject, rich create/delegate, parent seal, wait-queue UX (W0–W6) |
| [plans/cleanup-legacy-debt.md](plans/cleanup-legacy-debt.md) | **PARTIAL** (2026-07-15): kill live-inject debt, plan status honesty, MCP/docs hygiene |
| [plans/interrupt-and-send-queue-refactor.md](plans/interrupt-and-send-queue-refactor.md) | **PARTIAL**: interrupt & send; concurrent inject removed (cleanup gate pending) |
| [plans/task-chat-turn-hide-cli.md](plans/task-chat-turn-hide-cli.md) | **PARTIAL**: Task/Turn activity; no CLI product chrome (cleanup gate pending) |
| [plans/rfd-elicitation-full.md](plans/rfd-elicitation-full.md) | **PARTIAL**: full ACP RFD elicitation (C4 AC audit pending) |
| [plans/delegate-task-ux-improve.md](plans/delegate-task-ux-improve.md) | **PARTIAL**: compound wait, repair, ask_parent; C5 residuals under cleanup |
| [MCP-INJECTION.md](MCP-INJECTION.md) | `context_engine` + `coordinator` MCP per turn |
| [MUSTER-BRIDGE.md](MUSTER-BRIDGE.md) | Bridge / elicitation (MCP `ask_user` disabled — see cleanup C3) |
| [WEBVIEW.md](WEBVIEW.md) | Chat UI, workspace file-drop mention contract, read-only presentation review, queued follow-ups and interrupt & send, task Markdown export, lifecycle, and diagnostics |
| [SETTINGS.md](SETTINGS.md) | Host-backed five-topic Settings shell (Task Types, Permissions, Retention, plus Coming soon Models and CLIs / Context and MCP) |

Operational evidence:

- [File-drop live-host evidence](uat/m007-s02/file-drop-live-host-evidence.md) — scenario-local Extension Development Host verdicts and proof boundary.
- [Task-export live-host evidence](uat/m009-s03/task-export-live-host-evidence.md) — native Save As / cancel / overwrite / Unicode filename / write-failure ledger (PASS, FAIL, or ENVIRONMENT BLOCKED).
- [Settings live-host evidence](uat/m012-s04/settings-live-host-evidence.md) — five-topic Settings Extension Development Host ledger (PASS, FAIL, or ENVIRONMENT BLOCKED); browser results are supportive only.

All docs are living — update when CLI versions or spikes change behavior.
