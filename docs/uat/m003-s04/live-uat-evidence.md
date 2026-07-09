# M003 S04 Live UAT Evidence

## UAT Environment

This ledger is the tracked evidence contract and T02 evidence record for M003 S04 live VS Code Extension Development Host UAT. It records only bounded, reviewable evidence from the repository checkout, non-secret command results, and explicit limitations from the Extension Development Host launch attempt.

Tracked source and command references for this contract:

- `docs/uat/m003-s04/live-uat-evidence.md`
- `scripts/verify-live-uat-evidence.test.mjs`
- `src/extension.ts`
- `webview/src/lib/protocol.ts`
- `e2e/muster-webview-state.spec.ts`
- `node --test scripts/verify-live-uat-evidence.test.mjs`
- `npm test`
- `npm run compile`
- `npx playwright test e2e/muster-webview-state.spec.ts`

Live UAT evidence must normally be collected from a VS Code Extension Development Host session. Mocked browser or Playwright coverage can support regression confidence, but it is not a substitute for observed Extension Development Host behavior. In this T02 run, the non-interactive execution environment did not expose a VS Code CLI on `PATH`, so the Extension Development Host itself could not be launched. The ledger therefore records each live scenario as `BLOCKED` for host execution and documents the source-backed UI/runtime behavior that was inspectable without claiming live-host proof.

## Extension Development Host Preconditions

T02 precondition results:

- `npm run compile` passed before host launch probing, building both TypeScript and the webview bundle.
- The repository contributes the `muster.openChat` command in `package.json` and registers the `muster.chat` webview provider from `src/extension.ts`.
- The webview protocol handling remains aligned through `webview/src/lib/protocol.ts`, `webview/src/App.svelte`, `webview/src/components/TaskList.svelte`, `webview/src/components/TaskWorkspace.svelte`, and `webview/src/components/Composer.svelte`.
- The task-state browser regression remains referenced through `e2e/muster-webview-state.spec.ts` for supportive checks.
- A PATH-only host probe checked `code`, `code-insiders`, and `codium`; none were available to the non-interactive shell, so no Extension Development Host window could be opened from this task run.
- Provider CLI probing was limited to availability summaries only. Some provider wrappers were present and others absent; no provider credentials, auth status, raw prompts, raw responses, or local provider paths were recorded.
- Use relative tracked source and command references only.
- Do not depend on local GSD state, provider credentials, raw task stores, screenshots with secrets, or local machine paths as proof inside this ledger.

## Scenario Matrix

| Scenario ID | Required observation | Evidence ID slot | T02 verdict | T02 observation |
|---|---|---|---|---|
| `LIVE-UAT-TASK-CREATION` | A user action creates or drafts a task in the Extension Development Host webview and the UI presents the task-centric shell. | `EDH-EVIDENCE-PENDING-TASK-CREATION` | `BLOCKED` | Host launch was blocked because no VS Code CLI was available. Source inspection confirms the draft shell posts `send`, `newTask`, `focusTask`, and `hydrateSubtree` messages and the extension routes draft `send` into `TaskEngine.startNewTask`. |
| `LIVE-UAT-RUNNING-SETTLEMENT` | A task shows running feedback and then settles to success or idle, with visible state change boundaries. | `EDH-EVIDENCE-PENDING-RUNNING-SETTLEMENT` | `BLOCKED` | Host launch was blocked. Source inspection confirms `turnStart`, `turnDone`, and `turnError` messages drive active-turn state, task badges, workspace banners, and composer affordances. |
| `LIVE-UAT-RUNTIME-FAILURE-RECOVERY` | A runtime failure or recovery path is visible with actionable failed or recovery state. | `EDH-EVIDENCE-PENDING-RUNTIME-RECOVERY` | `BLOCKED` | Host launch was blocked. Source inspection confirms failed or interrupted turns can project `needs_recovery`, show a recovery panel, require retry instructions, and route `retryTurn` or `continueTask` commands. |
| `LIVE-UAT-COMMAND-ERROR-MISSING-BACKEND` | Command-error or missing-backend feedback appears without crashing the webview. | `EDH-EVIDENCE-PENDING-COMMAND-ERROR` | `BLOCKED` | Host launch was blocked. Source inspection confirms `postCommandError` emits `commandError` for empty messages, not-ready task engine, invalid continuation, malformed cancel/retry/resume targets, and rejected engine commands; the webview renders the message in a role `alert` banner with a dismiss button. |
| `LIVE-UAT-CANCELLATION` | Cancellation is exercised where supported, or an explicit limitation explains why it could not be exercised. | `EDH-EVIDENCE-PENDING-CANCELLATION` | `BLOCKED` | Host launch was blocked before a cancellable turn could be created. Source inspection confirms the composer only exposes `Cancel running task` when a focused task has a running state and active turn id, then posts `cancelTurn`; the extension validates task and turn ownership before calling `TaskEngine.interruptTurn`. |
| `LIVE-UAT-TASK-SCOPED-SESSION-METADATA` | Session metadata is observed at task scope using redacted high-level identifiers only. | `EDH-EVIDENCE-PENDING-SESSION-METADATA` | `BLOCKED` | Host launch was blocked, so no live task/session metadata was opened. Source inspection confirms snapshots expose task-scoped summaries, focused task id, subtree, transcript, active turn id, store revision, and pending ask metadata; this ledger records only those high-level field names and not store payloads. |

