# M002 Verification Evidence

## Scope

This ledger records what M002 verification can prove from tracked source files and executable local commands. It is an inspection surface for source-boundary evidence only: it does not read `.gsd/`, does not inspect hosted services, does not read runtime session files, and does not expose local secrets.

The ledger is intentionally bounded to files and commands that can be reviewed or run from the repository checkout:

- `package.json`
- `.github/workflows/ci.yml`
- `scripts/source-boundary-smoke.mjs`
- `scripts/source-boundary-smoke.test.mjs`
- `scripts/verify-verification-evidence.test.mjs`
- `src/extension.ts`
- `src/backends/claude.ts`
- `src/runner.ts`
- `src/task/store.ts`
- `src/types.ts`
- `mcp/muster-ask-server.mjs`

## Evidence Ledger

| Evidence ID | Proof Class | Source | What It Proves | Boundary |
|---|---|---|---|---|
| `4eadab69-0625-468d-b8ea-a14ebf4c1f50` | Contract proof | `package.json`, `npm test`, `npm run test:source-boundary` | The shared local verifier runs the Vitest suite, and the source-boundary verifier is exposed as `npm run test:source-boundary`. | Proves command wiring, not provider behavior. |
| `1d35583d-5aa1-465b-a82f-b73e845f7b12` | Integration proof | `.github/workflows/ci.yml` | The CI workflow contract installs with `npm ci` and invokes `npm test` on `main` push and pull request events. | Proves tracked workflow shape, not remote runner outcome. |
| `19e55c63-33c2-4f7a-850a-d3995078c926` | Operational proof | `scripts/source-boundary-smoke.mjs`, `node scripts/source-boundary-smoke.mjs` | The smoke checker emits actionable diagnostics for missing source-boundary files, malformed JSON, CI drift, missing command wiring, and unsupported runtime-scope phrases. | Proves local diagnostic behavior. |
| `c926e218-ec60-4024-8a7c-fda53d5e8bb1` | Artifact-driven UAT proof | `scripts/source-boundary-smoke.test.mjs`, `node --test scripts/source-boundary-smoke.test.mjs` | Fixture tests cover accepted source-boundary shape and negative drift cases without requiring live services. | Proves artifact behavior under local fixtures. |
| `64f78de1-e31f-425b-ac37-69f3a9ceafb8` | Contract proof | `src/extension.ts`, `src/backends/claude.ts`, `src/runner.ts`, `src/task/store.ts`, `src/types.ts`, `mcp/muster-ask-server.mjs` | Source references preserve extension wiring, backend delegation, normalized event contracts, task-store boundaries, and MCP bridge runtime dependency declaration. | Proves source-level boundaries only. |

Executable command references for this ledger are `npm test`, `npm run test:source-boundary`, `node scripts/source-boundary-smoke.mjs`, `node --test scripts/source-boundary-smoke.test.mjs`, and `node --test scripts/verify-verification-evidence.test.mjs`.

## Contract Proof

Contract proof is supplied by the repository scripts and source contracts:

- `package.json` keeps the existing `npm test` Vitest entry point and defines `npm run test:source-boundary` for `node scripts/source-boundary-smoke.mjs`, so the repository can run product tests and source-boundary checks without replacing the current suite.
- `scripts/source-boundary-smoke.mjs` checks the expected source files and rejects unsupported runtime-scope claim phrases in tracked text files.
- `src/types.ts` declares `NormalizedEvent`, `RunOptions`, `BackendCapabilities`, and `Backend`, giving the local verifier a stable source-level contract to inspect.
- `src/backends/claude.ts` implements `makeBackend` against `Backend`, `NormalizedEvent`, and `RunOptions` and exposes MCP capability metadata at the source-contract level.

This proof class is represented by evidence IDs `4eadab69-0625-468d-b8ea-a14ebf4c1f50` and `64f78de1-e31f-425b-ac37-69f3a9ceafb8`.

## Integration Proof

Integration proof is supplied by tracked wiring across the extension, runner, backend, MCP bridge source, and CI workflow:

- `.github/workflows/ci.yml` specifies Node 24 setup, npm caching, `npm ci`, and `npm test` for push, pull request, and manual workflow events.
- `src/extension.ts` wires the VS Code webview and commands to `makeBackend` and posts normalized backend events back to the UI surface.
- `src/runner.ts` delegates `runTurn` to the injected `Backend`, keeping the runner boundary testable without invoking a provider.
- `mcp/muster-ask-server.mjs` declares `MUSTER_RUNTIME_DIR` as an explicit runtime dependency and connects a stdio MCP server in source.

This proof class is represented by evidence ID `1d35583d-5aa1-465b-a82f-b73e845f7b12` plus the tracked source references above. It proves repository integration shape, not remote or live process execution.

## Operational Proof

Operational proof is supplied by local diagnostic commands:

