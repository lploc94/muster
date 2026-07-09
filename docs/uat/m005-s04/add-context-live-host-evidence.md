# M005 S04 Add Context Live Host Evidence

## UAT Environment

This ledger is the tracked evidence contract for M005 S04 Add Context live VS Code Extension Development Host UAT. It records only bounded, reviewable evidence from the repository checkout, non-secret command results, and explicit limitations from later Extension Development Host launch attempts.

Tracked source and command references for this contract:

- `docs/uat/m005-s04/add-context-live-host-evidence.md`
- `scripts/verify-add-context-live-host-evidence.test.mjs`
- `webview/src/lib/context-actions.test.ts`
- `webview/src/lib/context-actions.ts`
- `webview/src/components/Composer.svelte`
- `src/host/workspace-files.test.ts`
- `src/host/workspace-files.ts`
- `src/extension.ts`
- `node --test scripts/verify-add-context-live-host-evidence.test.mjs`
- `npm test -- webview/src/lib/context-actions.test.ts src/host/workspace-files.test.ts`
- `npm run test:webview`
- `npm run compile`

Live UAT evidence must be collected from a VS Code Extension Development Host session. Mocked browser or Playwright coverage can support regression confidence, but it is not a substitute for observed Extension Development Host behavior. Live host scenario verdicts must be recorded as `PASS`, `FAIL`, or `BLOCKED`. Use `BLOCKED` instead of inference whenever the Extension Development Host cannot be launched or interacted with. Do not treat mocked browser or Playwright coverage as live Extension Development Host proof.

## Extension Development Host Preconditions

T01 establishes the evidence structure only. T02 records that the checkout compiled and the VS Code CLI was available, but the execution lane did not provide an interactable Extension Development Host UI driver. Because the host webview could not be exercised end to end by this autonomous run, all six live-host scenarios are recorded as `BLOCKED` rather than inferred from mocked Playwright coverage.

T02 host precondition results:

- `npm run compile` passed before host probing, producing the TypeScript and webview production build.
- `code --version` was reachable and reported VS Code `1.127.0` on `x64`.
- `.vscode/launch.json` defines a `Run Extension` `extensionHost` launch configuration using `--extensionDevelopmentPath=${workspaceFolder}`.
- Repository automation surfaces found Add Context regression coverage in `e2e/muster-webview-state.spec.ts`, host boundary code in `src/extension.ts`, and this ledger verifier, but no tracked script that can launch and interact with the live Extension Development Host webview.
- The Add Context action model remains covered by `webview/src/lib/context-actions.test.ts` and `webview/src/lib/context-actions.ts`.
- The Add Context menu UI remains inspectable through `webview/src/components/Composer.svelte`.
- The workspace file picker host helper remains covered by `src/host/workspace-files.test.ts` and `src/host/workspace-files.ts`.
- The extension host message boundary remains inspectable through `src/extension.ts`.
- Use relative tracked source and command references only.
- Do not depend on local GSD state, provider credentials, raw task stores, screenshots with secrets, or local machine paths as proof inside this ledger.

## Scenario Matrix

| Scenario ID | Required observation | Evidence ID slot | T01 verdict | T01 observation |
|---|---|---|---|---|
| `ADD-CONTEXT-MENU-OPEN` | The Composer Add Context control opens the menu in the Extension Development Host webview. | `EDH-ADD-CONTEXT-EVIDENCE-PENDING-MENU-OPEN` | `PENDING` | T01 defines the slot only. T02 must record `PASS`, `FAIL`, or `BLOCKED` from a live host attempt. |
| `ADD-CONTEXT-ADD-FILE` | Choosing Add file posts the intended host-message contract or opens the intended host-side file picking flow. | `EDH-ADD-CONTEXT-EVIDENCE-PENDING-ADD-FILE` | `PENDING` | T01 defines the slot only. T02 must record live host observation or explicit host blockage. |
| `ADD-CONTEXT-BROWSE-WORKSPACE-FILES` | Choosing Browse workspace files exercises the workspace-file browse helper boundary. | `EDH-ADD-CONTEXT-EVIDENCE-PENDING-BROWSE-WORKSPACE-FILES` | `PENDING` | T01 defines the slot only. T02 must record live host observation or explicit host blockage. |
| `ADD-CONTEXT-SHARED-FILE-PICKED-INSERTION` | A `filePicked` result inserts the shared file mention into the composer draft. | `EDH-ADD-CONTEXT-EVIDENCE-PENDING-FILE-PICKED-INSERTION` | `PENDING` | T01 defines the slot only. T02 must record live host observation or explicit host blockage. |
| `ADD-CONTEXT-DISABLED-FUTURE-ACTIONS` | Future Add Context entries are visible as disabled and do not post enabled actions. | `EDH-ADD-CONTEXT-EVIDENCE-PENDING-DISABLED-FUTURE-ACTIONS` | `PENDING` | T01 defines the slot only. T02 must record live host observation or explicit host blockage. |
| `ADD-CONTEXT-DISMISSAL-AND-DRAFT-PRESERVATION` | Dismissing the menu preserves the composer draft and leaves the menu closed. | `EDH-ADD-CONTEXT-EVIDENCE-PENDING-DISMISSAL-DRAFT-PRESERVATION` | `PENDING` | T01 defines the slot only. T02 must record live host observation or explicit host blockage. |

