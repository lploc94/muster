# Workflow Definition and Outcome Routing Refactor Plan

## Target
Refactor Muster's existing workflow definition, package, persistence, and routing implementation in place so its one canonical behavior exactly matches `docs/plans/workflow-definition-v2-design.md`: strict `muster.workflow/v2` manifests, named semantic composition, durable outcome routing and decision repair, and zero/nonzero execute routing, with intentional breaking changes and no parallel legacy model.

## Source Of Truth
- Plan schema: `loop-plan/v1`
- Request/report: `docs/plans/workflow-definition-v2-design.md`, plus the explicit user decision to refactor the current implementation directly into the design's final behavior: no parallel versioned architecture, no migration or backward compatibility, no new bundled-workflow scope, and no work without a concrete design outcome.
- Baseline commit: `bd2590c`
- Plan path: `docs/plans/workflow-definition-outcome-routing-implementation.md`

## Current State
- Completed: Commit `bd2590c` adds the authoritative design; the repository already has durable frozen workflow definitions/runs, dependency gates, immutable artifacts, direct-producer PREV feedback rounds, NEXT/PREV/FAIL disposition claims, script execution, continuation/reload handling, bounded status/graph projections, a global/workspace workflow catalog, and SQLite schema fingerprint/reset infrastructure.
- Remaining: No production closed manifest decoder, `workflow.json` package loader, named semantic output authority, exact prior-output resolution, outcome contract enforcement, activation-owned three-attempt decision repair, or manifest-driven nonzero PREV/FAIL mapping exists. Public tools and package fixtures still compile the current `label`/edge `as`/entry-coordinate/`onFailure` contract.
- Worktree: Clean before this plan was generated; while planning, the only intended worktree change is this plan document. Preserve any later unrelated user changes.

## Codebase Evidence
- Current flow: `src/bridge/server.ts (define_workflow/start_workflow/invoke_child_workflow and disposition schemas) -> src/task/coordinator-tools.ts:parseSemanticWorkflowDefinition/parseSemanticWorkflowInputs/tool command parsing -> src/task/workflow.ts:validateDefineWorkflow/validateStartWorkflow -> src/task/engine-graph.ts:bindPredefinedWorkflowScripts/freezeWorkflowDefinitionRouting/prepareWorkflowStart/executeToolCommand -> src/task/repository.ts:defineWorkflowVersion/startWorkflowRun/settleTurnAndApplyEffects -> src/task/sqlite/schema.ts authority tables -> src/task/engine.ts reload, execution, implicit NEXT, and post-commit scheduling`.
- Existing tests: `src/task/workflow.test.ts`, `src/task/coordinator-tools.test.ts`, and `src/bridge/server.test.ts` prove the current closed boundary; `src/host/predefined-workflows.test.ts` proves Markdown catalog containment/digest/stale-ref behavior; `src/task/repository.test.ts` and `src/task/m024-s02-*.test.ts`/`m024-s03-*.test.ts` prove atomic start and durable artifact reuse; the M018 workflow suites prove routing, feedback, reload, continuation, and disposition-claim races; `src/task/script-workflow.test.ts` proves current `onFailure` routing; graph/status and SQLite suites prove bounded projections and reset-only schema ownership.
- Pattern to follow: `src/task/workflow-codec.ts:decodeDefineWorkflowInput/fingerprintWorkflowDefinition` for fail-closed normalized domain input; `src/host/predefined-workflows.ts:resolvePredefinedWorkflowSource/resolvePredefinedWorkflowScript` for bounded package provenance; `src/task/repository.ts:defineWorkflowVersion/startWorkflowRun/settleTurnAndApplyEffects` for named worker-owned atomic commands; `src/task/disposition-claim.ts` and `turn_disposition_claims` for first-valid-wins concurrency; `src/task/sqlite/schema-fingerprint.ts:findSchemaFingerprintFailure` plus `src/task/sqlite/reset.ts:bootstrapCurrentSchema` for a clean schema break.
- Pattern fallback: None.
- Verified gap: The indexed source contains version-suffixed workflow definition types, Markdown package compilation, run-level prior-result reuse, implicit NEXT or script `onFailure`, and no durable decision-repair record. The target requires one strict canonical semantic definition, `workflow.json` authority, public named interfaces, exact named terminal artifacts, declared outcome authorization, durable repair attempts, and deterministic execute routing while preserving the existing physical engine mechanics.

## Scope
- In scope: Refactor the existing public/domain/package contract directly; load canonical `workflow.json` bundles from the existing global/workspace catalog roots; freeze inline/file instructions and script provenance; persist normalized semantic interfaces/outcomes; resolve named prior outputs atomically; render and enforce agent outcomes; add activation-owned bounded decision repair; map execute zero/nonzero outcomes to existing dispositions; expose bounded repair/decision state in run graph UI; bump the reset-only SQLite schema; rewrite fixtures/UAT/docs for the canonical contract.
- Out of scope: A parallel old/new workflow model; definition/data migration or old fingerprint compatibility; legacy flat/bundle Markdown topology compilation; bundled/default workflow scope or shipped example packages; visual workflow authoring; semantic-kind registries/subtyping/converters; payload JSON Schemas; runtime graph mutation, fan-out, cycles, conditional/ANY/quorum joins; exact exit-code tables, signals, or stdout predicates; hidden decision nodes/executors; new package trust UI; catalog display of full interfaces or prompt bodies; speculative abstractions or future-proofing not required by the design.

## Invariants
- The refactored workflow definition is the sole authoring/semantic layer on the existing durable engine; dependency gates, artifacts, feedback rounds, continuations, and NEXT/PREV/FAIL settlement remain repository-owned.
- Authors never supply durable IDs, physical gate state, backend/model/role/capabilities, effective host policy, artifact coordinates, revisions, or routing destinations duplicated from topology.
- Top-level starts and nested `invoke_child_workflow` bind destination inputs only by the child definition's public input names; internal child node/inputRef coordinates are resolved atomically from frozen authority.
- Every persisted definition and start is normalized, bounded, deterministic, fail-closed, and idempotent; package asset bytes and effective host routing are frozen before definition commit. No adapter may translate between parallel legacy and canonical models.
- Semantic kinds compare by exact string equality while transport kinds remain `workflow_input` and `next_result`.
- Exact source/destination semantic-kind equality applies when both sides have declared contracts, especially named prior-run outputs. A nested child `fromInput` has only current-activation value/provenance authority, so it is adapted to the declared child input semantic kind rather than inventing an internal-edge semantic kind.
- Prior-run output selection, authorization, exact artifact/revision pinning, adaptation, and destination gate fill happen in one repository transaction.
- A valid disposition accepted first remains authoritative; invalid/missing decision repair cannot reopen a routed activation or create duplicate turns after replay/reload.
- PREV targets only declared direct inbound `inputRef` values and always carries bounded nonempty feedback; missing disposition never implies PREV.
- An agent node may omit `outcome` and retain final-assistant-message implicit NEXT; when an agent outcome is present, `requireExplicitDisposition` is mandatory and controls only missing-disposition behavior.
- `requireExplicitDisposition: false` preserves final-assistant-message implicit NEXT only on the original activation attempt with no invalid evidence and no open repair. Once an invalid disposition opens repair, every correction turn must select a valid route or advance toward exhaustion.
- Script operational failures remain operational failures; only an actual numeric nonzero exit may follow a declared PREV or FAIL mapping, and stderr remains diagnostic-only.
- Prompts, script contents, host paths, credentials, raw artifact bodies, physical IDs, and unbounded diagnostics never leak through MCP, catalog, status, graph, or webview projections.
- The schema cutover is reset-only: old schema markers fail closed and require explicit developer/user reset; implementation must not add an automatic migration or reinterpret superseded rows.

