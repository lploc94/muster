# Script Workflow Native Host QA Evidence

## Proof boundary

Phase 2 native revalidation is pending. The previous observation predates the canonical `workflow.json` fixture rewrite and is not release evidence for the current implementation.

## Observation

- Verdict: PENDING
- Timestamp: 2026-08-31 rerun attempted; no terminal observation
- Command: `npm run test:script-workflow-native-uat`
- Exit code: unavailable; the packaged VS Code `1.135.0` host blocked while applying the UAT-only live workspace setting before any workflow run was created
- Host: VS Code `1.135.0`, `extension-development-host`
- Evidence artifact: `artifacts/script-workflow-native-qa.json` (generated, redacted, not required to be committed)

## Native scenarios to revalidate

- Workspace catalog shadowed the isolated global catalog.
- A malformed canonical `workflow.json` package produced a bounded diagnostic; list/get responses exposed no absolute path or package body.
- An opaque saved-workflow ref resolves without exposing package provenance, then becomes stale after content changes.
- A global canonical `workflow.json` package was discovered from `~/.muster/workflows/`, and its TypeScript script ran from the package even though the workspace contained a same-named shadow path.
- Modifying a nested global bundle script after definition caused the frozen workflow start to fail without producing a successful artifact.
- With `muster.verification.hostRun=false`, public `start_workflow` returned `host_run_disabled` and did not start the workflow.
- The setting was enabled live without reloading; the same public start then succeeded.
- A two-node Node graph preserved exact stdout, a literal shell-metacharacter argument, numeric exit metadata, and downstream stdin dataflow.
- Producer stderr remained on the turn diagnostic and did not enter artifacts.
- Empty stdout produced a successful artifact whose result was the empty string.
- A declared nonzero failure workflow failed with exactly one turn and no runtime fallback.
- Script nodes created zero ACP session claims, and the workflow graph projected two nodes and one edge.

## Supportive automated evidence to refresh

- `npm run test:script-workflow-qa`: 8 files, 150 tests passed.
- Real Node and Python execution passed locally.
- Timeout, cancellation, stdout cap, stderr tail, live authorization revocation, environment filtering, wrong interpreter, wrong extension, and workspace escape cases passed.
- Public `dispatch → define_workflow → start_workflow → TaskEngine → ScriptBackend` integration passed for ad-hoc workspace scripts and a global package-relative TypeScript script.

## Cleanup and safety

The runner used disposable workspace, home, user-data, database, extracted VSIX, and script files. It restored `muster.verification.hostRun` before exit. Evidence contains only provenance and boolean observations—no tokens, prompts, bodies, task/run IDs, or absolute paths.

## Remaining exploratory boundary

The native runner drives commands programmatically inside VS Code; it does not claim pixel-level or human visual approval of every webview state. The exploratory UI checklist in `docs/qa/script-workflow-qa-plan.md` remains the human usability pass when release sign-off requires visual review.
