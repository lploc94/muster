# M024 S06 Native Host Workflow Graph Evidence

## Proof Boundary

A PASS requires an actual packaged VS Code Extension Development Host to send `requestWorkflowGraph` for a focused workflow task and observe the correlated `workflowGraphResult`. A generic native SQLite host smoke is not graph evidence.

## Observation

- Verdict: ENVIRONMENT BLOCKED
- Timestamp: 2026-08-02T04:06:26Z
- Observation: The packaged Extension Development Host started, discovered and activated Muster, initialized the SQLite registry, and completed its packaged SQLite smoke successfully. The only available native runner is structurally limited to packaged SQLite storage checks; it does not exercise `requestWorkflowGraph`, `workflowGraphResult`, the focused workflow fixture, or the graph panel.
- Constraint: This is a deterministic structural limitation of the native runner, not an inference from a local test result. There is no graph-specific native host entry point in `scripts/sqlite-extension-host-smoke.ts`, so this task cannot produce a graph-specific native PASS without adding a new native graph harness.

## Objective Command Evidence

- Command: `npm run test:sqlite-extension-host`
- Exit code: 0
- Native-host observation: the packaged Extension Development Host completed after the schema-v3 baseline correction and logged the bounded SQLite storage/reclaim result.
- Identifier inspection: `scripts/sqlite-extension-host-smoke.ts` does not contain `requestWorkflowGraph` or `workflowGraphResult`; its exercised interfaces are `DbClient`, packaged SQLite schema, storage reclaim, and backup.
- Evidence reference: `gsd_exec 53e1d35b-24b1-40d2-97a8-51100849e9eb` captures the passing native-host result; `gsd_exec 82819520-e961-46c0-9e03-6ecdd7232d49` captures the identifier search with exit code 1.

## Why Supportive Evidence Is Not Substituted

The S05 Vite, mocked webview, and Playwright coverage exercises browser-side rendering and route contracts only. It cannot replace a native Extension Development Host observation or establish native PASS because it neither launches the packaged extension nor observes this graph request/result path in VS Code.

## Failure Modes

The native runner can fail before useful graph evidence when packaging, VS Code startup, extension activation, or its SQLite assertions fail. This observation preserves the command exit code and bounded native-host state without copying raw stderr, prompts, task data, or machine paths. A graph-specific native harness must surface request correlation, focus validation, unavailable/not-in-workflow results, and cleanup as bounded assertions.

## Load Profile

This evidence task has no runtime load surface: it performs one disposable packaged-host launch. The future graph harness should keep one bounded fixture graph and one request/result exchange so startup and host timeouts, rather than graph cardinality, remain the first constrained resource.

## Negative Tests

- `src/host/workflow-graph-route.test.ts` rejects empty and non-focused requests without graph reads, maps repository failure to bounded `unavailable`, and rejects focus-generation races.
- `src/task/m024-s05-webview-surface-invariant.test.ts` prevents graph request/result identifiers and topology reads from reaching the MCP agent surface.
- `scripts/verify-m024-s06-native-host-evidence.test.mjs` rejects a generic green SQLite-host claim that lacks graph identifiers and asserts that the native smoke has no graph probe.
