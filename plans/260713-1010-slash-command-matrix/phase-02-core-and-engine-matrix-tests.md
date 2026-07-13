---
phase: 2
title: "Core and engine matrix tests"
status: pending
priority: P1
dependencies: [phase-01-command-behavior-matrix]
---

# Phase 2: Core and engine matrix tests

## Overview

Prove parser, service, domain adapter, route, store mutation and scheduling
behavior for every matrix row.

## Context Links

- `src/commands/{parser,service,domain-adapter}.ts`
- `src/task/{engine,transitions}.ts`
- `src/workflow/{routes,approval,transitions}.ts`

## Requirements

- Functional: table-driven tests include canonical ids and aliases.
- Functional: success and rejected calls assert result plus before/after store.
- Functional: prove artifacts, phase change, queued turn, lifecycle, export and
  archive effects where applicable.

## Architecture

Use deterministic fixtures for no task, draft, direct root, workflow phases,
active turn and terminal task. Use fake/gated backend turns only.

## Related Code Files

- Modify: command, task and workflow test suites.
- Create: shared command-context fixture/harness.
- Delete: none.

## Implementation Steps

1. Build context factories.
2. Generate service/alias cases from matrix rows.
3. Assert declared effects and no-mutation rejections.
4. Implement or hide every remaining stub.
5. Add reload/idempotency tests for sensitive mutations.

## Todo List

- [ ] Add positive cases.
- [ ] Add invalid-context/no-mutation cases.
- [ ] Resolve stub behavior.

## Success Criteria

- [ ] Every row has deterministic core proof.
- [ ] No success result lacks its declared effect.

## Risk Assessment

Lifecycle and workflow phase are separate axes; fixtures must set both.

## Security Considerations

Use temp stores; never bypass confirmations to simplify tests.

## Verification

Run targeted Vitest, `npm test`, and `npm run test:source-boundary`.
