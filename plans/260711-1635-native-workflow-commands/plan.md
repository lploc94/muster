---
title: "Native workflow commands and agentic task orchestration"
description: "Add host-enforced native workflow commands that turn every new task into a reviewed think → plan → approval → execution lifecycle."
status: completed
priority: P1
branch: "main"
tags: [agentic-workflow, commands, task-engine, vscode, cli-portability]
blockedBy: []
blocks: []
created: "2026-07-11T09:35:16.215Z"
createdBy: "ck:plan"
source: skill
---

# Native workflow commands and agentic task orchestration

## Overview

Build Muster's own command and workflow layer; do not import CK command files,
provider slash commands, or the Codex-review runner. Every ordinary prompt
creates a draft/root coordinator that first produces a structured decision brief
and plan. The host validates the plan, persists an approval gate, and only then
starts materialized child tasks. The fixed phase skeleton is adaptive through
`/replan`, while task lifecycle remains the existing outcome model.

The command core must remain VS Code-free so the webview, VS Code Command
Palette, and a future CLI invoke identical typed handlers. VS Code is the first
adapter; CLI support is a parity-tested boundary, not a second workflow engine.

## Decisions already made

- Native workflow commands: `/think`, `/plan`, `/approve`, `/replan`,
  `/implement`, `/test`, `/review`, `/debug`, `/verify`, `/finish`.
- Native task/session commands: `/new`, `/tasks`, `/status`, `/focus`,
  `/fork`, `/cancel`, `/retry`, `/backend`, `/model`, `/mcp`, `/help`.
- Phase-2 utility commands: `/context`, `/compact`, `/export`, `/archive`.
- `/new` without a goal creates a draft chat; `/new <goal>` creates a root task
  and enters automatic thinking/planning.
- User approval is mandatory before implementation by default. No slash command
  for permissions; existing host settings remain the permission surface.
- Show structured planning summaries, evidence and decisions, never raw model
  chain-of-thought.

## Acceptance criteria

- Any user-originated task request is routed through native workflow reasoning;
  new or scope-changing work cannot reach implementation without a validated,
  user-approved plan.
- The host, not model prose, validates phase changes, proposed task DAGs,
  approval and bridge capabilities; reload cannot bypass an approval gate.
- VS Code slash UI, palette actions and the future CLI share one command service.
- Test, review, debug and verification produce attributable artifacts/evidence;
  lifecycle sealing remains separately authorized.
- No CK/provider command files or runners become a runtime dependency.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Workflow knowledge and contracts](./phase-01-workflow-knowledge-and-contracts.md) | Done |
| 2 | [Persisted workflow state and artifact store](./phase-02-persisted-workflow-state-and-artifact-store.md) | Done |
| 3 | [Command core and phase-gated bridge](./phase-03-command-core-and-phase-gated-bridge.md) | Done |
| 4 | [Auto planning and approval orchestration](./phase-04-auto-planning-and-approval-orchestration.md) | Done |
| 5 | [Native implementation test review debug workflows](./phase-05-native-implementation-test-review-debug-workflows.md) | Done |
| 6 | [VS Code command experience](./phase-06-vs-code-command-experience.md) | Done |
| 7 | [Context archive export and compaction](./phase-07-context-archive-export-and-compaction.md) | Done |
| 8 | [CLI portability and verification](./phase-08-cli-portability-and-verification.md) | Done |

## Dependencies

Existing `TaskEngine`, `TaskStore`, ACP adapters and Muster Bridge are the
implementation substrate. This plan requires a store schema migration and a
protocol bump from v2. It supersedes the current documentation statement that
plan mode/client-side gates are out of scope.

## Open questions

- Planner write protection is deterministic for Muster Bridge actions. Provider
  built-in file/terminal tools need an ACP-compatible readonly policy; adapters
  without it must surface the limit and cannot claim hard no-write enforcement.
- Phase 8 decides whether this milestone ships a CLI or only the command-core
  contract plus CLI adapter harness.
