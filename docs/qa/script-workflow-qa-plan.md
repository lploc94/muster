# Script Workflow and Saved Workflow QA Plan

## Scope and proof boundary

This plan verifies the independently implemented script executor, script workflow dataflow, semantic workflow compiler, and canonical `workflow.json` saved-package catalog. It does not treat a green unit test as proof of live Extension Host behavior. Native PASS requires `npm run test:script-workflow-native-uat`, which packages a fresh VSIX and runs the scenarios inside an actual VS Code Extension Development Host.

The five ACP backends remain a regression surface. No test may silently widen `BACKEND_IDS` with `script`, create an ACP session for a script node, inherit arbitrary host secrets, or route script stderr into workflow artifacts.

## Requirement-to-evidence matrix

| ID | Requirement | Automated evidence | Native/manual evidence |
|---|---|---|---|
| CAT-01 | Discover strict canonical `workflow.json` packages | `src/host/predefined-workflows.test.ts` | Native catalog scan |
| CAT-02 | Workspace name shadows global name deterministically | Catalog unit test | `workspaceShadowsGlobal` |
| CAT-03 | List/get return bounded metadata/ref only; host freezes the package | Catalog and public-path integration tests | `opaqueRefResolved`, `pathsRedacted` |
| CAT-04 | Invalid manifests, assets, and duplicate packages are bounded diagnostics | Catalog unit test | `invalidFileDiagnosed` |
| CAT-05 | Content changes invalidate opaque refs | Catalog unit test | `staleRefRejected` |
| CAT-06 | Canonical packages expose bundle kind and authoritative manifest metadata | Catalog and global-package integration tests | `globalBundleExecuted` |
| CAT-07 | Manifest and nested asset changes invalidate the package ref without exposing paths | Catalog and runtime integration tests | `packageIntegrityRejected` |
| CMP-01 | `define_workflow` accepts agent/script mixed graphs | `src/task/coordinator-tools.test.ts` | Two-node native script graph |
| CMP-02 | Node shape is strict XOR; invalid path/interpreter/extension fails early | Coordinator and workflow-codec tests | Native definition uses only public shape |
| EXE-01 | Real Node execution uses argv/stdin without a shell | `src/backends/script.test.ts` | Native two-process graph |
| EXE-02 | Real Python uses the same typed contract when installed | Conditional real-Python backend test | Record local result in the run log |
| EXE-07 | A global bundle script resolves from its package root while process cwd remains the active workspace | Script backend and public-path integration tests | `globalBundleExecuted` |
| EXE-03 | stdout is exact, including newline, empty output, and literal metacharacters | Backend and workflow integration tests | `exactStdoutPreserved`, `emptyStdoutSucceeded` |
| EXE-04 | Nonzero `continue` preserves exit code downstream | Workflow integration test | `continueExitMetadataPreserved` |
| EXE-05 | Nonzero `fail_run` fails once without retry/fallback | Workflow integration test | `failRunFailedOnce` |
| EXE-06 | stderr is bounded diagnostic only and never an artifact | Backend and workflow tests | `stderrDiagnosticOnly` |
| SEC-01 | Workspace trust and live `muster.verification.hostRun` authorize execution | Host-policy and public-path tests | disabled reject followed by enabled accept |
| SEC-02 | Authorization is rechecked after durable dispatch boundary | Backend revocation test | Supported by native live setting path |
| SEC-03 | Interpreter allowlist, path containment, file type, and extension fail closed | Backend/compiler/codec tests | Native scripts are workspace-relative |
| SEC-04 | No shell expansion and arbitrary host secrets are not inherited | Literal argv and environment tests | Native literal metacharacter survives stdout |
| SEC-05 | Timeout, cancellation, stdout cap, and stderr tail are bounded | Backend tests | Native run remains bounded |
| DUR-01 | Descriptor, result, stderr diagnostic, and exit metadata persist without schema bump | Workflow codec, repository, and workflow integration tests | Native SQLite-backed engine run |
| DUR-02 | Script nodes do not create ACP sessions; graph projection remains available | Registry/runtime/graph tests | `noAcpSessionClaims`, `graphProjected` |
| REG-01 | Five ACP adapters retain their closed inventory and typed agent path | Registry, routing, and full suite | Fresh packaged extension activation |

## Commands

Fast feature QA:

```powershell
npm run test:script-workflow-qa
```

Native packaged-host UAT:

```powershell
npm run test:script-workflow-native-uat
```

Complete acceptance gate:

```powershell
npm run test:script-workflow-acceptance
```

Full repository regression remains mandatory before release:

```powershell
npm test
npm run compile
npm run test:source-boundary
```

## Exploratory UI checklist

Use a disposable trusted workspace and restore the setting afterward.

1. Create `.muster/workflows/review/` with a strict `workflow.json` and any referenced `prompts/` or `scripts/` assets. Create one malformed package beside it.
2. Launch `Run Extension` from `.vscode/launch.json`, open Muster, and ask a coordinator to use the saved package. Confirm the valid package is discoverable and the malformed package does not block the catalog.
3. Add a global package under `~/.muster/workflows/review-bundle/` with `workflow.json` and `scripts/node_1.ts`; add a same-named `scripts/node_1.ts` in the workspace with a different marker. Confirm the package is listed as `packageKind=bundle` and the global marker runs.
4. Keep `muster.verification.hostRun=false`. Ask the coordinator to start a workflow containing a Node script. Confirm start is rejected with `host_run_disabled` and no child task/process appears.
5. Set `muster.verification.hostRun=true` without reloading. Start the same workflow again. Confirm the graph contains script nodes, the bundle script runs from the package root, and `process.cwd()` remains the active workspace.
6. Exercise declared execute zero/nonzero outcomes, empty stdout, and failure. Confirm newline/empty results are not replaced with assistant prose, declared routing controls the outcome, and operational failures create no unsafe fallback.
7. Modify `workflow.json`, a referenced prompt, or any nested package file after listing/definition. Confirm the old opaque ref is rejected and a frozen definition cannot execute the changed package.
8. Attempt `../escape.js`, an absolute path, a wrong extension, a symlink, and a non-allowlisted interpreter. Confirm none spawn.
9. Restore `muster.verification.hostRun` to its original value and delete the disposable scripts/catalog files.

Do not record bearer tokens, absolute user paths, workflow bodies, task IDs, run IDs, or database paths in committed evidence.
