# Script Workflow Native Host QA Evidence

## Proof boundary

PASS below comes from a freshly compiled and packaged VSIX running inside an actual VS Code Extension Development Host. Vitest results support the detailed negative cases but are not substituted for this native observation.

## Observation

- Verdict: PASS
- Timestamp: 2026-08-28T05:27:47.860Z
- Command: `npm run test:script-workflow-native-uat`
- Exit code: 0
- Host: VS Code `1.135.0`, `extension-development-host`
- Evidence artifact: `artifacts/script-workflow-native-qa.json` (generated, redacted, not required to be committed)

## Native scenarios observed

- Workspace catalog shadowed the isolated global catalog.
- Invalid Markdown produced a bounded diagnostic; list/get responses exposed no absolute path.
- An opaque saved-workflow ref resolved with explicit `user-authored-untrusted` provenance, then became stale after content changed.
- A global directory bundle was discovered from canonical `~/.muster/workflows/`, and its TypeScript script ran from the bundle even though the workspace contained a same-named shadow path.
- Modifying a nested global bundle script after definition caused the frozen workflow start to fail without producing a successful artifact.
- With `muster.verification.hostRun=false`, public `start_workflow` returned `host_run_disabled` and did not start the workflow.
- The setting was enabled live without reloading; the same public start then succeeded.
- A two-node Node graph preserved exact stdout, a literal shell-metacharacter argument, nonzero exit metadata under `continue`, and downstream stdin dataflow.
- Producer stderr remained on the turn diagnostic and did not enter artifacts.
- Empty stdout produced a successful artifact whose result was the empty string.
- A nonzero `fail_run` workflow failed with exactly one turn and no runtime fallback.
- Script nodes created zero ACP session claims, and the workflow graph projected two nodes and one edge.

## Supportive automated evidence

- `npm run test:script-workflow-qa`: 8 files, 139 tests passed.
- Real Node and Python execution passed locally.
- Timeout, cancellation, stdout cap, stderr tail, live authorization revocation, environment filtering, wrong interpreter, wrong extension, and workspace escape cases passed.
- Public `dispatch → define_workflow → start_workflow → TaskEngine → ScriptBackend` integration passed for ad-hoc workspace scripts and a global package-relative TypeScript script.

## Cleanup and safety

The runner used disposable workspace, home, user-data, database, extracted VSIX, and script files. It restored `muster.verification.hostRun` before exit. Evidence contains only provenance and boolean observations—no tokens, prompts, bodies, task/run IDs, or absolute paths.

## Remaining exploratory boundary

The native runner drives commands programmatically inside VS Code; it does not claim pixel-level or human visual approval of every webview state. The exploratory UI checklist in `docs/qa/script-workflow-qa-plan.md` remains the human usability pass when release sign-off requires visual review.