- `node scripts/source-boundary-smoke.mjs` reports numbered source-boundary failures and exits non-zero when required files, JSON structure, CI wiring, or command composition drift.
- `npm test` runs the existing Vitest suite, while `npm run test:source-boundary` runs `node scripts/source-boundary-smoke.mjs`, giving repeatable local commands for test and source-boundary diagnostics.
- `node --test scripts/verify-verification-evidence.test.mjs` checks this ledger for required headings, proof classes, evidence IDs, file references, command references, requirement IDs, limitations, and unsupported claim phrases.

This proof class is represented by evidence ID `19e55c63-33c2-4f7a-850a-d3995078c926`.

## Artifact-Driven UAT Proof

Artifact-driven UAT proof is supplied by local `node:test` fixtures and ledger structure checks:

- `scripts/source-boundary-smoke.test.mjs` creates temporary fixtures that satisfy or violate the source-boundary contract, then verifies pass and failure diagnostics.
- `node --test scripts/source-boundary-smoke.test.mjs` exercises accepted fixtures, package test wiring, CI workflow shape, manual-only CI rejection, compile-only CI rejection, wrong Node setup rejection, malformed JSON reporting, unsupported runtime-scope phrase rejection, and CLI diagnostic formatting.
- `scripts/verify-verification-evidence.test.mjs` provides a second artifact verifier for this evidence ledger so missing proof classes or unbounded claims fail locally.

This proof class is represented by evidence ID `c926e218-ec60-4024-8a7c-fda53d5e8bb1`.

## Requirement Impact

- `R003`: Advanced by source-boundary verification that checks extension/backend/runner/session/type/MCP contracts without needing external services.
- `R005`: Advanced by `npm test`, `npm run test:source-boundary`, `node scripts/source-boundary-smoke.mjs`, and GitHub Actions workflow wiring that make local verification repeatable.
- `R006`: Advanced by negative tests and diagnostic messages that expose contract drift, malformed inputs, and unsupported runtime-scope claims.
- `R007`: Advanced by this redaction and limitation ledger, which keeps evidence claims bounded to tracked files and executable local commands.

## Non-Live Limitations

This ledger makes the following limitations explicit:

- It does not read `.gsd/` artifacts or depend on GSD runtime state.
- It does not inspect hosted services or claim any remote CI job result.
- It does not read runtime session files or inspect persisted user sessions.
- It does not expose local secrets or require environment credentials.
- It does not verify live VS Code activation, live provider subprocess execution, live MCP transport behavior, package publishing, marketplace readiness, or remote workflow execution.

## Redaction Rules

- Record only tracked file paths, local command names, high-level evidence IDs, and bounded proof statements.
- Do not include credential names, token material, raw environment dumps, user prompts, runtime answer payloads, or persisted session payloads.
- If future evidence needs live execution, record the live result in a separate purpose-built artifact with its own verifier and redaction review.

## Failure Modes

| Dependency | Failure Path | Handling Evidence |
|---|---|---|
| Filesystem read of `docs/VERIFICATION-EVIDENCE.md` | Missing file, empty file, or unreadable file prevents ledger inspection. | `scripts/verify-verification-evidence.test.mjs` fails with a clear missing-document assertion or non-empty assertion. |
| Tracked source files cited by this ledger | A cited file is removed or renamed while the ledger still claims coverage. | `scripts/verify-verification-evidence.test.mjs` requires each cited path string, while `scripts/source-boundary-smoke.mjs` checks source-boundary files directly. |
| Local Node runtime | `node --test` cannot run because Node is unavailable or too old for `node:test`. | The command fails before closeout; `.github/workflows/ci.yml` records Node 24 as the intended CI runtime. |
| Source-boundary contract inputs | Malformed JSON, CI drift, missing `test:source-boundary` wiring, or unsupported runtime-scope phrases. | `scripts/source-boundary-smoke.test.mjs` covers these negative fixture paths and expects actionable diagnostics. |

## Load Profile


## Negative Tests

| Negative Scenario | Test Surface | Expected Failure |
|---|---|---|
| Missing or empty evidence ledger | `scripts/verify-verification-evidence.test.mjs` | Fails with a missing-document or non-empty assertion. |
| Missing proof class, evidence ID, command, tracked source file, or requirement ID | `scripts/verify-verification-evidence.test.mjs` | Fails with the specific absent label and value. |
| Unsupported live-runtime, hosted workflow, packaging, release, or secret/session-style claim phrase | `scripts/verify-verification-evidence.test.mjs` | Fails with an unsupported claim assertion. |
| Missing source-boundary script wiring | `scripts/source-boundary-smoke.test.mjs` | Fails with diagnostics for `package.json`, `test:source-boundary` and `node scripts/source-boundary-smoke.mjs`. |
| Manual-only or compile-only CI workflow drift | `scripts/source-boundary-smoke.test.mjs` | Fails with diagnostics naming `.github/workflows/ci.yml` and the missing `npm test` automation contract. |
| Malformed JSON or unsupported runtime-scope source text | `scripts/source-boundary-smoke.test.mjs` | Fails with diagnostics that name the inspected file and violated boundary. |