## Global Gates
| Gate | Command | Expected result |
|---|---|---|
| Types | `npx tsc -p . --noEmit` | Pass |
| Static/UI checks | `npm run check:svelte` | Pass with 0 errors and 0 warnings |
| Build | `npm run compile` | Pass |
| Full tests | `npm test && npm run test:webview` | All Vitest and Playwright tests pass |
| Source boundaries/fixtures | `npm run test:source-boundary && npm run test:source-boundary:fixtures` | Pass; named repository-command and source-boundary invariants remain intact |

## Execution Rules
- Execute phases in order unless a phase explicitly declares no dependency.
- For each phase: revalidate the cited code evidence, write or update contract tests first, confirm the intended failure when feasible, evaluate whether the tests reject naive shortcuts, implement the full behavioral contract using project patterns, run focused tests, run all phase gates, review the uncommitted diff, fix findings, and commit.
- Green tests alone do not complete a phase. The production diff must satisfy every implementation obligation and invariant for the full described input/state class.
- Never commit with failing gates or an unapproved implementation review.
- Preserve unrelated user changes; never reset or revert them.
- Mark a phase complete in this plan in the same commit as that phase's implementation.
- Continue automatically to the next incomplete phase. Stop only for a destructive/irreversible decision, missing credentials/infrastructure, irreconcilable requirements, or repeated failures with no new evidence.

## Plan Review
- Status: APPROVE
- Rounds: 3
- Open issues: None — Codex issues 1-5 were fixed and re-verified against the current plan.

## Phase 1: Refactor the Canonical Workflow Definition Contract
- Status: complete
- Depends on: None
- Goal: Refactor the existing workflow types, codecs, validation, and public tools in place into one strict normalized semantic definition whose external schema literal is `muster.workflow/v2`.
- Current behavior: `parseSemanticWorkflowDefinition` builds the version-suffixed `WorkflowDefinitionV1` from public nodes containing overloaded `label`, edges containing `as`, and coordinate-like entry inputs; `workflow-codec.ts` validates/fingerprints only `one_node_v1 | graph_v1`, and bridge schemas advertise that superseded shape.
- Code evidence: `src/task/workflow-types.ts:WorkflowNodeSpecV1/WorkflowDependencyEdgeV1/WorkflowPolicyV1/WorkflowDefinitionV1`; `src/task/workflow-codec.ts:decodeNode/decodeGraphTopology/decodeEntryContracts/decodeDefineWorkflowInput/fingerprintWorkflowDefinition`; `src/task/workflow.ts:validateDefineWorkflow/workflowNodeTaskGoal`; `src/task/brief.ts` prompt compilation; `src/task/coordinator-tools.ts:parseSemanticWorkflowDefinition`; `src/bridge/server.ts` define/start/child schemas and `projectPublicToolResult`; tests in `src/task/workflow.test.ts`, `src/task/brief.test.ts`, `src/task/workflow-shell-materialization.test.ts`, `src/task/coordinator-tools.test.ts`, and `src/bridge/server.test.ts`.
- Pattern to follow: The existing closed decoder and stable fingerprint boundary in `src/task/workflow-codec.ts`, upgraded in place rather than wrapped by a second parser.
- Behavioral contract:
  - Accept only schema `muster.workflow/v2` with bounded `name`, optional `description`, named semantic `inputs`/`outputs`, nodes, edges, and closed nested instruction/outcome shapes; reject every unknown or author-owned runtime field at every nesting level.
  - Agent and execute node forms are mutually exclusive; split `title` from instructions; allow instructions to be absent, otherwise require exactly one bounded `instructions.inline` or `instructions.file`, with file instructions valid only when a saved package context will resolve them.
  - Validate unique bounded names, node/input/output/inputRef identities, graph bounds, acyclicity, reachability, no fan-out, unique consumer slots, entry-only public inputs, one export for every terminal, exact inbound PREV targets, route-specific conditions, and complete zero/nonzero execute coverage.
  - Allow an agent node to omit `outcome` for implicit NEXT. Require `requireExplicitDisposition` whenever an agent outcome is present, require a declared NEXT route when it is false, and require every execute node to provide complete exit routing now that `onFailure` is removed.
  - Normalize object member order while preserving semantically observable array order; include semantic interfaces, instruction/script digests, normalized outcomes, resolved profiles, and effective policy in canonical identity/fingerprint.
  - Replace public `define_workflow` with mutually exclusive inline-manifest or `predefinedWorkflowRef` forms; replace `start_workflow` input coordinates with public input names and literal or `(fromRun, output)` sources; replace `invoke_child_workflow` destination `{toNode,input}` coordinates with `{name,fromInput}` so the child input name is public and the parent source remains the current activation's inputRef.
  - Replace version-suffixed public/domain types with canonical names and delete removed aliases/parsing branches rather than introducing a second model or compatibility decoder.
- Tests first:
  - Rewrite `src/task/workflow.test.ts` fixtures to assert complete valid canonical graphs with omitted agent outcome, explicit optional/required agent outcomes, and execute outcomes; add failures for unknown root/nested fields, duplicate semantic names, invalid entry/output nodes, unexported/duplicate terminal outputs, illegal PREV targets, missing feedback marker/boolean/NEXT route, agent/exit outcome mismatch, incomplete exit coverage, instruction XOR violations, cycles/fan-out, and over-bound strings/arrays.
  - Rewrite `src/task/coordinator-tools.test.ts` and `src/bridge/server.test.ts` to prove the two closed define forms, public named start inputs, prior-run output selection, child `{name,fromInput}` bindings, opaque refs/results, and rejection of `label`, edge `as`, top-level or child entry coordinates (`toNode`, destination `input`), `onFailure`, IDs, policy, backend/model/role/capabilities, artifact fields, and mixed inline/ref requests.
  - Extend `src/task/brief.test.ts` and `src/task/workflow-shell-materialization.test.ts` to prove instruction-less nodes are valid, frozen instructions—not `title`—become the bounded workflow instruction section for initial/entry and dependency-gate activations, and title remains display metadata only.
  - Add fingerprint tests showing object-key reordering is stable while output name, semantic kind, array order, normalized outcome text, and frozen asset digest changes conflict.