## Evidence Records

| Evidence ID | Scenario ID | Source | Observation | Boundary |
|---|---|---|---|---|
| `EDH-EVIDENCE-PENDING-TASK-CREATION` | `LIVE-UAT-TASK-CREATION` | T02 host precondition probe plus tracked source inspection | `BLOCKED`: the Extension Development Host could not be launched because no VS Code CLI was exposed to the non-interactive shell. The task-creation path is inspectable in tracked source through draft composer send, `muster.openChat`, `MusterChatProvider`, and `TaskEngine.startNewTask`. | Does not claim a live task was created. Requires rerun in an interactive VS Code Extension Development Host to upgrade this scenario from `BLOCKED` to `PASS` or `FAIL`. |
| `EDH-EVIDENCE-PENDING-RUNNING-SETTLEMENT` | `LIVE-UAT-RUNNING-SETTLEMENT` | T02 host precondition probe plus tracked source inspection | `BLOCKED`: no live turn could be started. Tracked source shows the intended visible state boundaries: `turnStart` sets active turn state, `turnDone` clears it, and task summaries project running, queued, failed, cancelled, and terminal view statuses into badges and banners. | Does not claim live running or settlement behavior. Requires a host session with a runnable backend or controllable failing backend. |
| `EDH-EVIDENCE-PENDING-RUNTIME-RECOVERY` | `LIVE-UAT-RUNTIME-FAILURE-RECOVERY` | T02 host precondition probe plus tracked source inspection | `BLOCKED`: no live backend failure could be triggered without host launch. Tracked source shows failure and recovery affordances through `turnError`, `needs_recovery`, retry instruction validation, and continue-task command handling. | Does not copy backend output or infer provider-specific behavior. Requires live host evidence for the actual recovery UI. |
| `EDH-EVIDENCE-PENDING-COMMAND-ERROR` | `LIVE-UAT-COMMAND-ERROR-MISSING-BACKEND` | T02 host precondition probe plus tracked source inspection | `BLOCKED`: no live command-error alert could be clicked or observed in the webview. Tracked source shows command errors are bounded to a webview `commandError` message and rendered as `Task command failed` with dismiss behavior rather than crashing the app. | Does not claim observed UI rendering in Extension Development Host. Requires rerun after host CLI availability. |
| `EDH-EVIDENCE-PENDING-CANCELLATION` | `LIVE-UAT-CANCELLATION` | T02 host precondition probe plus tracked source inspection | `BLOCKED`: no running turn existed to cancel. Tracked source shows cancellation is task-scoped and turn-scoped, guarded by active turn state in the composer, then validated by the extension before interrupting the task engine. | Cancellation remains a documented limitation for this run. Requires live host plus a cancellable turn. |
| `EDH-EVIDENCE-PENDING-SESSION-METADATA` | `LIVE-UAT-TASK-SCOPED-SESSION-METADATA` | T02 host precondition probe plus tracked source inspection | `BLOCKED`: no live task session metadata was opened. Tracked source shows the task-scoped metadata shape available to the webview: task summaries, focused task id, subtree, transcript, active turn id, store revision, and pending ask envelope. | Only high-level field names are recorded. No raw local task store or raw session content is included. |

## Session Metadata and Redaction

Record only redacted high-level metadata. Acceptable examples include task count, scenario ID, command name, redacted session label, backend family, and pass or limitation verdict.

T02 recorded metadata summary:

- Scenario verdicts: six `BLOCKED` host-execution verdicts caused by unavailable VS Code CLI launch surface.
- Commands summarized: `npm run compile`, a PATH-only VS Code CLI probe, a PATH-only provider CLI probe, a source-surface summarizer, and `node --test scripts/verify-live-uat-evidence.test.mjs`.
- Source-backed field names summarized: `rootTasks`, `focusedTaskId`, `subtree`, `transcript`, `activeTurnId`, `storeRevision`, and `pendingAsk`.
- Backend families summarized at a high level only. Provider credentials, local wrapper locations, raw prompts, and raw outputs were not recorded.

