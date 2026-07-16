# M012 S04 Settings Live Host Evidence

## Proof Boundary

This tracked ledger is the acceptance contract for the assembled five-topic Muster Settings experience in a real VS Code Extension Development Host. Only direct observation in that host may establish `PASS` or `FAIL`. Unit, browser, and Playwright checks are supportive only and cannot establish a live verdict for keyboard tab focus, Task Types persistence, permission mode policy, pending-permission isolation, retention persistence, hide/reveal restoration, 320px reflow, placeholder no-op, or final cleanup. Each verdict is scenario-local.

T02 detected the available launch surface and evaluated whether this agent session could control and observe a real Extension Development Host Settings UI. A VS Code launcher was available (`code` 1.128.1), but the session was non-interactive and exposed neither desktop UI automation nor a controllable webview keyboard surface. PowerShell UIAutomation assemblies load, yet no agent-accessible automation driver can focus Muster Chat, open Settings, drive tabs, or inspect host-owned persistence. Launching an unobservable host would not produce direct evidence, so every affected scenario remains independently `ENVIRONMENT BLOCKED`; local automated checks remain supporting-only.

## Scenario Evidence

### SETTINGS-TAB-KEYBOARD-FOCUS
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Open Settings in the live host, focus the topic tablist, and observe ArrowLeft/ArrowRight wrap, Home, End, mouse activation, Tab into the panel, and WAI-ARIA selected/controlled relationships across all five topics.
- Observed: Launcher discovery found VS Code, but the non-interactive session could not open Settings or inject keyboard focus into the live webview tablist.
- Blocker: Attempted: detect a VS Code launcher and a desktop accessibility or host UI control surface for Settings tab focus and keyboard traversal. Blocker: the session has no desktop accessibility surface, so host UI state cannot be controlled or directly observed.
- Cleanup: No Settings UI, tab focus, or host window was created; later live runs must close Settings and restore focus to the chat surface.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-TASK-TYPES-PERSISTENCE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Change a Task Types host-owned value, save successfully, reload the Extension Development Host, and observe the saved snapshot restored without drafts, secrets, or machine-local path leakage.
- Observed: Task Types host-backed update and post-reload restoration could not be driven or inspected without live Settings control.
- Blocker: Attempted: detect a controllable host surface for Task Types save, reload, and snapshot inspection. Blocker: desktop UI automation and live webview inspection are unavailable in this session.
- Cleanup: No Task Types draft or saved value was mutated; later live runs must restore prior Task Types snapshots after scenario saves.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-PERMISSION-MODE-POLICY
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Change the permission mode enum through Settings, confirm host persistence, and observe sanitized policy feedback without secret leakage or unredacted host dumps.
- Observed: Permission mode policy could not be changed or inspected through the live host Settings surface.
- Blocker: Attempted: detect a controllable host surface for permission-mode selection and host-backed save confirmation. Blocker: the non-interactive session exposes no desktop accessibility surface.
- Cleanup: No permission mode value was changed; later live runs must restore the prior permission mode after scenario saves.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-PENDING-PERMISSION-ISOLATION
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: While a pending permission prompt exists for one topic or task context, mutate and save another Settings topic and observe the pending prompt and other topics remain isolated with no cross-topic draft bleed.
- Observed: Pending-permission isolation could not be staged or observed without live host prompts and Settings control.
- Blocker: Attempted: detect a controllable host surface for opening a pending permission prompt and mutating an isolated Settings topic. Blocker: desktop interaction and live host observation are unavailable.
- Cleanup: No pending permission prompt or Settings draft was created; later live runs must dismiss open prompts and restore Settings values.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-RETENTION-PERSISTENCE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Change Retention host-owned values, save successfully, reload, and observe the saved retention snapshot restored without machine-local path leakage or unredacted store contents.
- Observed: Retention host-backed update and post-reload restoration could not be exercised live.
- Blocker: Attempted: detect a controllable host surface for Retention save, reload, and snapshot inspection. Blocker: desktop UI automation and live webview inspection are unavailable in this session.
- Cleanup: No Retention value was mutated; later live runs must restore prior Retention snapshots after scenario saves.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-HIDE-REVEAL-RESTORATION
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Open Settings, select a non-default topic, hide then re-reveal the Settings surface, and observe selected topic, saved snapshots, and dirty drafts restore according to the state contract.
- Observed: Hide/reveal restoration could not be controlled or inspected without a live host Settings surface.
- Blocker: Attempted: detect a controllable host surface for Settings hide, reveal, and post-reveal state inspection. Blocker: the session has no desktop accessibility or host UI control surface.
- Cleanup: No hide/reveal cycle was performed; later live runs must close Settings and clear scenario drafts after inspection.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-320PX-REFLOW
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Resize the live host webview to 320 CSS pixels and observe page containment, one-row local tab overflow, keyboard reachability of all topics, and no horizontal page escape.
- Observed: Live host viewport resize and 320px layout inspection could not be performed without host UI control.
- Blocker: Attempted: detect a controllable host surface for resizing the Muster webview to 320px and inspecting tab overflow plus keyboard reachability. Blocker: desktop window control and live webview inspection are unavailable.
- Cleanup: No host window was resized; later live runs must restore the prior webview size after measurement.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-PLACEHOLDER-NOOP
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: Activate both Coming soon topics, interact with their placeholder panels, and observe zero host mutation, no save requests, and no draft or snapshot changes in active topics.
- Observed: Placeholder no-op behavior could not be activated or inspected in a live Extension Development Host.
- Blocker: Attempted: detect a controllable host surface for selecting Coming soon topics and confirming zero host mutation. Blocker: desktop UI automation is unavailable in this non-interactive session.
- Cleanup: No placeholder interaction or host mutation occurred; later live runs must still verify no residual drafts after placeholder visits.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

