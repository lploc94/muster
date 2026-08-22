# QA Report — muster M026 (script workflow)

- Date: 2026-08-22
- Branch: `main`
- Tier: Exhaustive (critical → cosmetic)
- Surface: VS Code Extension Development Host, Muster webview panel
- Fixture workspace: disposable, `tmp/qa-m026/` (gitignored)
- Health score: **7.5 → 9.0**

## Verdict

Ship-ready. M026 script execution, dataflow, policy gating, and the saved-workflow
catalog all behave correctly under live user-path testing. Two defects were found and
fixed; both are committed with verification. Two lower-severity observations are recorded
without code changes and explained below.

## Defects found and fixed

### BUG-01 — VSIX packaged 304 MB of local state, breaking the release gate (High, fixed)

`.vscodeignore` had no entry for `tmp/`, `artifacts/`, `.gstack/`, or `.ctxe/`. The packaging
step swept the whole local state tree into the extension:

```
├─ .ctxe/      (1 file)
├─ .gstack/    (5 files)   [54.38 KB]
├─ artifacts/  (11 files)  [973.7 KB]
└─ tmp/        (4536 files) [304.8 MB]
```

Two consequences. Local caches, QA fixtures, and agent state would ship to users. And the
acceptance gate itself failed, because secretlint tried to scan a live Chromium cookie
journal inside the fixture tree:

```
ERROR  Error occurred while scanning secrets (files):
Error: EBUSY: resource busy or locked,
open 'tmp\qa-m026\user-data\Network\Cookies-journal'
```

Fix: added `tmp/**`, `artifacts/**`, `.gstack/**`, `.ctxe/**`, `.muster/**` to `.vscodeignore`.

Verification: `npm run test:script-workflow-acceptance` went from EBUSY failure to
`[script-workflow-native-host] PASS vscode=1.134.0 catalog=5 policy=2 runtime=8`, exit 0.

Commit `dadac6d`.

### BUG-02 — terminally failed runs reported live nodes with no diagnostic (Medium, fixed)

Running the `fail_run` edge case produced a run that was `failed` while its nodes still
claimed to be live:

```
runRef wfr_25259035fde6ef87dc4be11b   status failed   reason agent_fail
fail      active
consumer  pending
diagnostics: []
```

Root cause: `planWorkflowRecursiveClosure` (`src/task/repository.ts`) closes dependency
gates, feedback rounds, activations, continuations, return gates, `workflow_runs`, tasks,
and turns — but never `workflow_nodes.status`. That is deliberate: node rows carry reuse
provenance guarded by `trg_workflow_node_reuse_immutable`, and the graph projection already
derives the correct display state (`run_closed_before_activation`) from `runStatus`.

The real gap was in `inspectWorkflowRun`, the MCP-facing projection. It has a five-member
`terminal_run_has_live_*` diagnostic family (gate, round, activation, continuation, return
gate) with no member for nodes — so a coordinator reading the run state sees `active` /
`pending` nodes on a terminal run and cannot tell they will never progress.

Fix: added the missing family member.

```ts
if (
  terminal
  && nodeRows.some((node) => node.status === 'pending' || node.status === 'active')
) {
  diagnostics.push({ code: 'terminal_run_has_live_node' });
}
```

Verification: regression assertion added at the existing terminal-failure site in
`src/task/m018-s07-workflow-status-projection.test.ts`. Test failed before the fix
(`expected undefined to be 'failed'` once the fixture owner root was bound), passes after.

Commit `c01032d`.

## Observations (no code change)

### OBS-01 — six distinct constraint violations share one opaque message (Low)

Every malformed script node returns the same bare string:

| Attempt | Response |
|---|---|
| `interpreter: bash` | `invalid define_workflow arguments` |
| `interpreter: powershell` | `invalid define_workflow arguments` |
| `../escape.js` | `invalid define_workflow arguments` |
| absolute path | `invalid define_workflow arguments` |
| `scripts/producer.txt` | `invalid define_workflow arguments` |
| `scripts/does-not-exist.js` | `invalid define_workflow arguments` |

