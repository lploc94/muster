---
phase: 1
title: "Define command behavior matrix"
status: pending
priority: P1
dependencies: []
---

# Phase 1: Define command behavior matrix

## Overview

Convert the registry and documentation into a machine-readable contract for
each canonical command and alias.

## Context Links

- `src/workflow/contracts.ts`
- `src/commands/{registry,service}.ts`
- `src/workflow/routes.ts`
- `webview/src/lib/commands.ts`

## Key Insights

- 26 canonical ids plus `/list` and `/?` aliases require parity checks.
- `/fork` and `/retry` are current stubs; `/think`, `/plan`, `/replan`, and
  `/implement` need explicit behavior decisions before they are shown enabled.

## Requirements

- Functional: declare arguments, allowed context/phase, confirmation, effect,
  presenter, expected success and expected rejection per command.
- Non-functional: registry, help and autocomplete cannot drift from the matrix.

## Architecture

Add a VS Code-free behavior-matrix fixture next to the command registry. It is
verification metadata, not a second dispatch engine.

## Related Code Files

- Create: `src/commands/behavior-matrix.ts`, tests.
- Modify: registry, contracts, webview command list and docs.
- Delete: stale duplicate command metadata.

## Implementation Steps

1. Enumerate ids and aliases from `NATIVE_COMMAND_SPECS`.
2. Define global, draft, direct-task, active-turn, terminal and phase contexts.
3. Mark every row implemented, disabled or hidden.
4. Add registry/help/discovery parity checks.

## Todo List

- [ ] Define all matrix rows.
- [ ] Resolve incomplete-command product decisions.
- [ ] Add parity checks.

## Success Criteria

- [ ] No command or alias is unaccounted for.
- [ ] Incomplete commands cannot be selected as normal enabled actions.

## Risk Assessment

Do not duplicate phase policy; assert matrix expectations against contracts.

## Security Considerations

Mutating command tests retain host confirmation and phase gates.

## Verification

Run targeted matrix tests and `npm test`.