## Evidence Records

| Evidence ID | Scenario ID | Source | Observation | Boundary |
|---|---|---|---|---|
| `EDH-ADD-CONTEXT-EVIDENCE-PENDING-MENU-OPEN` | `ADD-CONTEXT-MENU-OPEN` | T01 structural contract | `PENDING`: no live Extension Development Host attempt has been recorded in this ledger yet. | T02 must replace or extend this row with `PASS`, `FAIL`, or `BLOCKED` live-host evidence. |
| `EDH-ADD-CONTEXT-EVIDENCE-PENDING-ADD-FILE` | `ADD-CONTEXT-ADD-FILE` | T01 structural contract | `PENDING`: no live Add file observation has been recorded in this ledger yet. | T02 must record the observed host-message or host limitation without using mocked browser coverage as live proof. |
| `EDH-ADD-CONTEXT-EVIDENCE-PENDING-BROWSE-WORKSPACE-FILES` | `ADD-CONTEXT-BROWSE-WORKSPACE-FILES` | T01 structural contract | `PENDING`: no live workspace browse observation has been recorded in this ledger yet. | T02 must record the observed workspace picker behavior or explicit host limitation. |
| `EDH-ADD-CONTEXT-EVIDENCE-PENDING-FILE-PICKED-INSERTION` | `ADD-CONTEXT-SHARED-FILE-PICKED-INSERTION` | T01 structural contract | `PENDING`: no live `filePicked` insertion observation has been recorded in this ledger yet. | T02 must record whether a shared mention insertion was observed, failed, or blocked. |
| `EDH-ADD-CONTEXT-EVIDENCE-PENDING-DISABLED-FUTURE-ACTIONS` | `ADD-CONTEXT-DISABLED-FUTURE-ACTIONS` | T01 structural contract | `PENDING`: no live disabled-entry observation has been recorded in this ledger yet. | T02 must record whether disabled future entries were observed as disabled and inert, or why they could not be checked. |
| `EDH-ADD-CONTEXT-EVIDENCE-PENDING-DISMISSAL-DRAFT-PRESERVATION` | `ADD-CONTEXT-DISMISSAL-AND-DRAFT-PRESERVATION` | T01 structural contract | `PENDING`: no live dismissal or draft-preservation observation has been recorded in this ledger yet. | T02 must record whether dismissal preserved draft text or why the host prevented observation. |
| `EDH-ADD-CONTEXT-EVIDENCE-BLOCKED-MENU-OPEN` | `ADD-CONTEXT-MENU-OPEN` | T02 autonomous Extension Development Host attempt boundary | `BLOCKED`: compile passed and the VS Code CLI was available, but this execution lane had no interactable Extension Development Host UI driver to open the Muster Chat webview and observe the Add Context menu. | This is not a live behavior failure and must not be upgraded to `PASS` from browser or Playwright mocks. |
| `EDH-ADD-CONTEXT-EVIDENCE-BLOCKED-ADD-FILE` | `ADD-CONTEXT-ADD-FILE` | T02 autonomous Extension Development Host attempt boundary | `BLOCKED`: the live host webview could not be interacted with, so selecting Add file and observing the host-side file picker or `pickFile` boundary was not possible in this run. | `src/extension.ts` and `webview/src/lib/context-actions.ts` remain source references for later live verification. |
| `EDH-ADD-CONTEXT-EVIDENCE-BLOCKED-BROWSE-WORKSPACE-FILES` | `ADD-CONTEXT-BROWSE-WORKSPACE-FILES` | T02 autonomous Extension Development Host attempt boundary | `BLOCKED`: the execution lane could not drive the Extension Development Host quick-pick UI, so the workspace-file browse helper could not be observed live. | `src/host/workspace-files.ts` remains the host-helper source reference for later live verification. |
| `EDH-ADD-CONTEXT-EVIDENCE-BLOCKED-FILE-PICKED-INSERTION` | `ADD-CONTEXT-SHARED-FILE-PICKED-INSERTION` | T02 autonomous Extension Development Host attempt boundary | `BLOCKED`: without a live host webview interaction, no real `filePicked` message could be produced by VS Code and observed inserting a mention into the composer draft. | Browser regression coverage is supportive only and is not live Extension Development Host proof. |
| `EDH-ADD-CONTEXT-EVIDENCE-BLOCKED-DISABLED-FUTURE-ACTIONS` | `ADD-CONTEXT-DISABLED-FUTURE-ACTIONS` | T02 autonomous Extension Development Host attempt boundary | `BLOCKED`: the Add Context menu could not be opened in an interactable Extension Development Host webview, so disabled future entries could not be observed live. | Keep the scenario blocked until a human-observable or tool-driven live host session verifies it. |
| `EDH-ADD-CONTEXT-EVIDENCE-BLOCKED-DISMISSAL-DRAFT-PRESERVATION` | `ADD-CONTEXT-DISMISSAL-AND-DRAFT-PRESERVATION` | T02 autonomous Extension Development Host attempt boundary | `BLOCKED`: the execution lane could not exercise live menu dismissal inside the Extension Development Host webview, so draft preservation could not be observed live. | Browser regression coverage remains supportive only and cannot replace this live-host observation. |