Redaction rules:

- Do not include provider tokens.
- Do not paste raw `.muster-tasks.json` content.
- Do not include `.gsd/` artifact content.
- Do not include local absolute paths, raw environment dumps, full prompt transcripts, raw assistant payloads, or user-specific workspace identifiers.
- Prefer scenario IDs, evidence IDs, task roles, lifecycle states, and relative tracked source references.
- If a screenshot is used later, describe the redaction performed and keep the tracked ledger text free of secret material.

## Limitations

- This T02 run could not launch a VS Code Extension Development Host because `code`, `code-insiders`, and `codium` were unavailable to the non-interactive shell.
- Because the host could not launch, the six scenario rows remain `BLOCKED` for live-host proof rather than `PASS`.
- Playwright coverage in `e2e/muster-webview-state.spec.ts` is supportive browser regression evidence only and remains separate from live Extension Development Host proof.
- Provider-specific behavior is marked as unavailable or limited in this run rather than inferred from source or mocked tests.
- Cancellation is recorded as a limitation because no host-backed running turn could be created.
- Session metadata stayed task-scoped and redacted; this ledger records proof boundaries and high-level source field names rather than local storage payloads.

## Commands

Required verifier and downstream regression command references:

- `node --test scripts/verify-live-uat-evidence.test.mjs`
- `npm test`
- `npm run compile`
- `npx playwright test e2e/muster-webview-state.spec.ts`

T02 command and evidence summary:

| Evidence | Command | Exit code | Result | Notes |
|---|---|---:|---|---|
| `84cf6c7e-c1e7-44b3-a0b1-f8bd921769c6` | `npm run compile` | 0 | `PASS` | TypeScript and webview bundle built successfully before host probing. |
| `d21d7a08-62f6-48b6-bfd8-aa60e9e4dbe9` | VS Code CLI PATH probe | 0 | `BLOCKED` | Probe script completed and reported no available `code`, `code-insiders`, or `codium` command for host launch. |
| `a6b0c1ae-b5ae-4bb5-a660-f1ed68eb2f2c` | VS Code and provider CLI PATH probe | 0 | `PARTIAL` | Probe script completed with redaction intent; host CLIs were unavailable, while provider availability was mixed and not used for live prompts. |
| `81abcd06-39f3-4956-b33f-04cc3dcf85bf` | Source-surface summarizer | 0 | `PASS` | Summarized tracked source surfaces for task creation, running state, command errors, cancellation, and metadata without reading raw task stores. |

T03 final command and evidence summary:

| Evidence | Command | Exit code | Result | Notes |
|---|---|---:|---|---|
| `8ef4661f-45fc-452d-8251-6932fc59e0c0` | `node --test scripts/verify-live-uat-evidence.test.mjs` | 0 | `PASS` | Structural verifier passed 5 node:test cases for required headings, scenario slots, command references, redaction rules, unsafe marker rejection, and absolute-path rejection. |
| `e620c6e3-c349-4f37-885b-46c3b2260fe3` | `npm test` | 0 | `PASS` | Vitest reported 24 test files passed and 165 tests passed, including task runtime and webview status coverage. |
| `62ef61a3-3016-464b-b11f-6486b954026d` | `npm run compile` | 0 | `PASS` | TypeScript compilation and webview bundle build completed successfully. |
| `5e489b23-09a1-4f33-929b-ecabb2cce37f` | `npx playwright test e2e/muster-webview-state.spec.ts` | 0 | `PASS` | Focused webview state regression passed 4 Chromium tests. The stable evidence record used the local package CLI after direct `npx` output was malformed by the evidence harness; the intended rerun command remains the listed `npx playwright` command. |

## Final Verifier Results

T01 structural verifier result: `node --test scripts/verify-live-uat-evidence.test.mjs` passed locally with exit code 0 after the ledger and verifier were created. The verifier checked 5 `node:test` cases covering the tracked ledger shape and negative fixtures.

T02 verifier result: `node --test scripts/verify-live-uat-evidence.test.mjs` passed with exit code 0 after the updated ledger recorded six host-execution `BLOCKED` scenario verdicts and source-backed limitations. Evidence run: `ab092cc4-adab-42d0-a1aa-92d4be25cd87`.

T03 final regression result: the evidence verifier, full Vitest gate, TypeScript and webview compile gate, and focused Playwright webview-state regression all passed with exit code 0. Evidence runs: `8ef4661f-45fc-452d-8251-6932fc59e0c0`, `e620c6e3-c349-4f37-885b-46c3b2260fe3`, `62ef61a3-3016-464b-b11f-6486b954026d`, and `5e489b23-09a1-4f33-929b-ecabb2cce37f`.