- Anti-shortcut coverage:
  - Use two multi-entry/multi-sink manifests with reordered object members and distinct output selections so a parser that aliases removed fields, sorts semantic arrays indiscriminately, exports only the first sink, ignores nested unknown fields, or fingerprints only topology fails.
- Implementation obligations:
  - Refactor the existing types/codecs and all compile-time callers to canonical semantic/frozen types in their current ownership modules; do not add `WorkflowDefinitionV2`-style parallel domain families, `any`, permissive records, adapters, or dual-schema fallback.
  - Keep semantic parsing separate from host resolution: parsing proves closed author intent, while later phases freeze package bytes/task profiles/effective policy before persistence.
  - Refactor `workflowNodeTaskGoal`, task-shell materialization, and `src/task/brief.ts` prompt compilation so the run goal remains the task objective, optional frozen instruction bytes are injected as bounded executable task content for normal activations, and `title` is never reused as agent instruction text.
  - Update validation errors and MCP descriptions to be bounded, actionable, and free of host paths/internal IDs.
  - Preserve opaque public references and internal result projection behavior while changing only the accepted definition/start semantics.
- Acceptance criteria:
  - [x] AC-1: Every valid canonical manifest class described above normalizes deterministically and every invalid/unknown-field class fails before repository mutation - proven by `src/task/workflow.test.ts`.
  - [x] AC-2: MCP define/start/child-invoke advertise and accept only canonical semantic fields and reject all removed/internal destination fields - proven by `src/bridge/server.test.ts` and `src/task/coordinator-tools.test.ts`.
  - [x] AC-3: Definition fingerprints change for every persisted semantic difference but not object-member order - proven by fingerprint tests in `src/task/workflow.test.ts`.
  - [x] AC-4: Optional frozen instructions drive normal activation prompts while title affects display only - proven by `src/task/brief.test.ts` and `src/task/workflow-shell-materialization.test.ts`.
- Focused verification:
  - `npx vitest run src/task/workflow.test.ts src/task/coordinator-tools.test.ts src/bridge/server.test.ts src/task/brief.test.ts src/task/workflow-shell-materialization.test.ts`