## Session Metadata and Redaction

Record only redacted high-level metadata. Acceptable examples include scenario ID, command name, redacted workspace label, Add Context action ID, relative source reference, and pass, fail, or blocked verdict.

Redaction rules:

- Do not include provider tokens.
- Do not paste raw `.muster-tasks.json` content.
- Do not include `.gsd/` artifact content.
- Do not include local absolute paths, raw environment dumps, full prompt transcripts, raw assistant payloads, or user-specific workspace identifiers.
- Prefer scenario IDs, evidence IDs, action names, lifecycle states, and relative tracked source references.
- If screenshots are used later, describe the redaction performed and keep the tracked ledger text free of secret material.
- Do not treat mocked browser or Playwright coverage as live Extension Development Host proof.

## Limitations

- T01 creates the verifier and ledger structure only; it does not launch a VS Code Extension Development Host.
- T02 records all six live Add Context scenarios as `BLOCKED` because the autonomous execution lane could not interact with the live Extension Development Host webview.
- Browser or Playwright evidence remains supportive regression coverage only and cannot upgrade a live-host scenario to `PASS` by itself.
- Provider-specific behavior is out of scope for this ledger unless it is needed to explain an observed live host limitation.
- Raw task stores, raw session stores, and local machine paths must not be copied into this tracked file.

## Commands

Required verifier and downstream regression command references:

- `node --test scripts/verify-add-context-live-host-evidence.test.mjs`
- `npm test -- webview/src/lib/context-actions.test.ts src/host/workspace-files.test.ts`
- `npm run test:webview`
- `npm run compile`

T01 command and evidence summary:

| Evidence | Command | Exit code | Result | Notes |
|---|---|---:|---|---|
| `4b788066-29cc-4b87-b706-526a74f20b60` | `node --test scripts/verify-add-context-live-host-evidence.test.mjs` | 1 | `RED` | Expected TDD red run failed because the ledger did not exist yet. |
| `d139fd24-7e92-4d87-8404-109250f90f48` | `node --test scripts/verify-add-context-live-host-evidence.test.mjs` | 0 | `GREEN` | Structural verifier passed after the Add Context live-host ledger contract was created. |

T02 command and evidence summary:

| Evidence | Command | Exit code | Result | Notes |
|---|---|---:|---|---|
| `cc51be05-e14e-42d6-9ecd-59bda900d165` | Inline node ledger scenario-count check | 1 | `RED` | Expected red check failed before the ledger had T02 live-host verdict evidence rows. |
| `ad44c0f2-543c-49d5-b83a-5e9bf41e40ce` | `npm run compile` | 0 | `PASS` | Compile and webview production build passed before live-host probing. |
| `dd0b722d-5bae-41e4-92ed-2d642ecc9593` | `code --version` | 0 | `PASS` | VS Code CLI was available and reported version `1.127.0` on `x64`. |
| `f80db835-0f2b-47df-a14c-7df32667c731` | Inline node Extension Development Host automation-surface diagnostic | 0 | `PASS` | Tracked automation references were found, but no tracked script was found that can launch and interact with the live Extension Development Host webview. |
| `b09387b5-45bf-4042-854a-b3494fb9c7df` | Inline node ledger scenario-count check | 0 | `GREEN` | Confirmed the ledger preserves the 12 structural pending mentions and adds 6 T02 `BLOCKED` evidence rows, one for each required scenario. |
| `3f51386f-036e-40ef-a1ae-b3781fd26306` | `node --test scripts/verify-add-context-live-host-evidence.test.mjs` | 0 | `PASS` | Required ledger verifier passed after the T02 blocked-evidence wording update. |
| `4611391d-8691-440d-9469-5dfeeba15573` | `node --test scripts/verify-add-context-live-host-evidence.test.mjs` | 0 | `PASS` | Required ledger verifier passed after all T02 ledger edits. |

