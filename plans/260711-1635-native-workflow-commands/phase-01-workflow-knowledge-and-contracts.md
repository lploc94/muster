---
phase: 1
title: "Workflow knowledge and contracts"
status: pending
priority: P1
dependencies: []
---

# Phase 1: Workflow knowledge and contracts

## Overview

Create Muster-owned agentic-workflow knowledge and typed contracts. This is a
product/domain source of truth informed by the referenced curriculum, not a copy
of CK skills, Codex-review prompts, or provider slash-command semantics.

## Context Links

- `docs/TASK-MANAGEMENT.md`, `src/task/types.ts`.
- `src/task/capabilities.ts`, `src/task/coordinator-tools.ts`.
- Curriculum: `day-01-agentic-architecture/04-workflow-enforcement-handoff.md`,
  `day-02-tool-design-mcp/01-tool-schema-design.md`, and
  `day-04-prompt-structured-output/02-structured-output.md`.

## Key Insights

- Prompts guide; phase transitions and risky actions need host enforcement.
- Schema-valid output still needs semantic validation against task graph,
  references and phase preconditions.
- Handoffs use explicit bounded evidence, not a parent's entire transcript.

## Requirements

- Functional: document command taxonomy, phase transition table, role/capability
  matrix, artifact schemas, failure routing, provenance and compaction rules.
- Functional: define `DecisionBrief`, `PlanArtifact`, `TaskHandoff`,
  `TestReport`, `ReviewReport`, `VerificationReport`, `DebugReport` and
  `OutcomeProposal` with unknown/missing/evidence fields.
- Non-functional: do not store/render raw reasoning or promise enforcement a
  backend cannot provide.

## Architecture

Add a project-local knowledge document plus `src/workflow/contracts.ts` as the
runtime source. Native prompts consume those names; command/engine code
validates deterministic parts.

## Related Code Files

- Create: `docs/AGENTIC-WORKFLOW-KNOWLEDGE.md`, `src/workflow/contracts.ts`,
  `src/workflow/contracts.test.ts`.
- Modify: `docs/DESIGN.md`, `docs/TASK-MANAGEMENT.md`, `docs/README.md`.
- Delete: None.

## Implementation Steps

1. Document native workflow invariants and the distinction between model
   guidance and host enforcement.
2. Define versioned TypeScript contracts/validators for commands, artifacts,
   provenance, confidence, structured errors and handoffs.
3. Specify plan semantic checks: stable IDs, acyclic graph, known backend,
   acceptance criteria, verification strategy and rollback/open-question state.
4. Publish phase-scoped tool rules and errors: `PHASE_NOT_APPROVED`,
   `CAPABILITY_DENIED`, `PLAN_INVALID`, `EVIDENCE_MISSING`.
5. Reconcile authoritative design docs without changing task lifecycle meaning.

## Todo List

- [ ] Define contracts and validators.
- [ ] Write native workflow knowledge source.
- [ ] Add contract tests.
- [ ] Update architecture documents.

## Success Criteria

- [ ] Contributors can implement phases without reading CK files.
- [ ] Every artifact has producer, consumer and validator.
- [ ] Docs distinguish proposal, approval, execution evidence and sealed outcome.

## Risk Assessment

Vague contracts recreate prompt-only enforcement; provider-shaped contracts harm
portability. Keep the model normalized and versioned.

## Security Considerations

Artifacts contain bounded/redacted evidence only, never credentials, raw tool
payloads or hidden reasoning.

## Verification

Run contract tests and documentation checks; review the capability matrix before
phases 2–4.
