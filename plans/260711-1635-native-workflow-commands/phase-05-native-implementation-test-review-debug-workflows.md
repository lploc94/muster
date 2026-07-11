---
phase: 5
title: "Native implementation test review debug workflows"
status: pending
priority: P1
dependencies: [phase-01-workflow-knowledge-and-contracts, phase-04-auto-planning-and-approval-orchestration]
---

# Phase 5: Native implementation test review debug workflows

## Overview

Implement native implementation, test, review, debug, verify and finish flows.
They use Muster tools and repository scripts, never CK or provider debate runners.

## Context Links

- `src/runner.ts`, `src/types.ts`, backend ACP adapters.
- `src/task/{engine,scheduler,derived-status}.ts`, `package.json` scripts.

## Requirements

- Functional: `/implement`, `/test`, `/review`, `/debug`, `/verify`, `/finish`
  enforce preconditions and emit typed artifacts.
- Functional: test/review provide independent evidence; debug records symptom,
  attempts, root cause/confidence and next step.
- Functional: failure proposes debug/replan and preserves partial scope.
- Non-functional: use declared repository checks; do not run arbitrary configs.

## Architecture

Native role templates share artifact validation. Child handoffs include explicit
goal, constraints, evidence references, output contract and allowed actions.

## Related Code Files

- Create: `src/workflow/{implement,test,review,debug,verify,finish}.ts`,
  `src/workflow/verification-discovery.ts` and tests.
- Modify: `src/workflow/prompts.ts`, `src/task/{engine,engine-graph,derived-status}.ts`, `src/types.ts`.
- Delete: None.

## Implementation Steps

1. Define command preconditions, actions, input and result artifacts.
2. Generate explicit child handoffs and validate evidence references.
3. Safely discover declared repo scripts and require known default/selection.
4. Implement review scopes, debug routing and finish outcome proposal staging.
5. Synthesize partial results, retryability, confidence and residual risks.

## Todo List

- [ ] Implement native workflow routes.
- [ ] Add handoff/evidence validation.
- [ ] Add safe verification discovery.
- [ ] Add failure-to-debug/replan routing.

## Success Criteria

- [ ] Implementation, test and review persist distinct artifacts.
- [ ] Verified success requires recorded evidence.
- [ ] Debug/replan preserve partial work and retryability.

## Risk Assessment

Provider drift affects prompts; use normalized templates and fixtures for core
behavior.

## Security Considerations

Only approved implementation tasks request write effects. Test/review classify
command/network/write effects through current policy.

## Verification

Run workflow fixtures and existing task/adapter tests; run MVP scripts only when
credentials are available.