- Phase gates:
  - `npx tsc -p . --noEmit && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `refactor(workflow-definition): adopt canonical manifest contract`

## Phase 2: Make workflow.json the Package Authority
- Status: complete
- Depends on: Phase 1
- Goal: Discover saved workflows only as canonical `workflow.json` bundles and freeze every referenced instruction/script asset before definition persistence.
- Current behavior: `src/host/predefined-workflows.ts` scans flat Markdown and Markdown-entry bundles under global/workspace canonical and singular fallback roots, derives package refs/digests, and freezes script provenance; Markdown body/frontmatter remains the saved workflow source.
- Code evidence: `src/host/predefined-workflows.ts:scanScope/readBundleFiles/packageDigest/listPredefinedWorkflows/resolvePredefinedWorkflowSource/getPredefinedWorkflow/resolvePredefinedWorkflowScript`; `src/task/engine-graph.ts:bindPredefinedWorkflowScripts`; `src/host/predefined-workflows.test.ts`; `src/host/workflow-catalog-cache.ts`; `src/host/workflow-catalog-route.ts`; `src/shared/workflow-catalog-wire.ts`; `src/host/script-workflow-uat-fixture.ts`.
- Pattern to follow: Preserve the current canonical containment, symlink/traversal rejection, workspace-over-global precedence, byte-wise package digest, stale opaque-ref rejection, and package-root script integrity pattern in `predefined-workflows.ts`.
- Behavioral contract:
  - Discover a direct child directory as a saved workflow only when it has one regular authoritative `workflow.json`; reject flat manifests, Markdown entries, ambiguous manifests, unsafe names, symlinks, traversal, over-count, over-depth, and over-byte packages with bounded diagnostics.
  - Parse manifest metadata for catalog listing but load/freeze the complete canonical manifest only when defining; `predefinedWorkflowRef` alone identifies the package and the coordinator never reconstructs its graph.
  - Resolve each `instructions.file` and script file relative to the frozen package root, verify type/extension/containment/size, record exact bytes and digests, and reject a changed package/ref before any definition rows are written.
  - Inline manifests may use only inline instructions; saved packages may use inline or file instructions. Runtime activation uses persisted frozen content/provenance and never rereads mutable prompt Markdown.
  - Keep the existing global/workspace catalog scopes and precedence, but remove legacy singular-root, flat Markdown, and Markdown-topology fallback behavior. Do not add a builtin scope or ship a package.
- Tests first:
  - Rewrite `src/host/predefined-workflows.test.ts` around valid global/workspace `workflow.json` bundles, workspace shadowing, deterministic refs, stale manifest/prompt/script refs, missing/duplicate/invalid manifests, malformed canonical JSON, unsafe asset paths, symlinks, size/count/depth bounds, and canonical-root-only discovery.
  - Update catalog cache/route/wire tests to prove valid canonical bundles remain bounded/path-free and removed Markdown forms are diagnostics or absent rather than silently compiled.
  - Update `src/host/script-workflow-uat-fixture.ts` and package tests so a saved execute workflow resolves from its package root after process CWD changes and changed script/prompt bytes fail before execution/definition replay.
- Anti-shortcut coverage:
  - Use two packages with identical manifest text but different referenced prompt bytes, plus a post-definition prompt mutation and symlink swap, to reject implementations that digest only `workflow.json`, defer prompt reads until activation, or trust lexical containment.
- Implementation obligations:
  - Refactor catalog source/result types to represent canonical manifest bundles without leaking filesystem paths; preserve bounded diagnostics and opaque refs.
  - Freeze instruction content, content digest, relative reference, package digest/root provenance, and script provenance into the resolved definition passed to Phase 3.
  - Remove Markdown/frontmatter topology compilation and legacy fallback code/tests/docs; retain Markdown parsing libraries only where used by unrelated product surfaces.
  - Keep catalog read-only: it discovers/describes packages but does not execute, persist, or expose prompt bodies.
- Acceptance criteria:
  - [x] AC-1: Only safe canonical `workflow.json` bundles are listed/resolved from existing global/workspace roots - proven by `src/host/predefined-workflows.test.ts` and catalog route/wire tests.
  - [x] AC-2: Referenced prompt and script bytes are bounded, integrity-checked, fingerprinted, and frozen before definition persistence - proven by package mutation/CWD/symlink tests.
  - [x] AC-3: Flat/legacy Markdown workflows are no longer compiled or advertised - proven by explicit negative catalog and coordinator tests.
- Focused verification:
  - `npx vitest run src/host/predefined-workflows.test.ts src/host/workflow-catalog-cache.test.ts src/host/workflow-catalog-route.test.ts src/shared/workflow-catalog-wire.test.ts src/task/coordinator-tools.test.ts src/task/script-workflow.test.ts`
- Phase gates:
  - `npm run compile && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow-packages): make workflow json authoritative`

## Phase 3: Persist Frozen Canonical Definitions and Interfaces
- Status: complete
- Depends on: Phase 1, Phase 2
- Goal: Refactor the reset-only SQLite store and repository reload path to be authoritative for the one normalized canonical definition, semantic interfaces, frozen assets, and outcomes.
- Current behavior: Schema version 7 persists one normalized canonical definition through ordered input, output, node, and edge authority rows plus activation-owned decision-repair rows; `defineWorkflowVersion` writes these atomically and `getWorkflowDefinition`/`startWorkflowRun` reconstruct and fingerprint-check the frozen relational authority. Existing stores with another marker fail closed and reset rebuilds only the current schema.
- Code evidence: `src/task/sqlite/schema.ts:SQLITE_SCHEMA_VERSION/REQUIRED_WORKFLOW_TABLES/WORKFLOW_SCHEMA_STATEMENTS/CURRENT_SCHEMA_STATEMENTS`; `src/task/sqlite/connection.ts:tryOpenExistingCurrent/openStoreDatabase`; `src/task/sqlite/reset.ts:bootstrapCurrentSchema`; `src/task/sqlite/schema-fingerprint.ts:findSchemaFingerprintFailure`; `src/task/repository.ts:defineWorkflowVersion/getWorkflowDefinition/getLatestWorkflowDefinition/startWorkflowRun`; tests in `src/task/repository.test.ts`, `src/task/sqlite/schema-fingerprint.test.ts`, `src/task/sqlite/connection.test.ts`, `src/task/sqlite/reset.test.ts`, and `src/task/m024-s06-schema-evidence.test.ts`.
- Pattern to follow: The current definition transaction writes an immutable definition plus relational authority rows under one operation/fingerprint claim, and every reload re-decodes/revalidates/fingerprint-checks stored data before use.
- Behavioral contract:
  - Bump the clean-break schema marker from 6 to 7; schema-6 stores fail with the existing incompatible-schema/reset path and are never migrated or interpreted as canonical definitions.
  - Replace the current entry-contract authority with ordered canonical input rows containing public name, semantic kind, entry node, inputRef, and transport kind; add authoritative ordered output rows containing public name, semantic kind, terminal node, and transport kind.
  - Persist each node's title, frozen instruction kind/content/digest, normalized agent/exit outcome, resolved task profile or script provenance, plus ordered canonical edges and the normalized definition used for fingerprint verification.
  - Add the target activation-owned `workflow_decision_repairs` authority keyed by `(run_id, activation_id)` with closed status, bounded attempt count, last attempt/error/response references, and next repair-turn reference so the schema cutover happens once; Phase 5 supplies its transitions and runtime behavior.
  - `defineWorkflowVersion` validates fully before SQL, writes the definition and all relational rows in one transaction, replays an identical operation read-only, conflicts on semantic/frozen-byte differences, and leaves zero rows on failure.
  - `getWorkflowDefinition`, latest-version resolution, start preparation, inspection, and reload reconstruct the one frozen canonical definition from durable authority, revalidate cross-row invariants, and fail closed on corruption or fingerprint mismatch.
- Tests first:
  - Extend schema/fingerprint/reset/connection tests for marker 7, exact input/output/node and decision-repair columns, foreign keys, indexes, immutable-authority triggers, schema-6 refusal, explicit reset success, and no migration statements.
  - Rewrite repository definition tests for multi-input/multi-output canonical persistence, package instruction/outcome round-trip, exact ordering, replay/conflict, rollback on any invalid row, and corruption detection on each authority table/canonical field.
  - Add reload tests that close/reopen the repository and recover the same canonical fingerprint, frozen prompt bytes, semantic interfaces, outcome contracts, and resolved execution provenance without consulting package files; execute queued entry and dependency activations after package mutation/reload and assert prompt compilation uses the frozen instruction body rather than title or current disk bytes.
- Anti-shortcut coverage:
  - Mutate one normalized output row, one outcome, and one frozen prompt digest independently after insertion and assert reload fails; this rejects topology-JSON-only reloads, unverified side tables, and runtime package rereads.
- Implementation obligations:
  - Refactor the existing repository row codecs and named worker commands directly for the canonical model; do not add parallel repositories, generic mutation callbacks, or host pre-read/write sequences.
  - Add all new tables/columns to required inventories, golden schema manifests, privacy/diagnostic allowlists, reset verification, reclamation ownership, and immutable-update/delete guards where existing definition authority uses them.
  - Remove superseded table/column codecs and branches rather than carrying dead schema authority.
  - Ensure stored instruction bodies are available only to prompt compilation/execution paths and never enter status, diagnostics, catalog, or graph projections.
  - Hydrate frozen instructions through the real engine execution/brief path for initial, dependency, feedback-resume, child-return, retry, and fresh-session reconstruction contexts; never substitute mutable package reads or display title.
- Acceptance criteria:
  - [x] AC-1: Schema 7 fresh-open/reset produces exactly the canonical authority schema while schema 6 fails closed without migration - proven by SQLite connection/reset/fingerprint tests.
  - [x] AC-2: Define replay/conflict/rollback and reopen reconstruct the complete frozen canonical definition exactly - proven by `src/task/repository.test.ts` and reload tests.
  - [x] AC-3: Corrupt or mismatched canonical authority rows cannot be executed or silently normalized - proven by row-mutation corruption tests.
  - [x] AC-4: Reopened activations execute with the persisted frozen instruction body, while title and mutated package bytes cannot alter the prompt - proven by repository reload plus brief/execution tests.
- Focused verification:
  - `npx vitest run src/task/repository.test.ts src/task/sqlite/schema-fingerprint.test.ts src/task/sqlite/connection.test.ts src/task/sqlite/reset.test.ts src/task/m024-s06-schema-evidence.test.ts src/task/sqlite/privacy-redaction.test.ts`
- Phase gates:
  - `npm run compile && npm run test:sqlite-storage-docs && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `refactor(workflow-storage): persist canonical definitions`

