# M019 S05 Native First Run Evidence

## Environment and Preconditions

Tracked live ledger for the packaged Extension Host native first-run matrix. Provider coverage covers the five allowlisted readiness IDs (`claude`, `grok`, `kiro`, `codex`, `opencode`) plus host activation, Doctor, first-task acceptance, and cleanup. T05 executed `npm run test:m019-s05-native-first-run` (fresh VSIX via createVSIX, disposable Extension Development Host, `MUSTER_UAT_MODE=1`) and reconciled the closed host result. Host result: ok=true, readyProviderId=none, cleanupCompleted=true, vscode 1.129.1. No credentials, prompts, absolute paths, raw stderr, or store bodies are recorded.

## Proof Boundary

Playwright and local integration gates are supportive only. PASS requires actual VS Code Extension Development Host observation through the packaged Extension Host runner (`scripts/run-m019-s05-native-first-run.mjs` launching `scripts/m019-s05-native-first-run.ts` against a freshly packaged VSIX with `MUSTER_UAT_MODE=1`). Browser fixtures and injected host suites cannot replace native proof and do not claim native PASS. Scenario-local `ENVIRONMENT BLOCKED` is the honest outcome when launch, provider install/auth, probe, Doctor, or first-send prerequisites are unavailable. This ledger does not claim CI ran native UAT, and a valid ENVIRONMENT BLOCKED ledger does not claim CI ran native UAT.

## Scenario Evidence

### NATIVE-HOST-ACTIVATE
- Verdict: PASS
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Packaged tlelabs.muster activated under MUSTER_UAT_MODE; UAT ping ok; chat view open requested; extensionActive=true.
- Evidence: runner: npm run test:m019-s05-native-first-run; observation: NATIVE-HOST-ACTIVATE PASS packaged extension activated UAT ping ok.

### NATIVE-CLAUDE-FIRST-RUN
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Claude refresh/probe ran through production UAT adapter; state=installed_unverified; probe did not reach ready; no native ready claim.
- Evidence: Attempted: readiness refresh and isolated Test Connection for claude in packaged Extension Host. Blocker: probe ENVIRONMENT_BLOCKED with block=host_unavailable (state=installed_unverified code=none recovery=none).

### NATIVE-GROK-FIRST-RUN
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Grok refresh/probe ran through production UAT adapter; state=installed_unverified; probe did not reach ready; no native ready claim.
- Evidence: Attempted: readiness refresh and isolated Test Connection for grok in packaged Extension Host. Blocker: probe ENVIRONMENT_BLOCKED with block=host_unavailable (state=installed_unverified code=none recovery=none).

### NATIVE-KIRO-FIRST-RUN
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Kiro refresh/probe ran through production UAT adapter; state=missing with code=executable_missing recovery=install; probe did not reach ready.
- Evidence: Attempted: readiness refresh and isolated Test Connection for kiro in packaged Extension Host. Blocker: probe ENVIRONMENT_BLOCKED with block=host_unavailable (state=missing code=executable_missing recovery=install).

### NATIVE-CODEX-FIRST-RUN
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Codex refresh/probe ran through production UAT adapter; state=installed_unverified with code=internal_error; probe did not reach ready.
- Evidence: Attempted: readiness refresh and isolated Test Connection for codex in packaged Extension Host. Blocker: probe ENVIRONMENT_BLOCKED with block=host_unavailable (state=installed_unverified code=internal_error recovery=none).

### NATIVE-OPENCODE-FIRST-RUN
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-26T02:10:26Z
- Observation: OpenCode refresh/probe ran through production UAT adapter; state=installed_unverified; probe did not reach ready; no native ready claim.
- Evidence: Attempted: readiness refresh and isolated Test Connection for opencode in packaged Extension Host. Blocker: probe ENVIRONMENT_BLOCKED with block=host_unavailable (state=installed_unverified code=none recovery=none).

### NATIVE-DOCTOR
- Verdict: PASS
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Doctor ran via non-production UAT adapter on the production diagnostics path for provider tag claude; doctorResult=success.
- Evidence: runner: npm run test:m019-s05-native-first-run; observation: NATIVE-DOCTOR PASS step=doctor doctor=success.

### NATIVE-FIRST-TASK-ACCEPTANCE
- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Clean-workspace first-task acceptance was not attempted because no provider reached ready after refresh/probe.
- Evidence: Attempted: accept a first task through the production send path for one ready provider after refresh and probe. Blocker: no ready provider after refresh/probe; first-task acceptance not attempted (readyProviderId=none).

