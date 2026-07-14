# M006 S05 Presentation Live Host Evidence

## Environment and Preconditions

- Live attempt recorded: 2026-07-10T23:23:22Z.
- Workspace identity is intentionally omitted; all references are repository-relative.
- Environment: Windows x64, VS Code 1.128.0, extension launched through the CLI-equivalent Extension Development Host workflow.
- Required live environment: VS Code, this extension launched as an Extension Development Host, an authenticated coordinator path, and synthetic non-sensitive presentation content.
- Local preconditions passed: `npm run test:presentation-integration` and `npm run test:presentation-live-evidence`.
- The host launch command returned successfully. The automation surface supplied to this run supports macOS applications only and failed its permission probe because its platform launcher is absent; it cannot inspect or control Windows VS Code. No authenticated coordinator interaction or live panel observation was therefore possible.

## Proof Boundary

Playwright and local integration gates are supportive only. They may establish browser rendering and local contracts, but they cannot establish a live scenario verdict. A `PASS` requires actual VS Code Extension Development Host observation and a bounded live evidence reference. A `FAIL` requires a live reproduction. `ENVIRONMENT BLOCKED` requires both the attempted step and its concrete environmental blocker. Verdicts are scenario-local and must not be inherited from another scenario or a blanket host status.

## Scenario Evidence

### PRESENTATION-OPENING
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: The Extension Development Host launch request exited successfully, but no presentation UI could be inspected.
- Evidence: Attempted: launch the extension host and open synthetic Markdown, table, code, and Mermaid content through the authenticated coordinator. Blocker: Windows VS Code cannot be controlled by the supplied macOS-only UI automation surface, and an authenticated coordinator interaction could not be established.

### PRESENTATION-SAME-ID-UPDATE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No live panel identity or newer same-identity revision was visible to the automation run.
- Evidence: Attempted: submit a newer revision for the synthetic presentation after host launch. Blocker: the run could not inspect or interact with the launched Windows Extension Development Host.

### PRESENTATION-MULTI-ID-ISOLATION
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No concurrent live tabs or cross-panel mutation state could be observed.
- Evidence: Attempted: open two synthetic presentation identities and issue a stale update. Blocker: host UI control is unavailable on Windows through the supplied automation surface, so neither tab could be created through an authenticated coordinator path.

### PRESENTATION-MERMAID-BOUNDS-FALLBACK
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No live rendered diagram or visible malformed-diagram fallback could be inspected.
- Evidence: Attempted: present one bounded diagram and one malformed synthetic diagram in the launched host. Blocker: authenticated coordinator input and Windows host UI inspection were unavailable; local browser coverage remains supportive only.

### PRESENTATION-LINKED-CHAT-REVEAL
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No linked-chat button status or owner-bound reveal result was observed live.
- Evidence: Attempted: open linked chat from a coordinator-created presentation. Blocker: no authenticated coordinator session could be operated without Windows UI control.

### PRESENTATION-EXISTING-TASK-REVISION
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No feedback continuation or correlated same-panel refresh was observed live.
- Evidence: Attempted: continue the existing synthetic task and request a revised presentation. Blocker: the authenticated chat and presentation controls in Windows VS Code were inaccessible to the available automation.

### PRESENTATION-SUPPORTED-RESTORE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No window reload or restored presentation identity could be observed.
- Evidence: Attempted: reach a presentation state and execute the supported window reload workflow. Blocker: no presentation could be established or inspected before reload because Windows host control was unavailable.

### PRESENTATION-DISPOSAL
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: No live presentation panel was available for observed disposal or post-disposal isolation.
- Evidence: Attempted: close a synthetic presentation and issue a later update. Blocker: the automation could not create, inspect, or close Windows VS Code presentation tabs.

### PRESENTATION-FINAL-CLEANUP
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-10T23:23:22Z
- Observation: Cleanup and no-resurrection state could not be confirmed; no scenario-created panel or authenticated task was observable.
- Evidence: Attempted: close scenario-created panels and verify no resurrection after final cleanup. Blocker: the CLI launch detached successfully but the supplied automation cannot enumerate or control Windows VS Code, so host-window cleanup state is unknown and is not claimed.

## Redaction Rules

- Record only scenario IDs, UTC timestamps, bounded UI observations, relative references, and redacted diagnostic identifiers.
- Never record credentials, provider tokens, environment values, user prompts, task transcript content, assistant payloads, or raw task-store data.
- Never record absolute local paths or user-specific workspace identifiers.
- Synthetic presentation text must be non-sensitive and short.
- Screenshots must be reviewed for sensitive content and referenced by a relative evidence identifier rather than embedded machine locations.
- A local test result may be cited only as supportive evidence; it cannot upgrade a live-host verdict.

## Failure Modes

| Dependency | Failure path | Required handling |
|---|---|---|
| Evidence file | Missing or unreadable file | Verifier fails before accepting evidence. |
| Manual scenario edit | Missing scenario, duplicate field, malformed verdict or timestamp | Diagnostic names the scenario and violated field. |
| VS Code Extension Development Host | Launch unavailable, timeout, lost control, or reload unavailable | Record `ENVIRONMENT BLOCKED` per affected scenario with attempted step and concrete blocker. |
| Authenticated coordinator or backend | Authentication unavailable, connection loss, or malformed response | Record scenario-local environmental blockage when execution cannot begin; record `FAIL` with reproduction when the product mishandles an available dependency. |
| Presentation behavior | Unexpected panel, revision, renderer, reveal, restore, disposal, or cleanup state | Record `FAIL` with bounded reproduction and live evidence reference. |
| Evidence hygiene | Sensitive marker, runtime payload, absolute path, or mocked-as-live claim | Verifier rejects the ledger before acceptance. |
| Local Node subprocess | `node --test` unavailable, timeout, or non-zero exit | Verification bubbles the non-zero result; no evidence acceptance is claimed. |

## Load Profile

The ledger has a fixed nine-scenario cardinality and exactly four fields per scenario. At 10x expected prose volume, human reviewability saturates before CPU or memory. The verifier protects this surface by requiring fixed scenario identities and bounded one-line observations/evidence; the ledger excludes bulk screenshots, logs, transcripts, and runtime stores. There is no production request-throughput dimension in this task.

## Negative Tests

The fixture-backed verifier in `scripts/verify-presentation-live-host-evidence.test.mjs` covers:

- omitted required scenario and invalid verdict;
- missing attempted step or concrete blocker for an environment-blocked scenario;
- missing final cleanup observation;
- absolute machine path;
- secret-like marker;
- forbidden placeholder;
- mocked or Playwright evidence presented as live-host proof;
- transcript and raw task-store payload claims.

Each assertion requires a scenario-specific or evidence-rule-specific diagnostic so malformed evidence fails closed.