### SETTINGS-FINAL-CLEANUP
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-16T00:37:52Z
- Expected: After live scenarios, restore all Settings values, dismiss permission prompts, close Settings, and reload if needed so no scenario drafts, dirty indicators, or host windows remain.
- Observed: No observable live scenario state could be created, restored, reloaded, or inspected for residual Settings pollution.
- Blocker: Attempted: detect a controllable host surface for Settings value restore, prompt dismiss, Settings close, and post-reload inspection. Blocker: desktop UI control and direct host observation are unavailable.
- Cleanup: No host, Settings drafts, prompts, or synthetic fixtures were created, so there was no live state to restore or reload.
- Evidence: supportive-only: scripts/verify-settings-live-host-evidence.test.mjs

## Redaction Rules

- Use scenario IDs, UTC timestamps, bounded observations, and repository-relative evidence references only.
- Never record credentials, environment values, user prompts, assistant payloads, transcript content, raw runtime stores, unredacted host dumps, or user-specific workspace identity.
- Never record absolute machine paths. Describe Settings targets and workspace boundaries symbolically.
- Keep every scenario field to one line and at most 500 characters.
- Review screenshots for sensitive content and cite only a bounded relative evidence identifier.
- Local automated checks remain supportive-only and cannot upgrade a live-host verdict.
- A valid ENVIRONMENT BLOCKED ledger does not claim CI ran native UAT.

## Failure Modes

| Dependency | Failure path | Required handling |
|---|---|---|
| Evidence filesystem | Ledger is missing, unreadable, or empty. | The Node verifier fails and bubbles the diagnostic; evidence is not accepted. |
| Manual ledger editing | A scenario, field, verdict, timestamp, blocker detail, cleanup action, or evidence reference is malformed or omitted. | Fixture-backed assertions fail closed and identify the scenario or field. |
| VS Code Extension Development Host | Launcher is absent, launch times out, UI control is lost, or reload is unavailable. | Record `ENVIRONMENT BLOCKED` separately for every affected scenario with attempted step and concrete blocker. |
| Settings host protocol | Host update fails, times out, or returns a sanitized error for Task Types, Permissions, or Retention. | Record `FAIL` with bounded observed sanitized feedback when reproducible in the live host; never paste machine-local paths, secrets, or unredacted exceptions. |
| Pending permission prompts | Prompt cannot be staged, dismissed, or isolated from Settings mutation. | Block only isolation scenarios when prompts cannot be controlled; do not infer isolation from Playwright. |
| Webview viewport control | Host window cannot be resized to 320px or inspected for overflow. | Record `ENVIRONMENT BLOCKED` for reflow when window control is unavailable; do not promote browser viewport checks to native proof. |
| Evidence hygiene | Text includes a secret marker, absolute path, unredacted runtime claim, placeholder, or mocked-live promotion. | The verifier rejects the entire ledger. |
| Local Node subprocess | `node --test` is unavailable, times out, or exits non-zero. | The command failure bubbles; no accepted verification is claimed. |

## Load Profile

The ledger has fixed cardinality of nine scenarios and seven bounded one-line fields per scenario. At ten times expected prose volume, human reviewability saturates before CPU or memory. The verifier limits every substantive field to 500 characters and excludes bulk logs, stores, transcripts, host dumps, and embedded screenshots. This task has no production request-throughput dimension.

## Negative Tests

`scripts/verify-settings-live-host-evidence.test.mjs` rejects omitted scenarios, duplicate scenarios, invalid verdicts, malformed UTC timestamps, missing fields, non-actionable environmental blockers, fields over 500 characters, and supportive-only evidence used for a live `PASS` or `FAIL`. It also rejects placeholders, secret-like markers, absolute paths, raw task-store, transcript, or config claims, and language that promotes mocked browser or Playwright results to live proof.
