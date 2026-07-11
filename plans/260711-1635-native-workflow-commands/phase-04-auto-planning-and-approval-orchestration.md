---
phase: 4
title: "Auto planning and approval orchestration"
status: pending
priority: P1
dependencies: [phase-02-persisted-workflow-state-and-artifact-store, phase-03-command-core-and-phase-gated-bridge]
---

# Phase 4: Auto planning and approval orchestration

## Overview

Change the new-prompt boundary so ordinary work first produces an inspectable
decision brief and plan, then waits for explicit approval before execution.

## Context Links

- `src/task/engine.ts` (`startNewTask`, `send`, scheduling).
- `src/task/engine-graph.ts`, `src/extension.ts` (`handleSend`).
- `docs/SESSION-MANAGEMENT.md`, `docs/TASK-MANAGEMENT.md`.

## Requirements

- Functional: plain prompt and `/new <goal>` auto-enter think/plan; `/new`
  without a goal remains a draft chat.
- Functional: every user-originated task message passes workflow routing. A
  clarification/control message may remain in the current phase; a new or
  scope-changing request creates a fresh plan revision before new write work.
- Functional: validate/persist plan DAG before display; `/approve` starts only
  validated work exactly once; `/replan` revises without losing evidence.
- Non-functional: no replay after reload, no session sharing, no lifecycle seal
  from planner completion.

## Architecture

Native instruction templates produce bounded artifacts. Host validates semantics;
children can be proposed/materialized without scheduling, while approval is the
sole start authority.

## Related Code Files

- Create: `src/workflow/{prompts,planner,plan-validation,approval}.ts` and tests.
- Modify: `src/task/{engine,engine-graph,transitions}.ts`, `src/extension.ts`,
  `docs/{SESSION-MANAGEMENT,TASK-MANAGEMENT}.md`.
- Delete: None.

## Implementation Steps

1. Refactor root creation for draft, planner and explicit command initiation.
2. Build native think/plan instructions with exploration/proposal-only bridge
   tools and typed artifact submission.
3. Validate IDs, DAG, backend, policy, acceptance criteria and verification plan.
4. Persist/reproject approval state and implement approve/replan handlers.
5. Atomically materialize/start after approval; invalid/rejected plans ask or replan.
6. Add a backend capability spike/fixture matrix for readonly planning. If an
   adapter cannot enforce provider tool readonly behavior, expose the limitation
   and require user confirmation before any provider write-capable turn.

## Todo List

- [ ] Implement planner entry path.
- [ ] Validate/persist task proposals.
- [ ] Implement approval/replan gate.
- [ ] Verify per-backend readonly planning behavior/limitations.
- [ ] Test reload and duplicate approval.

## Success Criteria

- [ ] Normal prompt cannot start executor before approval.
- [ ] Approved plan starts each child once and respects dependencies.
- [ ] Invalid plan output is visible and recoverable.
- [ ] Scope-changing user message cannot start new write work without revision approval.

## Risk Assessment

This changes default scheduling/UX; protect rollout with feature flag or explicit
rollback until migration and E2E behavior are proven.

## Security Considerations

Approval validates persisted artifact, not model prose. All plan fields/task IDs
from the model are untrusted input.

## Verification

Engine/transitions/reload tests: auto-plan, reject/replan, duplicate approval,
dependency ordering and cancel during planning.
