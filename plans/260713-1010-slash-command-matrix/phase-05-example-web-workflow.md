---
phase: 5
title: "Example web workflow scenario"
status: pending
priority: P1
dependencies: [phase-01-command-behavior-matrix, phase-02-core-and-engine-matrix-tests, phase-03-webview-discovery-and-presenters, phase-04-cli-and-dev-host-proof]
---

# Phase 5: Example web workflow scenario

## Overview

Prove workflow commands as one usable product journey, rather than isolated
routes. A disposable example web workspace receives a realistic request; the
test records artifacts, graph, source edits, checks and browser behavior.

## User Scenario

1. Create a temporary copy of a tiny example web app.
2. Run `/new Build a colour-palette page with selectable swatches, contrast
   label and reset action` after choosing backend/model.
3. Assert `thinking`, then plan approval state, decision brief, plan artifact
   and proposed implementation/verification tasks.
4. Exercise `/help`, `/tasks`, `/status`, `/focus`, `/context`, and legal
   backend/model actions; invalid contexts must be disabled or explained.
5. Run `/approve`, assert children/turns, then `/test`, `/review`, `/verify`
   and `/finish`; use `/debug` after an injected fixture assertion failure.
6. Assert source edits and launch the fixture to verify selection, contrast and
   reset behavior in a browser. Finally exercise `/export` and `/archive`.

## Context Links

- `src/workflow/*`, `src/task/{engine,store,types}.ts`
- `src/commands/*`, `src/extension.ts`
- `e2e/` and Playwright configuration

## Requirements

- Functional: tests copy repository-owned fixture files into a temporary root;
  no user workspace is modified.
- Functional: a scripted ACP/Bridge actor creates structured artifacts and
  controlled fixture edits through real task/workflow APIs.
- Functional: each workflow command has success or invalid-phase proof; each
  built-in command has scenario proof or an explicit unavailable proof.
- Non-functional: evidence records command, task/turn/artifact id, changed file,
  check result and browser result.

## Architecture

Add a tiny fixture app plus deterministic actor/test driver. The actor emits ACP
events and uses bridge submissions as an agent would; it does not fake engine
phase/store transitions. A browser test serves the edited fixture and verifies
the visible feature. A real Grok/Claude Dev Host replay is optional supplemental
proof, never the sole automated signal.

## Related Code Files

- Create: fixture app, workflow journey driver/tests, fixture browser test and
  evidence checklist.
- Modify: test scripts or test seams only when necessary.
- Delete: temporary fixture copies after each run.

## Implementation Steps

1. Add fixture app baseline with deterministic behavior checks.
2. Add temporary-root helper and scripted ACP/Bridge actor.
3. Drive commands through real CommandService/TaskEngine APIs.
4. Assert phase, graph, turn, artifact and evidence snapshots at every step.
5. Serve fixture and verify browser behavior.
6. Document optional manual Insiders replay with a live backend.

## Todo List

- [ ] Add example app and baseline browser check.
- [ ] Add scripted workflow actor.
- [ ] Add full workflow/built-in command journey.
- [ ] Add `/debug` failure branch, export/archive and evidence assertions.
- [ ] Add live replay checklist.

## Success Criteria

- [ ] One command journey produces a working example web page.
- [ ] Every workflow transition has artifact/graph proof.
- [ ] Browser proof validates behavior, not just typecheck.
- [ ] Runs are isolated, repeatable and credential-free.

## Risk Assessment

Live model output is non-deterministic; the scripted actor is mandatory for
repeatable automated proof. Keep the fixture small enough to test Muster rather
than framework/network behavior.

## Security Considerations

Sandbox file operations to the temporary root. Do not execute model-produced
shell content. Do not record credentials or raw user transcripts.

## Verification

Run the journey test, fixture app checks and browser test, then repository
tests, compile, Svelte check, webview tests, audit scripts, package and isolated
Insiders smoke/replay checks.
