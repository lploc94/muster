# Script Workflow Native Host QA Evidence

## Proof boundary

The resource-scoped authorization revision is qualified by a freshly packaged
VSIX run. Exact VS Code 1.135.0 observed the real same-host resource-scoped
setting transition, assembled journey, and exact post-cleanup restoration
described below.

## Observation

- Verdict: PASS
- Timestamp: 2026-09-05T03:10:25.727Z
- Command: `MUSTER_VSCODE_VERSION=1.135.0 npm run test:script-workflow-acceptance`
- Exit code: 0
- Host: VS Code `1.135.0`, `extension-development-host`
- Evidence artifact: `artifacts/script-workflow-native-qa.json` (generated, redacted, not required to be committed)

## Native scenarios observed

- Workspace catalog shadowed the isolated global catalog.
- A malformed canonical `workflow.json` package produced a bounded diagnostic; list/get responses exposed no absolute path or package body.
- An opaque saved-workflow ref resolves without exposing package provenance, then becomes stale after content changes.
- A global canonical `workflow.json` package was discovered from `~/.muster/workflows/`, and its TypeScript script ran from the package even though the workspace contained a same-named shadow path.
- Modifying a nested global bundle script after definition caused the frozen workflow start to fail without producing a successful artifact.
- With `muster.verification.hostRun=false`, public `start_workflow` returned `host_run_disabled` and did not start the workflow.
- The same workspace-folder setting is enabled live without reloading, and the same public start then succeeds.
- A two-node Node graph preserved exact stdout, a literal shell-metacharacter argument, numeric exit metadata, and downstream stdin dataflow.
- Producer stderr remained on the turn diagnostic and did not enter artifacts.
- Empty stdout produced a successful artifact whose result was the empty string.
- The same numeric nonzero code followed declared PREV in one workflow and declared FAIL in another; empty PREV stdout received deterministic host feedback.
- A decision correction remained on the same logical activation, exposed attempt 2 of 3 without a hidden graph node, and survived reload.
- Two named terminal outputs completed, and a downstream workflow consumed the selected exact output after reload.
- Script nodes created zero ACP session claims, and the workflow graph projected two nodes and one edge.
- Cleanup restores the exact captured `workspaceFolderValue` on the same resource, including `undefined` as absence of an override, and a post-cleanup re-inspection emits only `workspaceFolderValueRestored: true`.

## Supportive automated evidence

- `npm run test:script-workflow-qa`: 8 files, 158 tests passed.
- Real Node and Python execution passed locally.
- Timeout, cancellation, stdout cap, stderr tail, live authorization revocation, environment filtering, wrong interpreter, wrong extension, and workspace escape cases passed.
- Public `dispatch → define_workflow → start_workflow → TaskEngine → ScriptBackend` integration passed for ad-hoc workspace scripts and a global package-relative TypeScript script.
- Opposite effective values in two cwd resources were exercised in both call orders; only each task's own resource authorized host verification, and a throwing resource lookup failed closed.

## Cleanup and safety

The runner used disposable workspace, home, user-data, database, extracted VSIX, and script files. Before emitting PASS it restored `muster.verification.hostRun` to the exact captured workspace-folder value and re-inspected the same resource; the redacted observation recorded `workspaceFolderValueRestored: true`, including `undefined` as absence of an override. Evidence contains only provenance and boolean observations—no setting values, tokens, prompts, bodies, task/run IDs, or absolute paths.

## Remaining exploratory boundary

The native runner drives commands programmatically inside VS Code; it does not claim pixel-level or human visual approval of every webview state. The exploratory UI checklist in `docs/qa/script-workflow-qa-plan.md` remains the human usability pass when release sign-off requires visual review.