Traversal, absolute path, wrong extension, nonexistence, and interpreter allowlist are
indistinguishable from the response. Not filed as a bug: this matches the established
convention in `coordinator-tools.ts` (`invalid_arguments`, `invalid start_workflow inputs`),
and the `forbiddenLeak` assertions deliberately ban field paths and path fragments from
diagnostics. Naming the failing constraint would need a leak-safe error vocabulary, which is
a design decision, not a defect.

Security posture is correct regardless: all six were refused at definition time, so no
`workflowRef` was created and no process could be spawned.

### OBS-02 — `fail_run` does not surface the script exit code (Low)

`on_nonzero: continue` preserves the exit code downstream:

```
received:{"stdin":{"value":"alpha:literal;$(not-expanded)\n","kind":"next_result","exitCode":7}}
```

`on_nonzero: fail_run` surfaces only `reason: agent_fail`. The script's exit code 9 appears
nowhere in the run state, because the failure path produces no result envelope to carry it.
The asymmetry is consistent with the M026 plan (EXE-04 requires continue to preserve the
code; EXE-05 only requires fail_run to fail once without retry), so this is a design
boundary, not a regression.

## Passing scenarios

Catalog and policy:

- Saved workflow `review` discoverable at workspace scope; sibling `invalid.md` produced a
  bounded `invalid_workflow_file` diagnostic without blocking the catalog (CAT-01, CAT-04)
- `muster.verification.hostRun=false` → `host_run_disabled`, refused at acceptance, no task
  or process materialized (SEC-01)
- Same setting flipped to `true` with no window reload → same saved definition started and
  ran; no redefinition needed (SEC-01, SEC-02)
- Stale opaque ref: `pwf_eb2a747419661a7706fc0ab59cb2695e` rejected with
  `predefined workflow not found or changed` after the file changed; re-listing returned a
  different, live ref `pwf_78fdaab7a44c26e64f1d1f2f7c003d43` (CAT-05)

Execution and dataflow:

- Two-node mixed graph `producer --[stdin]--> consumer` ran to `succeeded`, both nodes
  terminal, no diagnostics (CMP-01, EXE-01)
- Literal argv survived with no shell involvement: `literal;$(not-expanded)` arrived intact
  as `process.argv[2]` — the `;` did not split, `$(…)` did not expand (SEC-04)
- Nonzero `continue` preserved `exitCode: 7` in the downstream envelope while the node
  stayed `succeeded` (EXE-04)
- Producer stderr `M026_DIAGNOSTIC_ONLY` never entered the consumer artifact or run result
  (EXE-06)
- Empty stdout was not dropped or replaced: `{"stdin":{"value":"","kind":"next_result","exitCode":0}}` (EXE-03)
- `fail_run` failed the run exactly once, `consumer` never activated, no automatic retry or
  runtime fallback (EXE-05)
- Interpreter allowlist and path containment failed closed on all six attempts (SEC-03)

UI:

- Workflow graph view rendered both script nodes as Completed at 100%, `NODES — 2`, no
  reused nodes or edges (DUR-02)
- Narrow panel (299 px): document `scrollWidth` equals viewport width; the one wide `CODE`
  element is contained by a scrollable `PRE` (`scrollWidth 508 / clientWidth 271`) rather
  than breaking layout

## Contract note surfaced by testing

Script nodes do not receive raw upstream stdout on stdin. They receive a JSON envelope keyed
by the edge's `as` name:

```json
{"stdin":{"value":"alpha:literal;$(not-expanded)\n","kind":"next_result","exitCode":7}}
```

This is intended (`src/task/engine.ts:4607` builds it via `JSON.stringify`), not a defect,
but any real consumer script must parse JSON and read `.stdin.value` rather than treating
stdin as the upstream's bytes. Worth stating in user-facing docs.

## Verification summary

| Gate | Result |
|---|---|
| `npm run test:script-workflow-acceptance` | PASS, exit 0 — `vscode=1.134.0 catalog=5 policy=2 runtime=8` |
| `npm test` (full repo) | 225 files, 2734 passed, 4 skipped |
| Targeted workflow/script regression (8 files) | 69 passed |

## Commits

| Commit | Change |
|---|---|
| `c01032d` | fix(workflow): diagnose terminal runs that still hold live nodes |
| `dadac6d` | fix(package): exclude local state trees from the VSIX |