## Phase 4: Resolve Named Workflow Outputs Atomically
- Status: complete
- Depends on: Phase 3
- Goal: Start workflows through public named inputs and compose prior runs from the exact declared named terminal artifact with durable kind, retention, and idempotency guarantees.
- Current behavior: `parseSemanticWorkflowInputs` and `validateStartWorkflow` bind `(entryNodeId,inputRef)` values; `startWorkflowRun` can adapt a prior succeeded run's run-level terminal result/aggregate, but no frozen named output selects one terminal artifact or participates in the start fingerprint. Nested invocation separately parses `{toNode,input,fromInput}` and carries `childEntryNodeId/inputRef` through `InvokeChildEntryBinding` into child start/continuation paths.
- Code evidence: `src/task/coordinator-tools.ts:parseSemanticWorkflowInputs` and the `invoke_child_workflow` parser; `src/task/workflow.ts:validateStartWorkflow/deriveStartIdentities`; `src/task/workflow-types.ts:InvokeChildEntryBinding/InvokeChildWorkflowInput`; `src/task/repository.ts:startWorkflowRun/resolveWorkflowInputArtifacts/getWorkflowRunCompletion` and child invocation planners; `src/task/m018-s06-child-workflow-continuation.test.ts`; `src/task/m024-s02-entry-input-artifact-reuse.test.ts`; `src/task/m024-s02-entry-reuse-durable.test.ts`; `src/task/m024-s03-fan-in-reuse-durable.test.ts`; `src/task/m024-s03-mid-tree-node-reuse.test.ts`; `src/task/m024-s03-mid-tree-reuse-durable.test.ts`; `src/task/workflow-metadata-reclamation.test.ts`.
- Pattern to follow: Extend the existing atomic `startWorkflowRun` prior-artifact adaptation, provenance pinning, gate fill, operation claim, and retention/reclamation behavior; do not add host-side output resolution.
- Behavioral contract:
  - Resolve each public start input name against the selected definition's frozen input contract; require exact coverage once, reject unknown/duplicate/missing names, and derive internal entry bindings only inside the trusted host/repository path.
  - Carry each nested child binding's public child input `name` plus the parent activation's `fromInput` artifact into the child-start repository command. In the child invocation transaction, resolve the name from the frozen child definition, enforce exact child-input coverage and current-activation source/provenance authority, adapt the forwarded value to the declared child input semantic kind, derive child entry coordinates, include the public name in idempotency material, and create the child run/return gate/continuation atomically. Do not declare or infer semantic kinds for internal parent edges.
  - Literal values receive the destination semantic kind and existing bounded `workflow_input` adaptation.
  - Prior values carry `(fromRun, outputName)` unchanged into the repository command/fingerprint. In the start transaction, authorize a succeeded source run, load its frozen output by name, locate that output terminal's exact immutable `next_result` artifact/revision, compare semantic kinds exactly, pin provenance, adapt, fill the destination gate, and create the new run atomically.
  - Multi-sink run-level aggregate completion remains available for existing run completion/continuation semantics but is never used as authority for named composition.
  - Same operation plus same exact named sources replays read-only; changing only output name conflicts. Failure, source closure races, reclamation races, missing artifact/revision, kind mismatch, or unauthorized source creates no partial run/gate/fill/pin records.
- Tests first:
  - Rewrite the M024 entry/reuse suites to start by public names and select each output of a two-terminal source run, proving distinct exact artifact/revision/provenance and downstream value.
  - Add unknown/duplicate/missing destination name, unknown output, wrong source status/scope, semantic-kind mismatch, legacy aggregate confusion, changed-output fingerprint conflict, source retention/reclamation race, concurrent same-start replay, and rollback assertions.
  - Extend canonical workflow/reload tests to compose a named output after process reload and after terminal nodes complete in different orders; separately prove that any failed source run is rejected atomically.
  - Rewrite `src/task/m018-s06-child-workflow-continuation.test.ts` to invoke children only by public child input name and cover exact coverage, duplicate/unknown names, foreign/missing `fromInput`, exact parent artifact provenance/value adaptation, operation fingerprint conflict, concurrent replay, reload before child return, and rejection of all child destination coordinates; assert no internal-edge semantic-kind requirement is introduced.
- Anti-shortcut coverage:
  - Give the multi-sink aggregate and both terminal artifacts deliberately different values and complete terminals in reversed order; assert each output name resolves its declared terminal, rejecting first/last-terminal and aggregate shortcuts.
- Implementation obligations:
  - Include public input name, source run ref identity, and output name in canonical start identity/fingerprint without exposing internal coordinates publicly.
  - Query and validate the source frozen definition/output contract in the same SQLite transaction that creates the consumer run and pins/fills its entry gate.
  - Resolve child public input names against the frozen child definition in the same repository transaction that creates the child run and continuation; validate the parent source against the live activation's pinned `fromInput`, then adapt that value to the child contract. No host-side lookup, internal coordinate, or invented internal-edge semantic kind may become public/idempotency authority.
  - Extend artifact source/provenance and reclamation/reference accounting so selected outputs cannot be reclaimed while referenced and failed starts do not leak pins.
  - Preserve deterministic gate/activation/task/message/turn identities and post-commit-only scheduling.
- Acceptance criteria:
  - [x] AC-1: Literal and prior-run starts bind only by public input name and exact semantic kind - proven by rewritten M024 entry tests.
  - [x] AC-2: Every named output of a multi-sink run resolves its exact declared terminal artifact, never the aggregate or completion order - proven by multi-sink durable/reload tests.
  - [x] AC-3: Output selection is atomic, retained, replay-safe, and fingerprint-distinct with zero partial rows on every failure/race - proven by repository/reclamation/concurrency tests.
  - [x] AC-4: Nested child invocation uses only public child input names and preserves atomic child-run/continuation/reload behavior - proven by `src/task/m018-s06-child-workflow-continuation.test.ts` and bridge/parser tests.
- Focused verification:
  - `npx vitest run src/task/m018-s06-child-workflow-continuation.test.ts src/task/m024-s02-entry-input-artifact-reuse.test.ts src/task/m024-s02-entry-reuse-durable.test.ts src/task/m024-s03-fan-in-reuse-durable.test.ts src/task/m024-s03-mid-tree-node-reuse.test.ts src/task/m024-s03-mid-tree-reuse-durable.test.ts src/task/workflow-metadata-reclamation.test.ts src/task/m018-s07-canonical-workflow.test.ts src/task/coordinator-tools.test.ts src/bridge/server.test.ts`
- Phase gates:
  - `npm run compile && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow-runtime): compose exact named outputs`

