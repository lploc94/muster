---
phase: 7
title: "Context archive export and compaction"
status: pending
priority: P2
dependencies: [phase-02-persisted-workflow-state-and-artifact-store, phase-03-command-core-and-phase-gated-bridge, phase-06-vs-code-command-experience]
---

# Phase 7: Context archive export and compaction

## Overview

Deliver `/context`, `/compact`, `/export` and `/archive` without losing evidence,
approval history or future CLI portability.

## Context Links

- `src/task/retention.ts`, `src/host/{retention-settings,snapshot}.ts`.
- `docs/SETTINGS.md`, `docs/VERIFICATION-EVIDENCE.md`.

## Requirements

- Functional: context reports normalized usage, runtime, decisions, open
  questions and evidence provenance.
- Functional: compact retains plan/decisions/constraints/artifacts/evidence refs.
- Functional: export makes deterministic Markdown/JSON; archive hides task only.
- Non-functional: no claim of provider-session compaction or destructive action
  without confirmation.

## Architecture

Services return command-core view/artifact/confirmation results. Compact uses an
explicit retention snapshot and emits an audit artifact.

## Related Code Files

- Create: `src/workflow/{context,compact,export,archive}.ts` and tests.
- Modify: task retention/store, host snapshot, extension host, webview task UI,
  documentation.
- Delete: None.

## Implementation Steps

1. Define bounded context/provenance report.
2. Design compaction allowlist and audit behavior.
3. Add export formatters and VS Code save-dialog adapter.
4. Add archive filters without touching lifecycle/provider session identity.

## Todo List

- [ ] Implement context/usage report.
- [ ] Implement compact audit operation.
- [ ] Implement export/archive.
- [ ] Add confirmation/regression tests.

## Success Criteria

- [ ] Compact preserves approved plan, decision and verification evidence.
- [ ] Export is reproducible and redacts sensitive metadata.
- [ ] Archived tasks are recoverable through filters.

## Risk Assessment

Compaction may lower context quality; retained facts/decisions must be visible
and mutation auditable.

## Security Considerations

Exports exclude tokens, credentials and raw permission/provider metadata. User
chooses save location.

## Verification

Run retention/context/export/archive tests, protocol tests and VS Code save
dialog smoke test.
