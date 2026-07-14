# M009 S03 Task Export Live Host Evidence

## Proof Boundary

This tracked ledger is the acceptance contract for native task/chat Markdown export in a real VS Code Extension Development Host. Only direct observation in that host may establish `PASS` or `FAIL`. Unit, browser, and Playwright checks are supportive only and cannot establish a live verdict for Save As, cancel, overwrite, Unicode filename, or write-failure outcomes. Each verdict is scenario-local.

T04 detected the available launch surface and evaluated whether this agent session could control and observe a real Extension Development Host native Save As dialog. A VS Code launcher may be present on the machine, but the session is non-interactive and exposes neither desktop UI automation nor native dialog control. Launching an unobservable host would not produce direct evidence, so every affected scenario remains independently `ENVIRONMENT BLOCKED`; local automated checks remain supporting-only.

## Scenario Evidence

### EXPORT-SAVE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-14T12:00:00Z
- Expected: From a focused task, trigger Export task/chat, approve native Save As with a safe .md basename, and observe a task-scoped success notice with basename-only fileName plus sourceRevision.
- Observed: Native Save As could not be opened, approved, or inspected because host UI control is unavailable in this non-interactive agent session.
- Blocker: Attempted: detect a controllable Extension Development Host surface for Export task/chat and native Save As approval. Blocker: the session has no desktop accessibility or dialog automation surface, so host UI state cannot be controlled or directly observed.
- Cleanup: No Save As dialog, written export file, or success notice was created; later live runs must dismiss any open dialog and delete scenario-created files.
- Evidence: supportive-only: scripts/verify-task-export-live-host-evidence.test.mjs

### EXPORT-CANCEL
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-14T12:00:00Z
- Expected: Trigger Export task/chat, cancel the native Save As dialog, and observe no exportResult, no commandError, and no stale success/failure chrome for the focused task.
- Observed: The live cancel path could not be exercised or inspected without dialog control.
- Blocker: Attempted: detect a controllable host surface for opening Save As and dismissing it via Cancel. Blocker: desktop dialog automation is unavailable in this session.
- Cleanup: No dialog or export notice was created, so no cancel-state cleanup was required.
- Evidence: supportive-only: scripts/verify-task-export-live-host-evidence.test.mjs

### EXPORT-OVERWRITE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-14T12:00:00Z
- Expected: Choose an existing .md target in native Save As, confirm overwrite if prompted, and observe a successful basename-only exportResult without absolute paths or store mutation side effects beyond the written file.
- Observed: An existing target file could not be selected or overwritten through a live Save As dialog.
- Blocker: Attempted: detect a controllable host and filesystem dialog surface for overwrite confirmation. Blocker: native dialog control and direct host observation are unavailable.
- Cleanup: No overwrite target was created or modified; later live runs must restore or delete scenario-created files.
- Evidence: supportive-only: scripts/verify-task-export-live-host-evidence.test.mjs

### EXPORT-UNICODE-FILENAME
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-14T12:00:00Z
- Expected: Export a focused task whose goal contains Unicode and observe that the suggested/safe filename remains ASCII-slug or falls back to task-export.md while the success notice still shows basename-only fileName.
- Observed: A Unicode-goal task could not be focused and exported through the live host Save As path.
- Blocker: Attempted: detect a controllable Extension Development Host surface for focusing a Unicode-goal task and completing Save As. Blocker: desktop UI automation is unavailable in this non-interactive session.
- Cleanup: No Unicode-goal task or export file was created for this scenario.
- Evidence: supportive-only: scripts/verify-task-export-live-host-evidence.test.mjs

### EXPORT-WRITE-FAILURE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-14T12:00:00Z
- Expected: Force a write failure after Save As approval and observe a task-scoped sanitized commandError without absolute paths, credentials, stacks, or transcript content.
- Observed: A live write-failure path could not be induced or inspected without host filesystem and dialog control.
- Blocker: Attempted: detect a controllable host surface for approving Save As into a non-writable target and observing sanitized failure chrome. Blocker: neither dialog automation nor permissioned filesystem control is presented to this session.
- Cleanup: No non-writable target, error banner, or partial file was created.
- Evidence: supportive-only: scripts/verify-task-export-live-host-evidence.test.mjs

## Redaction Rules

- Use scenario IDs, UTC timestamps, bounded observations, and repository-relative evidence references only.
- Never record credentials, environment values, user prompts, assistant payloads, transcript content, raw runtime stores, or user-specific workspace identity.
- Never record absolute machine paths. Describe Save As targets and workspace boundaries symbolically.
- Keep every scenario field to one line and at most 500 characters.
- Review screenshots for sensitive content and cite only a bounded relative evidence identifier.
- Local automated checks remain supportive-only and cannot upgrade a live-host verdict.

## Failure Modes

| Dependency | Failure path | Required handling |
|---|---|---|
| Evidence filesystem | Ledger is missing, unreadable, or empty. | The Node verifier fails and bubbles the diagnostic; evidence is not accepted. |
| Manual ledger editing | A scenario, field, verdict, timestamp, blocker detail, cleanup action, or evidence reference is malformed or omitted. | Fixture-backed assertions fail closed and identify the scenario or field. |
| VS Code Extension Development Host | Launcher is absent, launch times out, UI control is lost, or reload is unavailable. | Record `ENVIRONMENT BLOCKED` separately for every affected scenario with attempted step and concrete blocker. |
| Native Save As dialog | Dialog automation is unavailable or loses control mid-flow. | Block only the affected dialog scenarios; do not infer success from Playwright or unit checks. |
| Filesystem write provider | Write fails, times out, or returns a malformed error. | Record `FAIL` with bounded observed sanitized error when reproducible in the live host; never paste absolute paths or raw stacks. |
| Evidence hygiene | Text includes a secret marker, absolute path, raw runtime claim, placeholder, or mocked-live promotion. | The verifier rejects the entire ledger. |
| Local Node subprocess | `node --test` is unavailable, times out, or exits non-zero. | The command failure bubbles; no accepted verification is claimed. |

## Load Profile

The ledger has fixed cardinality of five scenarios and seven bounded one-line fields per scenario. At ten times expected prose volume, human reviewability saturates before CPU or memory. The verifier limits every substantive field to 500 characters and excludes bulk logs, stores, transcripts, and embedded screenshots. This task has no production request-throughput dimension.

## Negative Tests

`scripts/verify-task-export-live-host-evidence.test.mjs` rejects omitted scenarios, invalid verdicts, malformed UTC timestamps, missing fields, non-actionable environmental blockers, fields over 500 characters, and supportive-only evidence used for a live `PASS` or `FAIL`. It also rejects placeholders, secret-like markers, absolute paths, raw task-store or transcript claims, and language that promotes mocked browser or Playwright results to live proof.
