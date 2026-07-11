---
phase: 8
title: "CLI portability and verification"
status: pending
priority: P1
dependencies: [phase-03-command-core-and-phase-gated-bridge, phase-05-native-implementation-test-review-debug-workflows, phase-06-vs-code-command-experience, phase-07-context-archive-export-and-compaction]
---

# Phase 8: CLI portability and verification

## Overview

Prove command-core portability and complete documentation/checks without a
second workflow engine for CLI.

## Context Links

- `src/extension.ts` store locator/workspace resolution.
- `package.json`, `vitest.config.ts`, `playwright.config.ts`.
- `docs/VERIFICATION-EVIDENCE.md`.

## Requirements

- Functional: portable store locator and interaction port for confirm, choose,
  ask and save.
- Functional: thin CLI adapter/harness for parser/result parity; noninteractive
  mutations need explicit flags.
- Functional: document VS Code/CLI behavior and capability limits.
- Non-functional: distinguish local proof from unavailable live provider runs.

## Architecture

One command core executes domain logic. VS Code and CLI adapters differ only in
input/presentation/storage policy; CLI supports JSON for automation and TTY only
when interactive.

## Related Code Files

- Create: `src/cli/{adapter,main}.ts` or equivalent harness, tests, command docs.
- Modify: commands core, task store/workspace resolution, package scripts,
  README, design/task/CLI docs and verification scripts as needed.
- Delete: None.

## Implementation Steps

1. Extract store-location and interaction interfaces from VS Code host concerns.
2. Map CLI arguments/TTY/JSON and require `--yes` for approvals, cancellation,
   compacting and other user-visible mutations.
3. Add adapter-parity tests for parser/results/confirmations.
4. Update docs, diagrams and source-boundary evidence.
5. Run project checks and record unavailable live checks as weak proof.

## Todo List

- [ ] Extract portable interfaces.
- [ ] Implement/test CLI adapter or harness.
- [ ] Document commands/limits.
- [ ] Run project checks.

## Success Criteria

- [ ] Same command request has equivalent domain result through both adapters.
- [ ] Workspace/nonworkspace store resolution is explicit.
- [ ] Fresh evidence exists for planned tests/typecheck/compile/E2E checks.

## Risk Assessment

Adapters can diverge; enforce one registry/service and compare structured result,
not rendered text.

## Security Considerations

CLI JSON/export redacts secrets. Noninteractive destructive effects require an
explicit confirmation flag.

## Verification

Run `npm test`, `npm run compile`, `npm run check:svelte`, `npm run test:webview`,
`npm run test:task-audit`, `npm run test:source-boundary`, `npm run test:evidence`
and targeted command/CLI tests. After the final compile, perform the Phase 6
Extension Development Host UAT; record provider/login limitations separately
from the host/webview behavior observed there.
