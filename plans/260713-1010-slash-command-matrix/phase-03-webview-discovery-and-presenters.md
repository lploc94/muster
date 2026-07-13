---
phase: 3
title: "Webview discovery and presenters"
status: pending
priority: P1
dependencies: [phase-01-command-behavior-matrix, phase-02-core-and-engine-matrix-tests]
---

# Phase 3: Webview discovery and presenters

## Overview

Make command discovery truthful and prove selecting/submitting a command
produces visible feedback, never a silent host message.

## Context Links

- `webview/src/components/Composer.svelte`
- `webview/src/App.svelte`
- `webview/src/lib/{commands,protocol,tasks.svelte.ts}`
- `e2e/muster-webview-state.spec.ts`

## Requirements

- Functional: `/` filtering and `@` context discovery work in all composer modes.
- Functional: safe global reads execute on selection and render their result.
- Functional: task/phase commands are disabled or show their prerequisite before
  dispatch; argument-taking actions remain editable.
- Functional: help, list, status, context, export, approval/plan, mutation and
  error presenters have browser tests.
- Non-functional: preserve keyboard, IME and screen-reader behavior.

## Architecture

Project matrix availability into the webview from focused task/workflow context.
Map structured `CommandResult` presenters/data to bounded cards/markdown, never
raw internal prompts or tool payloads.

## Related Code Files

- Modify: Composer, App, protocol and Playwright spec.
- Create: presenter component only if App becomes too broad.
- Delete: duplicated discovery lists.

## Implementation Steps

1. Derive availability and disabled reasons from matrix/context.
2. Prevent misleading command clicks in draft and invalid phases.
3. Complete command-specific result rendering.
4. Add Playwright scenarios per presenter and context boundary.

## Todo List

- [ ] Make discovery availability-aware.
- [ ] Complete presenters.
- [ ] Add keyboard/a11y tests.

## Success Criteria

- [ ] No silent successful result.
- [ ] Draft does not expose enabled task-only actions.
- [ ] All presenter classes have browser proof.

## Risk Assessment

Web components can drop events; tests assert both posted messages and visible UI.

## Security Considerations

Renderers redact secrets and internal prompt/tool detail.

## Verification

Run `npm run check:svelte` and `npm run test:webview`.
