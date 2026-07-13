---
title: "Slash command contract matrix"
description: "Validate every advertised slash command through command core, webview, CLI, and VS Code host checks."
status: implemented
priority: P1
branch: "featture/slash-command"
tags: [slash-commands, testing, vscode, cli, workflow]
blockedBy: []
blocks: []
created: "2026-07-13"
createdBy: "codex"
source: "ck-plan"
---

# Slash command contract matrix

## Overview

Create one declarative matrix for all 25 native commands plus aliases. Every row
declares availability, required arguments, task/workflow prerequisites, host
effect and presenter. A command cannot appear as enabled in autocomplete unless
it is implemented and proven; otherwise it is disabled with an explanation or
hidden.

## Decisions already made

- Normal chat is direct; only explicit `/new <goal>` enters planner flow.
- `/` discovers commands and `@` discovers available context actions.
- Safe reads execute on selection; consequential actions require explicit submit.
- A draft is not a focused task; task commands need honest UI gating.
- `/fork` and `/retry` are not implemented and cannot appear as runnable.

## Acceptance criteria

- Every canonical command and alias has a matrix row and automated proof.
- Global/draft, direct task, allowed/denied phases, active turn and terminal
  task contexts are checked.
- UI only enables commands that can run and every result is visible.
- CLI and webview return equivalent structured results.
- Insiders Dev Host proof covers activation and each presenter class.
- An example web journey proves workflow artifacts, task graph, code changes and
  browser-visible behavior together.

## Phases

| Phase | Name | Status |
| --- | --- | --- |
| 1 | [Define command behavior matrix](./phase-01-command-behavior-matrix.md) | Implemented |
| 2 | [Core and engine matrix tests](./phase-02-core-and-engine-matrix-tests.md) | Implemented |
| 3 | [Webview discovery and presenters](./phase-03-webview-discovery-and-presenters.md) | Implemented |
| 4 | [CLI and VS Code host proof](./phase-04-cli-and-dev-host-proof.md) | Implemented, pending live Insiders replay |
| 5 | [Example web workflow scenario](./phase-05-example-web-workflow.md) | Implemented |

## Dependencies

`NATIVE_COMMAND_SPECS`, `CommandService`, `TaskEngine`, workflow routes,
webview protocol, CLI adapter, Vitest, Playwright and VS Code Insiders.

## Implementation Notes

- `/fork` and `/retry` remain explicit unavailable commands with disabled
  discovery and direct-invocation error proof.
- `/think` now creates a decision brief artifact.
- `/plan` now creates a valid plan artifact and moves the workflow to
  `awaiting_plan_approval`.
- `/implement` remains a phase/handoff command; `/test`, `/review`, `/debug`
  and `/verify` schedule evidence turns.
- Registry count is 25 canonical commands: 10 workflow, 11 task/session, and 4
  utility commands, plus `/list` and `/?` aliases.
