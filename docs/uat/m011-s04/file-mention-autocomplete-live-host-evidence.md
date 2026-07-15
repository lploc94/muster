# M011 S04 File Mention Autocomplete Live Host Evidence

## Proof Boundary

This tracked ledger is the acceptance contract for composer `@` / `@../` / `@../../` file-mention autocomplete in a real VS Code Extension Development Host. Only direct observation in that host may establish `PASS` or `FAIL`. Unit, browser, and Playwright checks are supportive-only and cannot establish a live verdict. Each verdict is scenario-local.

T02 detected the available launchers and evaluated whether this agent session could control and observe a real Extension Development Host. A VS Code launcher was available (`code` 1.128.1), but the session was non-interactive and exposed neither desktop UI automation nor a controllable webview keyboard surface. Launching an unobservable host would not produce direct evidence, so every affected scenario remains independently `ENVIRONMENT BLOCKED`; local automated checks remain supporting-only.

## Scenario Evidence

### FILE-MENTION-POPUP-DISCOVERY
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Type `@` in the live composer and observe the file-mention listbox open with host-backed relative suggestions for the current task or draft cwd.
- Observed: Launcher discovery found VS Code, but the non-interactive session could not focus the Muster Chat webview or type into the live composer.
- Blocker: Attempted: detect a VS Code launcher and a desktop accessibility or host UI control surface for composer focus and `@` typing. Blocker: the session has no desktop accessibility surface, so host UI state cannot be controlled or directly observed.
- Cleanup: No UI or draft was created; no listbox or scenario-created editor required cleanup.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-SCOPE-CURRENT
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: With `@` at parentDepth 0, observe relative current-directory suggestions only and no absolute paths or raw filesystem errors.
- Observed: Current-directory suggestions could not be requested or inspected without live composer control.
- Blocker: Attempted: detect a controllable host surface for typing `@` and reading listbox options. Blocker: desktop UI automation and live webview inspection are unavailable in this session.
- Cleanup: No request or listbox state was created.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-SCOPE-PARENT
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Type `@../` and observe parent-scope relative suggestions with `../` insertion paths.
- Observed: Parent-scope typing and listbox contents could not be exercised or observed live.
- Blocker: Attempted: detect a controllable host surface for typing `@../` and observing options. Blocker: the non-interactive session exposes no desktop accessibility surface.
- Cleanup: No parent-scope draft or popup was created.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-SCOPE-GRANDPARENT
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Type `@../../` and observe grandparent-scope relative suggestions; `@../../../` must not open a host request.
- Observed: Grandparent typing and depth-rejection could not be controlled or inspected live.
- Blocker: Attempted: detect a controllable host surface for `@../../` typing and depth-3 non-request observation. Blocker: desktop interaction and live webview inspection are unavailable.
- Cleanup: No grandparent draft or popup was created.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-DIRECTORY-REFINEMENT
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Accept a directory suggestion to refine into nested relative path and re-list children under the selected scope.
- Observed: Directory refinement could not be activated or observed without live listbox control.
- Blocker: Attempted: detect a controllable host surface for accepting a directory option and re-querying nested suggestions. Blocker: no desktop accessibility surface is presented to this session.
- Cleanup: No refined draft or nested listbox was created.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-KEYBOARD-SELECTION
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Use ArrowDown or ArrowUp and Enter or Tab to accept a file suggestion, replace the active query at the caret, and leave surrounding draft text intact.
- Observed: Keyboard navigation and accept could not be injected or inspected in the live host.
- Blocker: Attempted: detect a controllable host keyboard surface for listbox navigation and accept. Blocker: the session has no desktop accessibility or key-injection surface.
- Cleanup: No keyboard-driven mention insertion was performed.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-TASK-CWD
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Focus two tasks with different working directories and observe suggestions resolve from each task cwd without trusting a webview-supplied path.
- Observed: Task focus and cwd-scoped listing could not be controlled or observed live.
- Blocker: Attempted: detect a controllable host surface for focusing tasks and comparing suggestion scopes. Blocker: desktop UI control and direct host observation are unavailable.
- Cleanup: No multi-task focus or request state was created.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

### FILE-MENTION-CLEANUP-RELOAD
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-15T02:10:00Z
- Expected: Dismiss the popup, clear scenario draft state, reload the Extension Development Host, and observe no stale listbox, error, or leftover request correlation.
- Observed: No observable live scenario state could be created, cleared, reloaded, or inspected for persistence.
- Blocker: Attempted: detect a controllable host surface for popup dismiss, draft clear, window reload, and post-reload inspection. Blocker: desktop UI control and direct host observation are unavailable.
- Cleanup: No host, drafts, errors, or synthetic fixtures were created, so there was no live state to clear or reload.
- Evidence: supportive-only: scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs

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
| Host filesystem authority | Cwd resolution fails, listing throws, or symlink refinement escapes scope. | Host returns bounded `unavailable` or `listingFailed`; live FAIL only when the product misbehaves under direct observation. |
| Webview request correlation | Stale, cross-task, or mismatched `requestId` or parentDepth responses arrive late. | Webview rejects the response; listbox must not paint foreign results. Live FAIL only when observed in host. |
| Evidence hygiene | Text includes a secret marker, absolute path, raw runtime claim, placeholder, or mocked-live promotion. | The verifier rejects the entire ledger. |
| Local Node subprocess | `node --test` is unavailable, times out, or exits non-zero. | The command failure bubbles; no accepted verification is claimed. |

## Load Profile

The ledger has fixed cardinality of eight scenarios and seven bounded one-line fields per scenario. At ten times expected prose volume, human reviewability saturates before CPU or memory. The verifier limits every substantive field to 500 characters and excludes bulk logs, stores, transcripts, and embedded screenshots. Product suggestion listings are separately capped at 50 items and 256-character queries; this ledger task has no production request-throughput dimension.

## Negative Tests

`scripts/verify-file-mention-autocomplete-live-host-evidence.test.mjs` rejects omitted scenarios, invalid verdicts, malformed UTC timestamps, missing fields, non-actionable environmental blockers, fields over 500 characters, and supportive-only evidence used for a live `PASS` or `FAIL`. It also rejects placeholders, secret-like markers, absolute paths, raw task-store or transcript claims, and language that promotes mocked browser or Playwright results to live proof.
