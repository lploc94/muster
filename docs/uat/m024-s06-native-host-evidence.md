# M024 S06 Native Host Workflow Graph Evidence

## Proof Boundary

A PASS requires an actual packaged VS Code Extension Development Host to receive a real webview-initiated `requestWorkflowGraph` for a focused workflow task and emit the correlated `workflowGraphResult` through the production host post path. A generic native SQLite host smoke is supportive only, never graph evidence.

## Observation

- Verdict: PASS
- Timestamp: 2026-08-02T06:44:59Z
- Native command: `npm run test:m024-s06-workflow-graph-live-uat`
- Exit code: 0
- Provenance: VS Code `1.131.0`; packaged `extension-development-host`; `live-extension-host-transport` probe source.
- Correlated round trip: the live webview focused the seeded workflow task, opened the real on-demand graph modal through the UAT-gated trigger, sent `requestWorkflowGraph`, and the host emitted a matching `workflowGraphResult`.
- Bounded graph observation: 5 nodes, 4 edges, 4 reused nodes, 4 reused edges; host reuse counters agree with wire reuse flags; statuses were `active` and `reused`; no diagnostics, child runs, or feedback rounds.
- Fixture observation: one live consumer node and four reused ancestor-closure nodes. Runtime task IDs, run IDs, request IDs, prompts, artifact bodies, and absolute paths are excluded from committed evidence.

## Objective Command Evidence

- `npm run test:m024-s06-workflow-graph-live-uat` completed its packaged VSIX launch with host exit code 0 and emitted PASS evidence. Its in-host entry is `scripts/m024-s06-workflow-graph-host.ts`; runner is `scripts/run-m024-s06-workflow-graph-uat.mjs`.
- The evidence assembly (`scripts/m024-s06-workflow-graph-evidence-assembly.mjs`) fails closed: it requires matching task/request correlation, real Extension Development Host provenance, `ok: true`, the 5-node/4-reuse fixture shape, and machine-enforced identifier redaction before it can produce PASS.
- `npm run test:sqlite-extension-host` remains a passing supportive packaged-host check. `scripts/sqlite-extension-host-smoke.ts` does not contain `requestWorkflowGraph` or `workflowGraphResult`; it intentionally lacks a graph probe and cannot establish this PASS.

## Why Supportive Evidence Is Not Substituted

The S05 Vite, mocked webview, and Playwright coverage exercises browser-side rendering and route contracts. It cannot replace the live packaged Extension Development Host round trip or establish native PASS because it does not observe this graph request/result path within VS Code.

## Failure Modes

- The graph runner fails closed if VSIX packaging, VS Code startup, extension activation, webview hydration, fixture seeding, focus/modal wiring, request correlation, or graph projection fails.
- The fixture initially exposed two real defects: a producer node ID that did not match the reused consumer node, and a `startWorkflowRun` result that omitted a reuse-boundary consumer task from `affectedTaskIds`, leaving it outside the projection. The second defect is now regression-tested in `src/task/m024-s03-mid-tree-reuse-durable.test.ts`.
- Windows may temporarily retain an Electron handle during temp-directory cleanup. Cleanup is best-effort only after evidence is atomically written, so it cannot convert a proven native PASS into a failure.
- Negative `invalidRequest`, non-focused, focus-generation-race, and `notInWorkflow` route behavior remain owned by deterministic route tests; the native probe proves the production focus and transport seam without synthesizing a request.

## Load Profile

One disposable packaged-host launch seeds one bounded 5-node graph and observes one request/result exchange. Startup and host timeouts, not graph cardinality, remain the primary constrained resource.

## Negative Tests

- `src/host/workflow-graph-probe.test.ts` rejects forged, malformed, uncorrelated, and late request/result pairs; it also covers timeout and disposal behavior.
- `src/host/workflow-graph-route.test.ts` rejects empty and non-focused requests without graph reads, maps repository failure to bounded `unavailable`, and rejects focus-generation races.
- `src/task/m024-s05-webview-surface-invariant.test.ts` keeps graph request/result identifiers and topology reads out of the MCP agent surface.
- `scripts/m024-s06-workflow-graph-evidence-assembly.test.mjs` rejects a generic green host result, mismatched correlation, bad graph/reuse shape, malformed diagnostics, and runtime-identifier leaks.
- `scripts/verify-m024-s06-native-host-evidence.test.mjs` rejects generic SQLite-only PASS claims, requires the graph-specific host and runner, and asserts that the SQLite smoke remains graph-free.
