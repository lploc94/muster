---
phase: 2
title: "Persisted workflow state and artifact store"
status: pending
priority: P1
dependencies: [phase-01-workflow-knowledge-and-contracts]
---

# Phase 2: Persisted workflow state and artifact store

## Overview

Persist workflow phase and structured artifacts independently from task
lifecycle. Upgrade the task-store schema without replaying work after reload.

## Context Links

- `src/task/types.ts`, `src/task/store.ts`, `src/task/retention.ts`.
- `src/task/engine.ts`, `src/task/reload.test.ts`.
- `docs/TASK-MANAGEMENT.md` lifecycle/runtime and reload invariants.

## Key Insights

`open`/`succeeded`/`failed` are task outcomes, not workflow phases. Approval
must be durable/idempotent; queued work stays deferred on reload.

## Requirements

- Functional: root-owned `WorkflowRun`, plan revision/approval records,
  artifact/evidence index, persisted usage records and archive metadata.
- Functional: legal phase-transition validation and reload reconciliation.
- Functional: migrate schema v3 stores without loss.
- Non-functional: preserve existing task/turn/session and retention invariants.

## Architecture

Move to schema v4 with `workflowRuns`, `workflowArtifacts`, usage and archive
fields/index. Transition helpers atomically change phase plus artifacts.

## Related Code Files

- Create: `src/workflow/store.ts`, `src/workflow/transitions.ts` and tests.
- Modify: `src/task/{types,store,engine,retention}.ts`, `src/host/snapshot.ts`,
  snapshot/store/reload tests.
- Delete: None.

## Implementation Steps

1. Add serializable workflow/artifact records and v3 migration fixtures.
2. Implement atomic guards for phase changes, plan revisions, approval, archive
   and artifact attachment.
3. Persist normalized usage/evidence references without full provider payloads.
4. Preserve `awaiting_plan_approval` on reload; never auto-start after restart.
5. Retain decision/plan/verification artifacts when transcript text is pruned.

## Todo List

- [ ] Migrate v3 store safely.
- [ ] Implement transition operations.
- [ ] Add reload/retention/archive behavior.
- [ ] Project safe workflow summaries.

## Success Criteria

- [ ] Approval survives reload and starts no task twice.
- [ ] Legacy stores load without data loss.
- [ ] Archive/usage projection does not alter lifecycle.

## Risk Assessment

Schema loss and duplicate scheduling are high risk; migration and approval/start
mutations need idempotency tests and atomic commits.

## Security Considerations

Persist redacted bounded evidence only; never persist bridge bearer tokens or
provider authentication responses.

## Verification

Run targeted store/migration/retention/engine/reload tests then full Vitest.