The residual live-host limitation remains unchanged: the non-interactive environment still lacks a VS Code Extension Development Host launch surface, so the six live scenarios stay `BLOCKED` for host execution rather than upgraded to live `PASS`.

## Failure Modes

| Dependency | Failure path | Handling evidence |
|---|---|---|
| VS Code Extension Development Host | Host launch command unavailable, timeout, or visible launch error prevents webview observation. | T02 PATH probes completed but found no available VS Code CLI, so all host-dependent scenarios are explicitly `BLOCKED` rather than claimed as live proof. |
| `docs/uat/m003-s04/live-uat-evidence.md` | Missing, empty, or unreadable ledger prevents evidence review. | `scripts/verify-live-uat-evidence.test.mjs` fails with a missing-document or non-empty assertion. |
| Manual evidence edits | Missing heading, scenario ID, evidence slot, command reference, or redaction rule weakens the UAT contract. | Negative fixture cases in `scripts/verify-live-uat-evidence.test.mjs` reject each missing structure class. |
| Provider CLI/backend | Provider binary, auth, or runtime may be unavailable, malformed, or unable to create a cancellable turn. | T02 did not exercise provider prompts because the host was unavailable; provider-specific behavior remains a documented limitation, and source inspection confirms command-error and recovery paths exist for host rerun. |
| Webview UI | Missing task list, workspace banner, composer controls, command-error alert, or task-scoped metadata would make live proof incomplete. | T02 could not visually inspect the webview, so source-backed UI surfaces are documented and the scenario verdicts stay `BLOCKED` pending interactive host verification. |
| Secret and runtime artifact handling | Evidence text may accidentally include provider token markers, session dumps, raw task-store claims, or mocked-live overclaims. | `scripts/verify-live-uat-evidence.test.mjs` rejects unsafe marker phrases and absolute local paths before closeout. |
| Local Node runtime | `node --test` is unavailable or incompatible. | The verifier command fails before evidence can be accepted. |

## Load Profile

This task records a bounded UAT ledger and performs one extension build, one host CLI probe, one provider CLI probe, one source-surface summary, and one verifier run. It has no production runtime load dimension.

At 10x expected evidence size, the first saturated resource would be local text scanning in the verifier and human reviewability of the ledger, not backend throughput. Protection is a small fixed set of string and regular-expression checks over one tracked markdown file, explicit scenario IDs, concise command summaries, and a rule that screenshots, raw task stores, raw backend output, and local paths stay out of the tracked artifact. The live host, when available, should use one disposable workspace, one Extension Development Host, one task store, and at most one backend subprocess at a time.

## Negative Tests

| Negative scenario | Test surface | Expected failure or bounded result |
|---|---|---|
| Empty evidence document | `scripts/verify-live-uat-evidence.test.mjs` | Fails with the non-empty assertion. |
| Missing required heading | `scripts/verify-live-uat-evidence.test.mjs` | Fails with the specific missing heading, such as `## Scenario Matrix`. |
| Missing scenario ID or evidence slot | `scripts/verify-live-uat-evidence.test.mjs` | Fails with the missing `LIVE-UAT-*` scenario ID or `EDH-EVIDENCE-*` slot. |
| Missing redaction language | `scripts/verify-live-uat-evidence.test.mjs` | Fails with the missing required redaction rule. |
| Missing command reference | `scripts/verify-live-uat-evidence.test.mjs` | Fails with the missing verifier or regression command reference. |
| Unsafe secret, raw-store, session-dump, or mocked-live marker | `scripts/verify-live-uat-evidence.test.mjs` | Fails with an unsafe marker assertion. |
| Absolute local path | `scripts/verify-live-uat-evidence.test.mjs` | Fails with the absolute local path assertion. |
| Missing VS Code CLI for live host launch | T02 PATH probe and Scenario Matrix | Produces `BLOCKED` host-execution verdicts with explicit limitation rather than false live proof. |
| Empty task prompt | `src/extension.ts` command handling and future Extension Development Host rerun | `postCommandError` should produce `message cannot be empty`; not visually exercised in T02 because host launch was unavailable. |
| Malformed cancel, retry, or resume target | `src/extension.ts` command handling and future Extension Development Host rerun | `postCommandError` should report malformed target or task-turn mismatch; not visually exercised in T02 because host launch was unavailable. |
| Cancellation with no running turn | `webview/src/components/Composer.svelte` and Scenario Matrix | Cancel affordance remains unavailable unless a focused task has running state and active turn id; no live turn existed in T02. |
