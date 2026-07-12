# M007 S02 File Drop Live Host Evidence

## Proof Boundary

This tracked ledger is the acceptance contract for file-drop behavior in a real VS Code Extension Development Host. Only direct observation in that host may establish `PASS` or `FAIL`. Unit, browser, and Playwright checks are supportive-only and cannot establish a live verdict. Each verdict is scenario-local.

T02 detected the available launchers and evaluated whether this agent session could control and observe a real Extension Development Host. A VS Code launcher was available, but the session was non-interactive and exposed neither desktop UI automation nor OS drag injection. Launching an unobservable host would not produce direct evidence, so every affected scenario remains independently `ENVIRONMENT BLOCKED`; local automated checks remain supporting-only.

## Scenario Evidence

### FILE-DROP-EXPLORER
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Drag one workspace file from VS Code Explorer into the composer and observe one textual workspace mention.
- Observed: Launcher discovery found VS Code, but no observable Explorer drag could be performed from this non-interactive agent session.
- Blocker: Attempted: detect a VS Code launcher and an available desktop UI control surface for Explorer drag. Blocker: the session has no desktop accessibility or drag automation surface, so host UI state cannot be controlled or directly observed.
- Cleanup: No UI or file state was created; no inserted mention or scenario-created editor required cleanup.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-OS-FILE-MANAGER
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Drag one workspace file from the operating-system file manager into the composer and observe one textual workspace mention.
- Observed: No live operating-system drag could be injected or observed from the non-interactive agent session.
- Blocker: Attempted: detect launcher availability and an operating-system file-manager drag injection surface. Blocker: no OS drag injector or desktop UI automation surface is presented to this session.
- Cleanup: No UI or file state was created; no inserted mention or scenario-created window required cleanup.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-CARET-INSERTION
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Drop a workspace file at a caret inside surrounding text and observe the mention inserted at that caret without losing text.
- Observed: The live composer caret could not be positioned or inspected because host UI control is unavailable.
- Blocker: Attempted: detect a controllable host surface for focusing the composer, positioning its caret, and dropping a file. Blocker: the non-interactive session exposes no desktop accessibility surface.
- Cleanup: No synthetic draft was created, so no composer cleanup was required.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-PATH-WITH-SPACES
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Drop a workspace file whose relative path contains spaces and observe one correctly delimited textual mention.
- Observed: A spaced-path file could not be dragged into or inspected in the live composer without host UI control.
- Blocker: Attempted: detect a controllable host and drag surface for a repository-relative spaced-path fixture. Blocker: desktop interaction and drag injection are unavailable in this session.
- Cleanup: No fixture or draft was created, so no temporary file or composer cleanup was required.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-OUTSIDE-WORKSPACE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Drop one file outside the workspace and observe rejection without a mention or leaked machine path.
- Observed: An external fixture could not be safely dragged into or inspected in the live composer without OS drag control.
- Blocker: Attempted: detect an OS drag injection and observable host surface for the rejection path. Blocker: neither capability is presented to this non-interactive session.
- Cleanup: No external fixture was created or referenced, and no visible error state required cleanup.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-DISABLED-COMPOSER
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Drop a workspace file while the composer is disabled and observe no draft mutation or host resolution request.
- Observed: The live disabled-composer state and host request stream could not be controlled or observed.
- Blocker: Attempted: detect a controllable host surface for entering disabled state, dropping a file, and observing requests. Blocker: desktop UI automation and live webview inspection are unavailable.
- Cleanup: No disabled state or draft was created; the composer was never mutated.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-MALFORMED-PAYLOAD
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Supply a malformed file-drop payload and observe a bounded user-facing error without draft mutation or sensitive details.
- Observed: No controlled live-webview payload injection or visible error inspection surface was available.
- Blocker: Attempted: detect a live webview inspection or message-injection surface alongside observable host UI. Blocker: this session exposes neither capability.
- Cleanup: No malformed message, error state, or draft mutation was created.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

### FILE-DROP-CLEANUP-RELOAD
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-11T12:00:00Z
- Expected: Clear scenario state, reload the Extension Development Host, and observe no stale mention, error, or scenario-created artifact.
- Observed: No observable live scenario state could be created, cleared, reloaded, or inspected for persistence.
- Blocker: Attempted: detect a controllable host surface for scenario cleanup, window reload, and post-reload inspection. Blocker: desktop UI control and direct host observation are unavailable.
- Cleanup: No host, drafts, errors, or synthetic fixtures were created, so there was no live state to clear or reload.
- Evidence: supportive-only: scripts/verify-file-drop-live-host-evidence.test.mjs

## Redaction Rules

- Use scenario IDs, UTC timestamps, bounded observations, and repository-relative evidence references only.
- Never record credentials, environment values, user prompts, assistant payloads, transcript content, raw runtime stores, or user-specific workspace identity.
- Never record absolute machine paths. Describe workspace boundaries symbolically.
- Keep every scenario field to one line and at most 500 characters.
- Review screenshots for sensitive content and cite only a bounded relative evidence identifier.
- Local automated checks remain supportive-only and cannot upgrade a live-host verdict.

## Failure Modes

| Dependency | Failure path | Required handling |
|---|---|---|
| Evidence filesystem | Ledger is missing, unreadable, or empty. | The Node verifier fails and bubbles the diagnostic; evidence is not accepted. |
| Manual ledger editing | A scenario, field, verdict, timestamp, blocker detail, cleanup action, or evidence reference is malformed or omitted. | Fixture-backed assertions fail closed and identify the scenario or field. |
| VS Code Extension Development Host | Launcher is absent, launch times out, UI control is lost, or reload is unavailable. | Record `ENVIRONMENT BLOCKED` separately for every affected scenario with attempted step and concrete blocker. |
| OS drag control | File-manager automation is unavailable or loses control. | Block only the affected OS-drag scenarios; do not infer success from Explorer or browser checks. |
| Product behavior | Drop resolution returns malformed data, errors, disconnects, or mutates unexpected state. | Record `FAIL` with bounded observed behavior and direct live evidence when reproducible. |
| Evidence hygiene | Text includes a secret marker, absolute path, raw runtime claim, placeholder, or mocked-live promotion. | The verifier rejects the entire ledger. |
| Local Node subprocess | `node --test` is unavailable, times out, or exits non-zero. | The command failure bubbles; no accepted verification is claimed. |

## Load Profile

The ledger has fixed cardinality of eight scenarios and seven bounded one-line fields per scenario. At ten times expected prose volume, human reviewability saturates before CPU or memory. The verifier limits every substantive field to 500 characters and excludes bulk logs, stores, transcripts, and embedded screenshots. This task has no production request-throughput dimension.

## Negative Tests

`scripts/verify-file-drop-live-host-evidence.test.mjs` rejects omitted scenarios, invalid verdicts, malformed UTC timestamps, missing fields, non-actionable environmental blockers, fields over 500 characters, and supportive-only evidence used for a live `PASS` or `FAIL`. It also rejects placeholders, secret-like markers, absolute paths, raw task-store or transcript claims, and language that promotes mocked browser or Playwright results to live proof.