## Phase 5: Enforce Agent Outcomes with Durable Decision Repair
- Status: pending
- Depends on: Phase 3, Phase 4
- Goal: Render and enforce each agent node's declared NEXT/PREV/FAIL contract and repair missing or invalid decisions durably for at most three attempts per activation.
- Current behavior: `capabilitiesFor` exposes workflow disposition tools by activation context, `executeToolCommand` stages a durable claim, and `settleTurnAndApplyEffects` applies existing route planners. If a successful agent turn has no staged disposition, `engine.ts:settleSuccess` injects implicit NEXT immediately. No outcome-contract authorization or activation-owned decision-attempt state exists.
- Code evidence: `src/bridge/server.ts` disposition schemas; `src/task/coordinator-tools.ts` workflow disposition parsing; `src/task/capabilities.ts:capabilitiesFor`; `src/task/host-context.ts` workflow rules; `src/task/brief.ts` prompt compiler/correction patterns; `src/task/engine-graph.ts:executeToolCommand`; `src/task/engine.ts:executeTurn/settleSuccess`; `src/task/disposition-claim.ts`; `src/task/repository.ts:workflowDispositionAuthorizationPredicate/settleTurnAndApplyEffects/planWorkflowPrevRequest/recoverWorkflowActivation`; `src/bridge/server.test.ts`; `src/task/coordinator-tools.test.ts`; `src/task/m018-s08-disposition-claims.test.ts`; `src/task/m018-s04-prev-feedback-all-join.test.ts`; `src/task/fresh-session-recovery-prompt.test.ts`; `src/task/engine-terminal-quiesce.test.ts`; `src/task/engine-stream-persist.test.ts`; `src/task/limits.test.ts`.
- Pattern to follow: Combine contextual capability projection with repository execution-time authorization and the universal durable disposition-claim CAS; model repair as deterministic persisted continuation turns like `recoverWorkflowActivation`, not an in-memory retry loop or PREV round.
- Behavioral contract:
  - Render route-specific untrusted `when` text and exact allowed targets as a bounded host-owned outcome-contract section; never treat condition prose as host policy or expose raw manifest/topology.
  - Before staging a claim, authorize that the disposition is declared for the current activation, PREV target set matches one declared route using only unique direct inbound inputRefs, and feedback is trimmed, nonempty, and within the existing bound.
  - For an authenticated live workflow-disposition call whose payload proves an attempted route but fails bounded parsing/contract checks (including empty/whitespace/oversized PREV feedback or malformed/undeclared targets), route a closed internal invalid-attempt command through the normal handler and persist bounded error evidence on that activation's repair row. Malformed unauthenticated/non-workflow calls remain ordinary tool errors and cannot mutate repair state.
  - For `requireExplicitDisposition: false`, commit any valid explicit route. Preserve final-assistant-message implicit NEXT only when the original attempt has no route attempt, no durable invalid evidence, and no open repair record. If an invalid route was attempted, bypass implicit NEXT and enter repair; from then on, a missing correction disposition consumes the next decision attempt instead of restoring implicit NEXT.
  - For `true`, no claim enters repair. The original completed turn is attempt 1; attempts 1-2 with durable missing/invalid evidence settle that attempt, persist bounded response/error evidence, reserve exactly one deterministic correction message/turn on the same task/activation, and leave the activation open. Attempt 3 atomically exhausts/consumes the activation and fails the run with bounded `decision_missing` or `decision_invalid`.
  - Persist one repair row per activation with status, attempts used, last attempt/error/response, and next turn. Deterministic IDs/fences make replay, crash, reload, and concurrent settlement no-ops after the first transition; an accepted valid claim marks decided and always wins over later calls/repair classification.
  - Prefer the committed backend session for correction; when session load fails, reconstruct a fresh session from frozen node instructions, pinned activation inputs, bounded prior response, exact error, contract, and attempt number.
  - Every attempt consumes existing task/run turn and deadline budgets; reserve before queueing and use the existing bounded budget-failure path if another attempt cannot be admitted. New dependency/feedback/child-return activations start independent attempt-1 records.
- Tests first:
  - Extend disposition-claim tests for valid-vs-invalid concurrency, two simultaneous valid calls, invalid call followed by valid call, settlement replay, and proof that only the first accepted valid claim decides the activation.
  - Add engine/repository assembled cases for clean original optional implicit NEXT, optional invalid attempt 1 followed by missing attempts 2 and 3 with no implicit NEXT, optional valid second/third repair decisions, strict missing repair on attempts 1/2, third missing/invalid exhaustion, undeclared action, foreign/undeclared PREV target sets, empty/whitespace/oversized feedback, and entry-node PREV rejection.
  - Add bridge-to-coordinator-to-repository tests that submit empty, whitespace-only, oversized, malformed-target, and undeclared disposition calls through the real MCP tool boundary, prove one bounded durable invalid-attempt record is associated with the live turn/activation, and prove `requireExplicitDisposition: false` enters repair instead of falling through to implicit NEXT.
  - Add crash/reopen at each transition boundary, duplicate scheduling, stale repair turn, feedback-resume activation independence, budget/deadline exhaustion, same-session resume, forced session-load failure, and fresh-session context-equivalence cases.
  - Extend host-context/brief tests to assert exact bounded rendering and no prompt/path/internal-state leakage.
- Anti-shortcut coverage:
  - Race an invalid call, a valid declared call, turn completion, reload, and duplicate settlement for one activation; assert one decided route, no repair turn, no implicit NEXT override, and no duplicate artifact/gate effect. Separately reload after attempt 2 and force session-load failure to prove repair is durable rather than memory/session-dependent.
- Implementation obligations:
  - Use the Phase 3 activation-owned repair table and add its repository command types, atomic transitions, cleanup/reclamation, status reads, and recursive run closure handling; do not create another repair store or model attempts only on `TaskTurn`/task-wide counters.
  - Refactor the bridge/coordinator parse result and engine command union so an authenticated known disposition attempt can carry only a closed error code and bounded metadata to a named repository command before claim staging; do not persist raw invalid payloads and do not let an invalid call occupy the universal disposition claim.
  - Coalesce multiple invalid calls in one completed agent turn into that turn's single decision attempt; if a valid claim is later accepted, mark decided and make all prior invalid evidence non-authoritative. At turn completion, durable invalid evidence classifies `decision_invalid`, while no attempted route classifies `decision_missing`.
  - Gate implicit-NEXT injection on both attempt number and durable repair status: only attempt 1 with no invalid evidence/open repair is eligible. Every queued correction turn is disposition-required for the remainder of that activation regardless of the original boolean.
  - Add a dedicated atomic attempt-settlement transition that chooses exactly valid route, repair, or exhaustion under turn/runtime/activation/claim fences; bypass current implicit-NEXT injection only for eligible invalid/missing attempts.
  - Reuse existing PREV feedback planners unchanged after authorization; decision repair must not create feedback rounds, producer turns, hidden nodes, or graph cycles.
  - Schedule correction execution only after commit and preserve current task/session FIFO, runtime ownership, cancellation, terminal quiescence, and recursive closure invariants.
- Acceptance criteria:
  - [ ] AC-1: Declared outcomes are rendered and authorized exactly, with only direct declared PREV targets and bounded nonempty feedback accepted - proven by host-context, engine-tool, and PREV tests.
  - [ ] AC-2: Optional implicit NEXT occurs only on an original clean attempt; after any invalid attempt, missing/invalid correction turns advance the same maximum-three-attempt repair to a valid route or exhaustion - proven by engine/repository repair tests.
  - [ ] AC-3: Valid-first-wins, replay/reload, session reconstruction, budgets, and exhaustion are atomic and duplicate-free - proven by disposition race, reload, recovery, limits, and terminal-quiesce tests.
  - [ ] AC-4: Parser-rejected authenticated route attempts are durable `decision_invalid` evidence and can never trigger optional implicit NEXT - proven by bridge-to-repository tests.