### NATIVE-FINAL-CLEANUP
- Verdict: PASS
- Timestamp: 2026-07-26T02:10:26Z
- Observation: Cleanup completed through the UAT adapter; probes disposed and no residual UAT first-task retained; cleanup=yes.
- Evidence: runner: npm run test:m019-s05-native-first-run; observation: NATIVE-FINAL-CLEANUP PASS cleanup=yes disposed.

## Redaction Rules

- Use scenario IDs, UTC timestamps, bounded observations, and repository-relative evidence references only.
- Never record credentials, environment values, user prompts, assistant payloads, transcript content, raw runtime stores, unredacted host dumps, raw stderr, or user-specific workspace identity.
- Never record absolute machine paths. Describe hosts, profiles, and workspaces symbolically.
- Keep every scenario field to one line and at most 500 characters.
- Record only allowlisted provider IDs, readiness states, diagnostic codes, recovery actions, Doctor result kinds, first-send accept/reject codes, and cleanup booleans from the UAT observation schema.
- Local automated checks remain supportive-only and cannot upgrade a live-host verdict.
- A valid ENVIRONMENT BLOCKED ledger does not claim CI ran native UAT.

## Failure Modes

| Dependency | Failure path | Required handling |
|---|---|---|
| Evidence filesystem | Ledger is missing, unreadable, or empty. | The Node verifier fails and bubbles the diagnostic; evidence is not accepted. |
| Manual ledger editing | A scenario, field, verdict, timestamp, blocker detail, or evidence reference is malformed or omitted. | Fixture-backed assertions fail closed and identify the scenario or field. |
| Packaged VSIX build | `createVSIX` fails, packages forbidden workspace-local files, or omits compiled extension entry. | Runner exits non-zero; no native PASS is recorded; scenarios remain ENVIRONMENT BLOCKED with attempted packaging step. |
| VS Code Extension Development Host | Launcher is absent, download times out, activation fails, or UAT mode is unavailable. | Record ENVIRONMENT BLOCKED separately for every affected scenario with attempted step and concrete blocker. |
| Provider PATH or auth | A provider CLI is missing, auth is required, or the provider is incompatible. | Scenario-local ENVIRONMENT BLOCKED with provider_missing, auth_required, or incompatible; do not mock readiness as ready. |
| Isolated Test Connection | Probe refuses, times out, or fails to reach ready. | ENVIRONMENT BLOCKED with probe_failed (or mapped code); never paste raw stderr. |
| Doctor command | Diagnostics refresh, open, or reveal fails. | ENVIRONMENT BLOCKED with doctor_failed; record only the bounded doctorResult kind. |
| First-task acceptance | Host send path rejects or errors after a ready probe. | FAIL for product gate rejects; ENVIRONMENT BLOCKED for host_unavailable; never store prompt or task bodies. |
| Cleanup | Probe dispose or task delete fails. | Best-effort cleanup still reported; residual risk noted without absolute paths. |
| Evidence hygiene | Text includes a secret marker, absolute path, unredacted runtime claim, placeholder, or mocked-live promotion. | The verifier rejects the entire ledger. |
| Local Node subprocess | `node --test` is unavailable, times out, or exits non-zero. | The command failure bubbles; no accepted verification is claimed. |

## Load Profile

The ledger has fixed cardinality of nine scenarios and four bounded one-line fields per scenario. At ten times expected prose volume, human reviewability saturates before CPU or memory. The verifier limits every substantive field to 500 characters and excludes bulk logs, stores, transcripts, host dumps, and embedded screenshots. The packaged runner exercises one disposable profile and at most one first-task acceptance path per run. This task has no production request-throughput dimension.

## Negative Tests

`scripts/verify-m019-s05-native-first-run-evidence.test.mjs` rejects omitted scenarios, invalid verdicts, malformed timestamps, missing attempted/blocker detail, absent cleanup language, absolute paths, secret-like markers, pending placeholders, mocked-as-live overclaim, transcript/raw-store/stderr payload claims, blanket inherited verdicts, and PASS/FAIL records that cite only supportive-only evidence. `scripts/m019-s05-native-first-run.test.ts` rejects malformed runner results, unknown provider IDs, open observation keys, and overclaiming structural results as live PASS.