## Final Verifier Results

T01 structural verifier result: `node --test scripts/verify-add-context-live-host-evidence.test.mjs` passed locally with exit code 0 after the ledger and verifier were created. The verifier checked 5 `node:test` cases covering the tracked ledger shape, required Add Context scenario slots, command references, redaction rules, live-host verdict boundaries, unsafe marker rejection, and absolute-path rejection.

T02 live-host evidence result: `node --test scripts/verify-add-context-live-host-evidence.test.mjs` passed with evidence `4611391d-8691-440d-9469-5dfeeba15573` after all T02 ledger edits. The T02 rows intentionally record the live-host boundary as blocked because no autonomous driver could interact with the Extension Development Host webview, while preserving the T01 pending slots as verifier-required structural anchors.

## Failure Modes

| Dependency | Failure path | Handling evidence |
|---|---|---|
| `docs/uat/m005-s04/add-context-live-host-evidence.md` | Missing, empty, or unreadable ledger prevents Add Context live-host evidence review. | `scripts/verify-add-context-live-host-evidence.test.mjs` fails with a missing-document or non-empty assertion. |
| Manual evidence edits | Missing heading, scenario ID, evidence slot, command reference, redaction rule, or live-host verdict boundary weakens the UAT contract. | Negative fixture cases in `scripts/verify-add-context-live-host-evidence.test.mjs` reject each missing structure class. |
| VS Code Extension Development Host | Host launch command unavailable, timeout, or visible launch error prevents live Add Context observation. | This T01 ledger requires T02 to use `BLOCKED` instead of inference whenever the host cannot be launched or interacted with. |
| Webview or host helper regression | Add Context action model, Composer menu behavior, workspace file browse helper, or host message handling may diverge before live UAT. | The ledger names the required regression commands and tracked source references so T03 can localize failures across model, webview, host-helper, and compile boundaries. |
| Secret and runtime artifact handling | Evidence text may accidentally include provider token markers, session dumps, raw task-store claims, absolute paths, or mocked-live overclaims. | `scripts/verify-add-context-live-host-evidence.test.mjs` rejects unsafe marker phrases, forbidden runtime artifact claims, mocked-live overclaim phrases, and absolute local paths. |
| Local Node runtime | `node --test` is unavailable or incompatible. | The verifier command fails before the evidence contract can be accepted. |

## Load Profile

This task has no production runtime load dimension. It creates one bounded markdown ledger and one node:test verifier.

At 10x expected evidence size, the first saturated resource would be human reviewability of the ledger and local text scanning in the verifier, not backend throughput. Protection is a fixed set of string and regular-expression checks over one tracked markdown file, explicit scenario IDs, concise command summaries, and a rule that screenshots, raw task stores, raw backend output, and local paths stay out of the tracked artifact.

## Negative Tests

| Negative scenario | Test surface | Expected failure or bounded result |
|---|---|---|
| Empty evidence document | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with the non-empty assertion. |
| Missing required heading | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with the specific missing heading, such as `## Scenario Matrix`. |
| Missing Add Context scenario ID or evidence slot | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with the missing `ADD-CONTEXT-*` scenario ID or `EDH-ADD-CONTEXT-*` slot. |
| Missing redaction language | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with the missing required redaction rule. |
| Missing command reference | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with the missing verifier, model, webview, or compile command reference. |
| Missing live-host verdict boundary | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with a missing boundary rule for `PASS`, `FAIL`, or `BLOCKED` verdicts. |
| Unsafe secret, raw-store, session-dump, or mocked-live marker | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with an unsafe marker assertion. |
| Absolute local path | `scripts/verify-add-context-live-host-evidence.test.mjs` | Fails with the absolute local path assertion. |
| Missing VS Code CLI or unexercisable host | `docs/uat/m005-s04/add-context-live-host-evidence.md` contract | T02 must record `BLOCKED` host-execution verdicts with explicit limitation rather than false live proof. |