- Focused verification:
  - `npx vitest run src/bridge/server.test.ts src/task/coordinator-tools.test.ts src/task/m018-s08-disposition-claims.test.ts src/task/m018-s04-prev-feedback-all-join.test.ts src/task/m018-s01-one-node-workflow.test.ts src/task/m018-s07-canonical-workflow.test.ts src/task/fresh-session-recovery-prompt.test.ts src/task/engine-terminal-quiesce.test.ts src/task/engine-stream-persist.test.ts src/task/limits.test.ts`
- Phase gates:
  - `npm run compile && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow-routing): add durable decision repair`

## Phase 6: Route Execute Outcomes by Numeric Exit
- Status: pending
- Depends on: Phase 5
- Goal: Replace script `onFailure` with complete canonical zero/nonzero outcome contracts that stage existing NEXT/PREV/FAIL dispositions without weakening execution safety.
- Current behavior: `ScriptBackend` safely executes one bounded script and records numeric exit/stdout/stderr; `engine.ts` maps exit 0 or `onFailure: continue` to NEXT and nonzero `fail_run` to FAIL. Nonzero cannot request contextual PREV.
- Code evidence: `src/backends/script.ts:ScriptBackend`; `src/backends/script.test.ts`; `src/task/types.ts:ScriptOnFailure/script execution result`; `src/task/engine.ts` script `processCompleted/turnCompleted` handling and disposition staging; `src/task/engine-graph.ts:bindPredefinedWorkflowScripts`; `src/task/script-workflow.test.ts`.
- Pattern to follow: Preserve the typed no-shell executor, package-root/integrity verification, bounded stdout/stderr, turn-local `executionResult`, and existing post-execution disposition staging; replace only the policy mapper.
- Behavioral contract:
  - Every execute node declares one closed `outcome.kind: exit` contract with complete mutually exclusive zero and nonzero coverage: zero maps to NEXT; nonzero maps to exactly PREV with declared direct inbound targets/`feedback: stdout`, or FAIL.
  - Execute each activation once under the existing engine retry model. NEXT uses bounded stdout as result. Nonzero PREV uses bounded stdout as feedback; empty stdout receives deterministic bounded host feedback identifying the failed check/title and exit code. FAIL uses the existing bounded run-closure reason.
  - Stderr remains diagnostic-only and never becomes artifact/result/feedback. Spawn, timeout, cancellation, integrity, missing exit status, and output-bound failures stay operational failures governed by existing retry/safety logic, regardless of the outcome contract.
  - Remove `ScriptOnFailure`, `onFailure`, and all legacy continue/fail mapping from public types, package fixtures, engine branches, docs, and tests.
- Tests first:
  - Rewrite `src/backends/script.test.ts`/`src/task/script-workflow.test.ts` for zero NEXT, nonzero PREV with stdout, nonzero PREV with synthesized empty-output feedback, nonzero FAIL, downstream gate contribution, feedback ALL-join/resume, reload, and exactly-once route settlement.
  - Add negative cases for incomplete/overlapping outcome coverage, PREV on entry execute node, undeclared/non-inbound targets, stderr-only output, spawn failure, timeout, cancellation, digest mismatch, missing exit status, and stdout/stderr bounds.
  - Update package/UAT fixtures to run canonical execute manifests after CWD changes and verify no `onFailure` field is accepted.
- Anti-shortcut coverage:
  - Use the same nonzero code in two manifests, one mapping PREV and one FAIL, with empty stdout and nonempty stderr; assert different declared routes, synthesized PREV feedback, diagnostic-only stderr, and no generic “all nonzero fail/continue” shortcut.
- Implementation obligations:
  - Add a pure normalized exit-result-to-disposition mapper and invoke it only after a successful numeric process completion; route through the same authorization/claim/settlement path as agent decisions.
  - Resolve PREV producers from frozen inputRef bindings and preserve existing feedback round/artifact revision behavior; execute nodes do not receive or choose hidden graph destinations.
  - Keep operational error/retry/cancellation classification separate from semantic exit routing and preserve exact execution metadata for diagnostics/reload.
  - Delete legacy types/branches and update all test/UAT callers in the same phase so no production fallback survives.
- Acceptance criteria:
  - [ ] AC-1: Exit 0 always produces one NEXT result and numeric nonzero follows exactly the manifest's PREV or FAIL route - proven by backend and script workflow tests.
  - [ ] AC-2: Nonzero PREV always reaches only declared direct producers with actionable bounded feedback, including deterministic synthesis for empty stdout - proven by feedback integration tests.
  - [ ] AC-3: Operational failures and stderr remain separate from semantic routes, and no `onFailure` compatibility remains - proven by negative executor/package/public-contract tests and source inspection.
- Focused verification:
  - `npx vitest run src/backends/script.test.ts src/task/script-workflow.test.ts src/host/predefined-workflows.test.ts src/task/coordinator-tools.test.ts src/task/m018-s04-prev-feedback-all-join.test.ts`
