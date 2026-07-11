---
phase: 3
title: "Command core and phase-gated bridge"
status: pending
priority: P1
dependencies: [phase-01-workflow-knowledge-and-contracts, phase-02-persisted-workflow-state-and-artifact-store]
---

# Phase 3: Command core and phase-gated bridge

## Overview

Introduce a VS Code-free command registry/parser and enforce workflow phase at
the bridge credential and tool-dispatch boundary.

## Context Links

- `src/extension.ts` webview action switch.
- `src/task/{capabilities,coordinator-tools,engine-graph}.ts`.
- `src/bridge/{server,credentials}.ts`.

## Requirements

- Functional: typed command input/result contracts for the agreed command set.
- Functional: aliases, focus/task resolution, command help and structured errors.
- Functional: planning turns cannot start work, seal outcome or use forbidden
  Muster Bridge actions before approval.
- Functional: planners submit `DecisionBrief` and `PlanArtifact` through a
  typed bridge command; the host must not infer executable graphs by parsing
  assistant markdown.
- Non-functional: command core imports no `vscode`; host remains authoritative.

## Architecture

Create `src/commands/` registry, parser, service and interaction port. VS Code
and future CLI are adapters. Credential issue/MCP tool listing resolve actions
from workflow phase plus task role/capability. Add narrow artifact-submit tools
with schema/semantic validation, rather than a generic workflow mutation tool.

## Related Code Files

- Create: `src/commands/{types,registry,parser,service}.ts` and tests;
  `src/workflow/capabilities.ts` and tests.
- Modify: `src/task/{capabilities,engine-graph,coordinator-tools}.ts`,
  `src/bridge/{server,credentials}.ts`, `src/extension.ts`.
- Delete: None.

## Implementation Steps

1. Define syntax, argument schema, task requirement, phase precondition, effect
   class and presenter hint for every command.
2. Parse slash input deterministically; plain text stays a normal prompt.
3. Route task/session commands to `TaskEngine` through command service rather
   than adding 22 host switch branches.
4. Compute phase-aware bridge actions; omit unavailable MCP tools and return
   structured denials on dispatch.
5. Add typed `submit_decision_brief` and `submit_plan_artifact` tool schemas,
   idempotency keys and structured semantic-validation failures.
6. Add readonly-planner capability policy: bridge restriction is deterministic;
   unsupported ACP provider-tool readonly behavior is visibly bounded.

## Todo List

- [ ] Implement registry/parser/service.
- [ ] Register agreed command specs.
- [ ] Add phase-aware credential/tool gate.
- [ ] Add typed artifact submission bridge actions.
- [ ] Test denial/idempotency/adapter-neutral results.

## Success Criteria

- [ ] `/help`, `/new`, task commands and unknown command errors are typed/stable.
- [ ] Planner credential cannot invoke `start_task`, `complete_task` or `fail_task`.
- [ ] Invalid planner artifact receives structured error and cannot materialize work.
- [ ] Core tests run without VS Code imports.

## Risk Assessment

An incomplete gate can execute before approval. Enforce both tool exposure and
dispatch authorization.

## Security Considerations

Validate command IDs/arguments at host boundary; deny unknown phase/command and
malformed artifact references by default.

## Verification

Run command/capability/coordinator-tool/bridge/engine-graph tests including
negative authorization cases.
