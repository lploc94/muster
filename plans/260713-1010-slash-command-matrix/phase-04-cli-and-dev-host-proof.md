---
phase: 4
title: "CLI and VS Code host proof"
status: pending
priority: P1
dependencies: [phase-02-core-and-engine-matrix-tests, phase-03-webview-discovery-and-presenters]
---

# Phase 4: CLI and VS Code host proof

## Overview

Establish CLI parity and real extension-host evidence after core and browser
checks are green.

## Context Links

- `src/cli/{adapter,main}.ts`
- `src/extension.ts`, `src/commands/domain-adapter.ts`
- `package.json`, VSIX packaging and evidence docs

## Requirements

- Functional: CLI JSON result matches command-core result for each safe command
  and expected rejection.
- Functional: `/new` CLI flags preserve backend/model and arguments.
- Functional: isolated VS Code Insiders Dev Host activates and demonstrates one
  command from every presenter/effect class.
- Non-functional: record live-provider limitations separately from host proof.

## Architecture

Generate CLI cases from safe matrix rows against temporary stores. Add a Dev
Host smoke checklist: discovery, `/help`, `/status`, phase rejection, export and
activation log inspection.

## Related Code Files

- Modify: CLI tests/scripts, UAT docs, evidence docs, package scripts.
- Create: optional Dev Host smoke checklist/harness.
- Delete: none.

## Implementation Steps

1. Generate CLI parity cases.
2. Assert JSON and error semantics.
3. Build VSIX and start isolated Insiders Dev Host.
4. Execute smoke checklist and inspect logs.
5. Record evidence by proof type.

## Todo List

- [ ] Add CLI parity cases.
- [ ] Add Dev Host smoke flow.
- [ ] Package/install and record evidence.

## Success Criteria

- [ ] CLI and webview produce equivalent core results.
- [ ] Dev Host activation and visible command results are proven.

## Risk Assessment

Playwright cannot replace VS Code API/provider behavior; Dev Host remains gate.

## Security Considerations

Use isolated profile/temp stores and never record credentials or sensitive chat.

## Verification

Run `npm test`, `npm run compile`, `npm run check:svelte`, `npm run test:webview`,
audit/boundary/evidence scripts, CLI tests, VSIX package and Dev Host logs.
