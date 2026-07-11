---
phase: 6
title: "VS Code command experience"
status: pending
priority: P1
dependencies: [phase-03-command-core-and-phase-gated-bridge, phase-04-auto-planning-and-approval-orchestration, phase-05-native-implementation-test-review-debug-workflows]
---

# Phase 6: VS Code command experience

## Overview

Expose command core through Svelte composer, workflow cards and a small VS Code
Command Palette surface. `extension.ts` remains an adapter, not command logic.

## Context Links

- `webview/src/components/{Composer,*.svelte}`, `webview/src/App.svelte`.
- `webview/src/lib/{protocol,tasks.svelte}.ts`, `src/host/snapshot.ts`.
- `src/extension.ts`, `package.json` contributions.

## Requirements

- Functional: slash autocomplete/help, typed command requests/results and plain
  prompt fallback.
- Functional: plan/approval/replan card, workflow badge and evidence progress.
- Functional: palette actions for Open Chat, New Chat and Approve Active Plan
  invoke same command core.
- Non-functional: bump protocol v2 consistently and preserve keyboard access.

## Architecture

Protocol carries safe workflow summaries and command result hints. Client-side
parser suggests commands; host/core always re-parses/validates.

## Related Code Files

- Create: `webview/src/lib/commands.ts`, `webview/src/components/{CommandMenu,PlanCard,WorkflowStatus}.svelte` and tests.
- Modify: Composer, App, protocol, extension host, snapshot, package manifest,
  `e2e/muster-webview-state.spec.ts`.
- Delete: None.

## Implementation Steps

1. Extend protocol/validators and bump duplicated protocol version.
2. Add accessible command detection, autocomplete and argument hints.
3. Render plan/approval/replan and phase/evidence cards.
4. Map host interactions to command core and VS Code dialogs.
5. Register only high-value palette commands, not every slash command.

## Todo List

- [ ] Add protocol/workflow projection.
- [ ] Build menu and cards.
- [ ] Wire approval/replan/cancel.
- [ ] Add palette and E2E tests.

## Success Criteria

- [ ] Normal prompt, plan approval/revision and phase changes work without reload.
- [ ] Protocol mismatch is visible rather than silently dropped.
- [ ] Keyboard/button paths share handlers.

## Risk Assessment

Protocol and concurrent snapshot changes can create stale UI; retain revision and
idempotent-action protections.

## Security Considerations

Use existing markdown sanitization and validate every inbound command.

## Verification

Run protocol/component tests, `npm run check:svelte`, compile and Playwright
workflow scenarios. Add a manual Extension Development Host UAT checklist:
compile first, launch F5/`Run Extension`, open the Muster activity view, submit
a normal prompt, inspect the plan card, approve/replan, and confirm task/turn
updates and command palette actions against the real extension host. Playwright
uses a mocked VS Code API and does not replace this UAT.