- Phase gates:
  - `npm run test:script-workflow-qa && npm run compile && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `feat(workflow-execute): map exit outcomes to dispositions`

## Phase 7: Surface Canonical State and Complete the Refactor
- Status: pending
- Depends on: Phase 2, Phase 3, Phase 4, Phase 5, Phase 6
- Goal: Make repair/correction/decision state truthful and bounded in status/graph UI, update all user and storage contracts, and prove the complete canonical package-to-composition journey.
- Current behavior: Status/graph projections already expose runs, node execution axes, dependency gates, feedback rounds, continuations, blockers, and progress. They cannot expose nonexistent decision-repair attempts or decision-gate markers. Catalog/docs/UAT still describe superseded Markdown semantics and schema documentation is behind the source marker.
- Code evidence: `src/task/repository.ts:getWorkflowStatusForTask/getWorkflowGraphForTask/workflowGraphNodeProjection`; `src/task/workflow-types.ts:WorkflowTaskStatusProjection/WorkflowGraphProjection`; `src/shared/workflow-graph-wire.ts`; `src/host/workflow-graph.ts`; `src/host/workflow-graph-route.ts`; `webview/src/lib/workflow-graph-view.ts`; `webview/src/components/WorkflowGraphCanvas.svelte` and `WorkflowGraphModal.svelte`; `src/task/m018-s07-workflow-status-projection.test.ts`; `src/task/m024-s04-workflow-graph-projection.test.ts`; `docs/MUSTER-WORKFLOWS.md`; `docs/TASK-MANAGEMENT.md`; `docs/MUSTER-BRIDGE.md`; `docs/SQLITE-STORAGE.md`; script workflow QA/UAT files.
- Pattern to follow: Extend the existing bounded/redacted status and graph wire, preserving separate workflow status/execution activity/display state axes and the request-correlation/host-validation/webview-store architecture; do not create a second diagnostics path.
- Behavioral contract:
  - Normal PREV remains revision/waiting-for-feedback rather than failure. Missing/invalid required disposition shows bounded `Waiting for workflow decision` or `Correcting workflow route` with attempt N of 3; only exhaustion or semantic/operational closure shows Failed.
  - Graph nodes may expose a bounded decision-gate marker and repair summary, but no hidden node, prompt body, condition text, prior response, host path, physical ID, or artifact body. Existing dependency gate/input blocker and multi-node activity/progress behavior remains unchanged.
  - A node's optional bounded `title` is display metadata in status/graph/webview; instruction content never substitutes for the title and title never appears in the host-owned executable instruction section.
  - Catalog continues to list safe global/workspace bundle metadata only; it recognizes canonical packages but does not add a builtin scope or expose interfaces/prompts in this work.
  - Product/storage/bridge docs and native fixtures describe only the canonical contract, `workflow.json`, public named interfaces, outcome/repair semantics, execute routing, schema 7 reset requirement, and removal of Markdown topology/`onFailure` behavior.
  - One assembled journey defines a package with frozen file instructions, starts by literal named input, performs agent or execute PREV correction, survives reload/repair where applicable, finishes multiple named outputs, then starts a second workflow from a selected exact output; all refs/projections stay opaque and bounded.
- Tests first:
  - Extend status/graph repository, shared-wire, host-route, view/layout/store, and Playwright tests for bounded display title, repair attempts 1-3, waiting/correcting/failed transitions, decision-gate marker, simultaneous executing nodes, existing PREV waiting, terminal exhaustion, redaction, malformed/over-bound wire data, stale request correlation, and no hidden graph node.
  - Update workflow catalog panel/wire tests only as needed for canonical bundle metadata and removed Markdown fixtures; assert no scope/interface/prompt/path expansion.
  - Update native script workflow and workflow graph UAT fixtures/evidence verifiers for the assembled canonical journey and add documentation verification where existing scripts enforce shipped contracts.
- Anti-shortcut coverage:
  - Render a run containing an open feedback round, an activation on repair attempt 2, a completed upstream node, and another executing node simultaneously; assert each has the correct independent UI state, node count is unchanged, and serialized payload contains none of the seeded prompt/path/response secrets.
- Implementation obligations:
  - Derive repair display state from durable repository rows, not transient engine memory or text matching; preserve revision/change-feed updates so reload and focused graph refresh converge.
  - Extend wire parsers with closed bounded fields and update host/webview mapping exhaustively; reject malformed values rather than accepting partial unsafe projections.
  - Keep catalog interface details deferred as specified; avoid unrelated workflow authoring UI or bundled-package work.
  - Remove stale versioned-model examples, compatibility claims, Markdown compilation instructions, `onFailure`, and old schema-version text from current product docs/QA while retaining historical plan artifacts unchanged.
  - Run the complete regression matrix and fix production behavior, tests, source-boundary fixtures, and evidence scripts together; do not weaken assertions or skip expensive gates.
- Acceptance criteria:
  - [ ] AC-1: Status/graph/webview truthfully distinguish PREV correction, decision repair attempt N of 3, execution, completion, and final failure without hidden nodes or sensitive leakage - proven by projection/wire/view/Playwright tests.
  - [ ] AC-2: Catalog, public docs, storage docs, QA/UAT, and current examples describe only the canonical workflow contract and schema 7 reset behavior - proven by catalog/doc/evidence tests and source inspection.
  - [ ] AC-3: The assembled package -> named input -> correction/repair -> named terminal output -> downstream composition journey passes across reload with opaque bounded projections - proven by canonical workflow, package, graph, and native UAT tests.
  - [ ] AC-4: All repository-wide type, static, build, unit, source-boundary, and webview regression gates pass on final HEAD - proven by the Global Gates.
- Focused verification:
  - `npx vitest run src/task/m018-s07-workflow-status-projection.test.ts src/task/m024-s04-workflow-graph-projection.test.ts src/host/workflow-graph.test.ts src/host/workflow-graph-route.test.ts src/shared/workflow-graph-wire.test.ts webview/src/lib/workflow-graph-view.test.ts webview/src/lib/workflow-graph-layout.test.ts src/task/workflow-graph-webview-wiring.test.ts src/host/workflow-catalog-route.test.ts src/shared/workflow-catalog-wire.test.ts`
- Phase gates:
  - `npm run test:m024-s05 && npm run test:m024-s06-gate && npm run test:script-workflow-acceptance && npm run test:sqlite-storage-docs && npx tsc -p . --noEmit && npm run check:svelte && npm run compile && npm test && npm run test:webview && npm run test:source-boundary && npm run test:source-boundary:fixtures`
- Review: run `codex-impl-review` against this phase and this plan; verdict must be APPROVE.
- Commit: `refactor(workflow): surface state and complete design cutover`

## Completion Criteria
- [ ] Every phase is complete and committed exactly once.
- [ ] Every acceptance criterion is checked.
- [ ] All global gates pass on final HEAD.
- [ ] Final `codex-impl-review` verdict is APPROVE for the complete plan range.
- [ ] Worktree is clean apart from pre-existing unrelated changes.

## Progress Log
| Phase | Status | Commit | Verification | Review |
|---|---|---|---|---|
| 1 | complete | this phase commit (`refactor(workflow-definition): adopt canonical manifest contract`) | Focused: 180/180; `npx tsc -p . --noEmit`; source-boundary + fixtures passed | `codex-impl-review` APPROVE in 3 rounds; 5 findings fixed |
| 2 | complete | this phase commit (`feat(workflow-packages): make workflow json authoritative`) | Focused: 164/164; script-workflow QA: 150/150; compile; source-boundary + fixtures passed; native VS Code 1.135.0 rerun remains truthfully pending after its UAT-only workspace setting update blocked before run creation | `codex-impl-review` APPROVE in 4 rounds; 9 findings fixed |
| 3 | complete | this phase commit (`refactor(workflow-storage): persist canonical definitions`) | Focused: 89/89; affected workflow/retry: 112/112; child-return integration: 1/1; `npx tsc -p . --noEmit`; `git diff --check`; compile; SQLite storage docs; source-boundary + fixtures passed | `codex-impl-review` APPROVE in 4 rounds; 5 findings fixed |
| 4 | complete | this phase commit (`feat(workflow-runtime): compose exact named outputs`) | Focused: 126/126; repository: 41/41; one-node workflow: 10/10; `npx tsc -p . --noEmit`; compile; source-boundary + fixtures passed | `codex-impl-review` APPROVE in 2 rounds; 1 finding fixed, 1 withdrawn after transaction-boundary evidence |
| 5 | pending | N/A | pending | pending |
| 6 | pending | N/A | pending | pending |
| 7 | pending | N/A | pending | pending |
